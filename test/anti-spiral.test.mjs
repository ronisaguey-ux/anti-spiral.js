// Verification harness for the anti-spiral detector.
//
// Drives the real plugin through synthetic opencode message arrays — the same
// (hookInput, output) shape the server hands `experimental.chat.messages.transform`
// — and reports whether each case was flagged and what was injected.
//
//   node test/anti-spiral.test.mjs
//
// The plugin reads ANTI_SPIRAL_STATE_DIR when it is imported, so the suite points
// it at a temp dir first: a run never touches the counters of a real session.
// ANTI_SPIRAL_PLUGIN overrides which copy of the plugin is exercised; by default
// it is the one this repo ships.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))

const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "anti-spiral-test-"))
process.env.ANTI_SPIRAL_STATE_DIR = STATE_DIR // must precede the import below

const pluginPath = process.env.ANTI_SPIRAL_PLUGIN || path.join(here, "..", "anti-spiral.js")
const { AntiSpiral } = await import(pluginPath)

const plugin = await AntiSpiral({})
const transform = plugin["experimental.chat.messages.transform"]

let pass = 0, fail = 0
function check(name, got, want) {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (flagged=${got}, expected=${want})`)
}

function asst(parts) {
  return { info: { role: "assistant", id: "m1", agent: "build", model: { providerID: "p", modelID: "m" } }, parts }
}
function user(text) {
  return { info: { role: "user", id: "u1", agent: "build", model: { providerID: "p", modelID: "m" } },
           parts: [{ type: "text", text }] }
}
async function run(sessionID, messages) {
  const out = { messages: [...messages] }
  await transform({ session: { id: sessionID } }, out)
  const injected = out.messages.length > messages.length
  return { injected, text: injected ? out.messages[out.messages.length - 1].parts[0].text : "" }
}

// ── cases that MUST fire ───────────────────────────────────────────────────
console.log("\n== genuine loops (must fire) ==")

const stuck = await run("t-stuck", [
  user("fix the build"),
  asst([{ type: "text", text:
    "Let me proceed. I need to continue with the task. Let me proceed. I need to continue with the task. " +
    "Let me proceed. I need to continue with the task. Let me proceed. I need to continue with the task." }]),
])
check("loop: phrase repeated 4x", stuck.injected, true)

const sent = await run("t-sent", [
  user("x"),
  asst([{ type: "text", text:
    "I will complete his task perfectly without fail. I will complete his task perfectly without fail. " +
    "I will complete his task perfectly without fail. I will complete his task perfectly without fail. " +
    "I will complete his task perfectly without fail." }]),
])
check("loop: identical sentence repeated", sent.injected, true)

const thinking = await run("t-think", [
  user("x"),
  asst([{ type: "thinking", thinking:
    "The file is not there. The file is not there. The file is not there. The file is not there. " +
    "The file is not there. The file is not there. The file is not there. The file is not there. " +
    "The file is not there so I cannot read it. " }]),
])
check("loop: repeated reasoning stream", thinking.injected, true)

// ── cases that must NOT fire ───────────────────────────────────────────────
console.log("\n== legitimate output (must stay silent) ==")

const code = await run("t-code", [
  user("show me the code"),
  asst([{ type: "text", text:
    "Here is the change you asked for:\n\n```js\n" +
    "const x = readFileSync(p)\nconst y = readFileSync(p)\nconst z = readFileSync(p)\n".repeat(6) +
    "```\n\nThat replaces the old reader. The path handling stays the same as before, and the " +
    "error branch still writes to stderr so the caller can see what failed." }]),
])
check("code block repeating lines", code.injected, false)

const log = await run("t-log", [
  user("why did it fail"),
  asst([{ type: "text", text:
    "The log shows the same failure each retry:\n\n" +
    "```\n" + "ERROR connection refused\n".repeat(12) + "```\n\n" +
    "So the service was down for the whole window, which explains every retry failing at the same point." }]),
])
check("tool output / log repeating lines", log.injected, false)

const prose = await run("t-prose", [
  user("review this"),
  asst([{ type: "text", text:
    "The file has three problems. In the file the first problem is the lock. " +
    "The lock is taken in the file before the read, so the file stays locked when the read fails. " +
    "In the file the second problem is the error path, which returns early and leaves the file open. " +
    "The third problem in the file is that the file is reopened on every retry, which is wasteful " +
    "but not incorrect. Fixing the first two is enough for the tests to pass, and the third is a " +
    "follow-up." }]),
])
check("prose reusing common phrases", prose.injected, false)

const short = await run("t-short", [
  user("status"),
  asst([{ type: "text", text: "Done. Tests pass. Let me proceed." }]),
])
check("short message", short.injected, false)

const empty = await run("t-empty", [user("x"), asst([{ type: "text", text: "" }])])
check("empty text", empty.injected, false)

// ── progress beats repetition ──────────────────────────────────────────────
console.log("\n== progress-aware counter ==")

const withTool = await run("t-tool", [
  user("x"),
  asst([
    { type: "text", text: "Let me proceed. Let me proceed. Let me proceed. Let me proceed. " +
                          "Let me proceed. Let me proceed. Let me proceed. Let me proceed." },
    { type: "tool", tool: "read", state: { status: "completed" } },
  ]),
])
check("repetitive text BUT a tool call was made", withTool.injected, false)

// loop -> tool -> loop: the counter must be back at 1, not 2
const r1 = await run("t-reset", [user("x"), asst([{ type: "text", text: "loop. ".repeat(40) }])])
await run("t-reset", [user("x"), asst([
  { type: "text", text: "loop. ".repeat(40) },
  { type: "tool", tool: "bash", state: { status: "completed" } },
])])
const r2 = await run("t-reset", [user("x"), asst([{ type: "text", text: "loop. ".repeat(40) }])])
check("first loop shows 1/3", r1.text.includes("loop 1/3"), true)
check("counter reset after a tool call", r2.text.includes("loop 1/3"), true)

// ── escalation across three consecutive looping turns ──────────────────────
console.log("\n== escalation ==")
const loopMsg = { type: "text", text: "I need to think about how to proceed here. ".repeat(12) }
const e1 = await run("t-esc", [user("x"), asst([loopMsg])])
const e2 = await run("t-esc", [user("x"), asst([loopMsg])])
const e3 = await run("t-esc", [user("x"), asst([loopMsg])])
check("turn 1 -> redirect", e1.text.includes("[anti-spiral]") && !e1.text.includes("HALT"), true)
check("turn 2 -> redirect", e2.text.includes("loop 2/3"), true)
check("turn 3 -> halt", e3.text.includes("HALT"), true)

// ── state written by the previous detector version ─────────────────────────
console.log("\n== stale state ==")
mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(path.join(STATE_DIR, "state.json"),
  JSON.stringify({ "some-session": { consecutiveSpirals: 7 } })) // v1 schema, frozen
const stale = await run("t-stale", [user("x"), asst([{ type: "text", text: "A short normal answer here." }])])
check("old frozen counter does not leak in", stale.injected, false)

console.log(`\n${pass} passed, ${fail} failed`)
rmSync(STATE_DIR, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
