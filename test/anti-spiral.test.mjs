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

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))

const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "anti-spiral-test-"))
process.env.ANTI_SPIRAL_STATE_DIR = STATE_DIR // must precede the import below

const pluginPath = process.env.ANTI_SPIRAL_PLUGIN || path.join(here, "..", "anti-spiral.js")
const { AntiSpiral } = await import(pluginPath)

// A fake opencode client: records aborts / prompts / toasts instead of doing them.
const calls = { abort: [], prompt: [], toast: [] }
const client = {
  session: {
    abort: async (o) => { calls.abort.push(o.path.id) },
    prompt: async (o) => { calls.prompt.push({ id: o.path.id, text: o.body.parts[0].text }) },
  },
  tui: { showToast: async (o) => { calls.toast.push(o.body.message) } },
}
const plugin = await AntiSpiral({ client })
const transform = plugin["experimental.chat.messages.transform"]
const onEvent = plugin.event

let pass = 0, fail = 0
function check(name, got, want) {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (flagged=${got}, expected=${want})`)
}

// Every assistant message gets its own id, the way opencode does it: the plugin
// counts a turn at most once per message id, so reusing one id for three different
// turns would make them look like the same turn re-processed.
let msgSeq = 0
function asst(parts, id) {
  return { info: { role: "assistant", id: id || `m${++msgSeq}`,
                   agent: "build", model: { providerID: "p", modelID: "m" } }, parts }
}
function user(text) {
  return { info: { role: "user", id: "u1", agent: "build", model: { providerID: "p", modelID: "m" } },
           parts: [{ type: "text", text }] }
}
// The transform hook's input is `{}` in opencode 1.18: session identity has to come
// from the messages, so every message is stamped the way the server stamps them.
async function run(sessionID, messages) {
  const stamped = messages.map(m => ({ ...m, info: { ...m.info, sessionID } }))
  const out = { messages: [...stamped] }
  await transform({}, out)
  const injected = out.messages.length > stamped.length
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
    { type: "text", text: "Let me proceed. ".repeat(20) },
    { type: "tool", tool: "read", state: { status: "completed" } },
  ]),
])
check("repetitive text alongside a tool call: reported, not escalated", withTool.injected, true)

// The real shape of an agent turn: the tool call and the closing text are
// SEPARATE assistant messages. Only the last one carries text; the tool call sits
// earlier in the same turn. Inspecting only the last message missed it, so an
// agent working flat out still counted as narrating and marched to a freeze.
const splitTurn = await run("t-split", [
  user("x"),
  asst([{ type: "tool", tool: "bash", state: { status: "completed" } }]),
  { info: { role: "tool", id: "tr1", agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ type: "text", text: "tool output" }] },
  asst([{ type: "text", text: "loop. ".repeat(40) }]),
])
// v3: the tool call still resets ESCALATION, but the loop is still called out —
// silently clearing it is how a 5x habit grew into a 1006x spiral.
check("tool call earlier in the same turn: loop still reported", splitTurn.injected, true)
check("  ...but as a non-escalating redirect (1/3)", splitTurn.text.includes("loop 1/3"), true)
const splitClean = await run("t-split-clean", [
  user("x"),
  asst([{ type: "tool", tool: "bash", state: { status: "completed" } }]),
  asst([{ type: "text", text: "The build passes now; the failing import was the stale symlink in dist, which I removed." }]),
])
check("tool call + clean closing text stays silent", splitClean.injected, false)

// loop -> tool -> loop: the counter must be back at 1, not 2
const r1 = await run("t-reset", [user("x"), asst([{ type: "text", text: "loop. ".repeat(40) }])])
await run("t-reset", [user("x"), asst([
  { type: "text", text: "loop. ".repeat(40) },
  { type: "tool", tool: "bash", state: { status: "completed" } },
])])
const r2 = await run("t-reset", [user("x"), asst([{ type: "text", text: "loop. ".repeat(40) }])])
check("first loop shows 1/3", r1.text.includes("loop 1/3"), true)
check("counter reset after a tool call", r2.text.includes("loop 1/3"), true)

// ── the real spiral shapes from the 2026-09-10 DeepSeek session ────────────
console.log("\n== real-world spirals ==")
const letMeGo = "Let me go.\n\nLet me read.\n\n"
const real1 = await run("t-real1", [user("x"), asst([
  { type: "reasoning", text: "Now I have enough. Let me check the rpc.py API for the keyless provider.\n\n" + letMeGo.repeat(60) },
])])
check("'Let me go / Let me read' x60 in a reasoning part", real1.injected, true)

// 1,000 words of ordinary reasoning that degenerates into 20 short lines at the end:
// whole-message coverage is ~16%, only the tail check sees it.
// ~1,000 words of varied, ordinary reasoning (no sentence repeats).
const longClean = Array.from({ length: 60 }, (_, i) =>
  `Step ${i + 1}: the parser reads record ${i + 1} and checks its length field against the remaining buffer, ` +
  `so a truncated frame at offset ${i * 64} is rejected before anything is copied into the output. `).join("")
const real2 = await run("t-real2", [user("x"), asst([
  { type: "reasoning", text: longClean + "OK.\n\n(Run.)\n\nLet me read.\n\nLet me do it.\n\n".repeat(6) },
  { type: "tool", tool: "read", state: { status: "completed" } },
])])
check("long clean reasoning that ends in a short-line loop (+ a tool call)", real2.injected, true)
check("  ...the evidence names the tic", real2.text.includes("narrating the next step instead of taking it"), true)

const real3 = await run("t-real3", [user("x"), asst([
  { type: "reasoning", text: longClean + "Enough deliberation. I will read waitForResponse now, lines 1891 to 1990, and then decide." },
])])
check("long clean reasoning with a normal ending stays silent", real3.injected, false)

// ── session identity comes from the messages, not the hook input ───────────
console.log("\n== session identity ==")
const sidLoop = { type: "text", text: "I need to think about how to proceed here. ".repeat(12) }
await run("t-sid-A", [user("x"), asst([sidLoop])])
await run("t-sid-A", [user("x"), asst([sidLoop])])
const other = await run("t-sid-B", [user("x"), asst([sidLoop])])
check("a different session starts at 1/3, not 3/3", other.text.includes("loop 1/3"), true)
const stateNow = JSON.parse(readFileSync(path.join(STATE_DIR, "state.json"), "utf8"))
check("state is keyed by the real session id", "t-sid-A" in stateNow.sessions && !("default" in stateNow.sessions), true)

// ── layer 1: the mid-stream kill switch ────────────────────────────────────
console.log("\n== mid-stream kill switch ==")
async function stream(sessionID, messageID, role, type, chunks) {
  await onEvent({ event: { type: "message.updated", properties: { info: { id: messageID, role, sessionID } } } })
  let text = ""
  const partID = `p-${messageID}`
  for (const c of chunks) {
    text += c
    await onEvent({ event: { type: "message.part.updated", properties: {
      part: { id: partID, messageID, sessionID, type, text, time: { start: 1 } }, delta: c } } })
  }
}
const before = calls.abort.length
await stream("s-live", "m-live", "assistant", "reasoning",
  ["Now I have enough. Let me check the rpc.py API.\n\n", ...Array(40).fill(letMeGo)])
check("streaming 'Let me go / Let me read' aborts the session", calls.abort.length, before + 1)
check("  ...the abort targets the right session", calls.abort.at(-1), "s-live")
check("  ...a redirect prompt follows", calls.prompt.at(-1)?.text.includes("[anti-spiral]") && calls.prompt.at(-1)?.text.includes("cut off mid-stream"), true)
check("  ...and the TUI gets a toast", calls.toast.length > 0, true)

// Cut once per message: more deltas for the same message do nothing.
await stream("s-live", "m-live", "assistant", "reasoning", [letMeGo.repeat(80)])
check("the same message is not aborted twice", calls.abort.length, before + 1)

// A USER pasting a spiral into the prompt must never abort their own session.
const b2 = calls.abort.length
await stream("s-user", "m-user", "user", "text", [letMeGo.repeat(80)])
check("a user message containing a spiral is ignored", calls.abort.length, b2)

// A log quoted inside an open code fence is not a loop, even mid-stream.
await stream("s-log", "m-log", "assistant", "text",
  ["The retries all fail the same way:\n\n```\n", ..."ERROR connection refused\n".repeat(30).split(/(?<=\n)/)])
check("streaming a repeated log line inside an open code fence is ignored", calls.abort.length, b2)

// Normal long reasoning streams untouched.
await stream("s-clean", "m-clean", "assistant", "reasoning", longClean.match(/.{1,200}/g))
check("normal long reasoning streams untouched", calls.abort.length, b2)

// A finished part is layer 2's business, not layer 1's.
await onEvent({ event: { type: "message.updated", properties: { info: { id: "m-done", role: "assistant", sessionID: "s-done" } } } })
await onEvent({ event: { type: "message.part.updated", properties: { part: {
  id: "p-done", messageID: "m-done", sessionID: "s-done", type: "reasoning", text: letMeGo.repeat(80), time: { start: 1, end: 2 } } } } })
check("a part that has already ended is not aborted", calls.abort.length, b2)

// The 09-14 regression: the role map is fed by `message.updated`, and when that
// event never arrived the old gate (`role !== "assistant"` -> return) skipped every
// part in silence — the journal showed a 15-minute spiral and zero cuts. Reasoning
// is assistant by construction, so it is judged even with no role event at all.
const b5 = calls.abort.length
async function part(p) { await onEvent({ event: { type: "message.part.updated", properties: { part: { time: { start: 1 }, ...p } } } }) }
let grown = ""
for (let i = 0; i < 40; i++) {
  grown += letMeGo
  await part({ id: "p-norole", messageID: "m-norole", sessionID: "s-norole", type: "reasoning", text: grown })
}
check("reasoning with no role event at all is still cut", calls.abort.length, b5 + 1)

// An unknown-role TEXT part is different: without growth it is a user paste, and a
// user must never have their own session aborted.
const b6 = calls.abort.length
await part({ id: "p-static", messageID: "m-static", sessionID: "s-static", type: "text", text: letMeGo.repeat(80) })
await part({ id: "p-static", messageID: "m-static", sessionID: "s-static", type: "text", text: letMeGo.repeat(80) })
check("a static unknown-role text part is not cut", calls.abort.length, b6)
await part({ id: "p-growing", messageID: "m-growing", sessionID: "s-growing", type: "text", text: "seed" })
await part({ id: "p-growing", messageID: "m-growing", sessionID: "s-growing", type: "text", text: letMeGo.repeat(80) })
check("an unknown-role text part that grows IS cut", calls.abort.length, b6 + 1)

// Escalation: after the cut, the next transform sees the aborted turn once and the
// counter that the cut already bumped is not bumped again.
const afterCut = await run("s-live", [user("x"), asst([{ type: "reasoning", text: letMeGo.repeat(60) }], "m-live")])
check("the cut turn is not counted a second time by the transform", afterCut.injected, false)

// ── the same turn, processed twice (a retry) ───────────────────────────────
console.log("\n== one turn, one count ==")

// The identical message array, so the identical assistant message id — exactly what
// a retried request hands the transform.
const sameTurn = [user("x"), asst([{ type: "text", text: "I need to think about how to proceed here. ".repeat(12) }])]
const dup1 = await run("t-dup", sameTurn)
const dup2 = await run("t-dup", sameTurn)
check("first pass flags the turn", dup1.text.includes("loop 1/3"), true)
check("re-processing the same turn is inert", dup2.injected, false)

// ── escalation across three consecutive looping turns ──────────────────────
console.log("\n== escalation ==")
const loopMsg = { type: "text", text: "I need to think about how to proceed here. ".repeat(12) }
const e1 = await run("t-esc", [user("x"), asst([loopMsg])])
const e2 = await run("t-esc", [user("x"), asst([loopMsg])])
const e3 = await run("t-esc", [user("x"), asst([loopMsg])])
check("turn 1 -> redirect", e1.text.includes("[anti-spiral]") && !e1.text.includes("HALT"), true)
check("turn 2 -> redirect", e2.text.includes("loop 2/3"), true)
check("turn 3 -> halt", e3.text.includes("HALT"), true)

// ── v4: the 09-14 spiral — a loop that keeps making tool calls ─────────────
console.log("\n== tool-call spiral (2026-09-14) ==")
// The shape that ran for 15 minutes: a turn of "Let me act." tics PLUS a tool
// call, every 20 seconds. v3 let the tool call reset the escalation counter, so
// the session was detected 18 times and halted zero times.
const ticTurn = () => [user("x"), asst([
  { type: "text", text: "Let me act. ".repeat(6) },
  { type: "tool", tool: "bash", state: { status: "completed" } },
])]
const s1 = await run("t-spiral", ticTurn())
const s2 = await run("t-spiral", ticTurn())
const s3 = await run("t-spiral", ticTurn())
check("looping tool turn 1 -> redirect", s1.text.includes("loop 1/3"), true)
check("looping tool turn 3 -> halt (v3 never got here)", s3.text.includes("HALT"), true)

// ── v4: the rate trip — detections that keep getting their counter reset ───
console.log("\n== rate trip ==")
// Every loop below is followed by a clean turn, which resets the consecutive
// counters. v3's spirals survived exactly this way; the rate trip counts
// detections in a rolling window instead, so it cannot be reset away.
const cleanTurn = (i) => [user("x"), asst([{ type: "text",
  text: `The failing import was the stale symlink in dist; removed it and the suite is green (run ${i}).` }])]
const rates = []
for (let i = 1; i <= 5; i++) {
  await run("t-rate", cleanTurn(i))
  rates.push((await run("t-rate", [user("x"), asst([{ type: "text", text: "Let me act. ".repeat(12) }])])).text)
}
check("first four detections only redirect", rates.slice(0, 4).every(t => t.includes("[anti-spiral]") && !t.includes("HALT")), true)
check("the fifth halts on the rate trip", rates[4].includes("HALT") && rates[4].includes("5 loops detected in the last"), true)

// ── v4: a short looping turn ───────────────────────────────────────────────
console.log("\n== short looping turn ==")
// Below the 40-word floor a turn used to be ignored outright, so a nine-word
// turn that was 100% repetition scored null.
const shortLoop = await run("t-short", [user("x"), asst([{ type: "text", text: "Let me act. Let me act. Let me act." }])])
check("a nine-word turn that is pure repetition fires", shortLoop.injected, true)
const shortReal = await run("t-short-ok", [user("x"), asst([{ type: "text", text: "The suite is green and the branch is pushed." }])])
check("a short ordinary answer stays silent", shortReal.injected, false)

// ── state written by the previous detector version ─────────────────────────
console.log("\n== stale state ==")
mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(path.join(STATE_DIR, "state.json"),
  JSON.stringify({ "some-session": { consecutiveSpirals: 7 } })) // v1 schema, frozen
const stale = await run("t-stale", [user("x"), asst([{ type: "text", text: "A short normal answer here." }])])
check("old frozen counter does not leak in", stale.injected, false)

// Counters written by an older detector carry different semantics (v3 had no
// toolLoops and no rate trip), so a row from that version must not be resumed:
// a v3 row already at 2/3 must not turn this session's first loop into a halt.
writeFileSync(path.join(STATE_DIR, "state.json"),
  JSON.stringify({ v: 3, sessions: { "t-v3": { loops: 2, t: Date.now() } } }))
const afterV3 = await run("t-v3", [user("x"), asst([{ type: "text", text: "loop. ".repeat(40) }])])
check("counters from an older detector version are not resumed", afterV3.text.includes("loop 1/3"), true)

// ── session rows nobody has touched ────────────────────────────────────────
console.log("\n== stale session rows ==")
const day = 24 * 60 * 60 * 1000
writeFileSync(path.join(STATE_DIR, "state.json"), JSON.stringify({ v: 4, sessions: {
  "t-long-gone": { loops: 2, t: Date.now() - 40 * day },
  "t-still-live": { loops: 1, t: Date.now() - 60 * 1000 },
} }))
await run("t-prune", [user("x"), asst([{ type: "text", text: "loop. ".repeat(40) }])])
const pruned = JSON.parse(readFileSync(path.join(STATE_DIR, "state.json"), "utf8"))
check("row idle past the TTL is dropped", "t-long-gone" in pruned.sessions, false)
check("recent row survives", pruned.sessions["t-still-live"]?.loops, 1)
check("the session just seen is recorded", pruned.sessions["t-prune"]?.loops, 1)

console.log(`\n${pass} passed, ${fail} failed`)
rmSync(STATE_DIR, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
