// anti-spiral.js — opencode plugin: catches genuine reasoning loops and redirects them.
//
// WHAT A REAL LOOP IS: the same *substantial* unit — a sentence, a phrase of five or
// more words, a whole line of prose — repeated three or more times, and repeated
// densely enough that the repetition dominates the message instead of merely
// appearing in it. Ordinary technical writing reuses short bigrams constantly
// ("the file", "of the", "in the"); that is not a loop, and treating it as one is
// what made the previous version fire on every turn until agents learned to ignore it.
//
// DETECTION (all checks run on prose only — fenced code, inline code, tables and
// tool output are stripped first, because logs and listings repeat lines legitimately):
//   1. Same sentence (>= 8 words) twice in a row — a hard loop signature.
//   2. Same prose line (>= 6 words) three or more times.
//   3. N-gram coverage: an n-gram (n = 3..8) occurring >= 3x AND covering at least
//      a threshold share of the whole message. Longer units need less coverage
//      (n>=5: 30%, n=4: 40%, n=3: 55%); short units must dominate to count.
//
// ESCALATION:
//   - loop 1-2: a redirect with the evidence (which phrase, how many times)
//   - loop 3+:  a hard stop — one tool call, no narration
//
// THE COUNTER RESETS ON PROGRESS, NOT ON PHRASING. If the assistant's last turn
// contained a tool call, it did work — the counter clears regardless of how the
// text reads. Only consecutive turns that produce no tool call *and* loop can
// escalate to a freeze. An agent that is working can never be frozen.
//
// A TURN IS COUNTED AT MOST ONCE. The transform can run twice for the same
// assistant message (a retry, or a second request before the model answers), and
// counting it twice would escalate a single loop straight to a halt. The message
// id of the last counted turn is stored, and that turn is inert if seen again.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// ANTI_SPIRAL_STATE_DIR relocates the counter file. The test suite points it at a
// temp dir so a run never touches a real session's counters, and anyone who keeps
// state outside $HOME can set it too.
const STATE_DIR =
  process.env.ANTI_SPIRAL_STATE_DIR ||
  path.join(os.homedir(), ".local", "share", "opencode", "anti-spiral")
const STATE_FILE = path.join(STATE_DIR, "state.json")
const STATE_VERSION = 2 // bump invalidates counters written by the old detector
const FREEZE_AFTER = 3
const MIN_WORDS = 40

// ── prose extraction ───────────────────────────────────────────────────────

// Everything that repeats itself for legitimate reasons: code, logs, tables,
// file listings, shell transcripts. Dropped before any repetition is measured.
function stripNonProse(text) {
  return text
    .replace(/```[\s\S]*?```/g, "\n")            // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, "\n")            // alt fenced blocks
    .replace(/`[^`\n]*`/g, " ")                  // inline code
    .replace(/^\s*\|.*\|\s*$/gm, "\n")           // markdown table rows
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?=\S)/gm, "") // list bullets (keep the text)
    .replace(/^\s*[>#]+\s?/gm, "")               // quote / heading markers
}

function isProseLine(line) {
  if (!line) return false
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length < 6) return false
  // Lines that are mostly symbols, paths, flags or code punctuation are not prose.
  const symbolish = (line.match(/[{}()[\];=<>|\\/_$@#*`~^]/g) || []).length
  if (symbolish / line.length > 0.18) return false
  const letters = (line.match(/[A-Za-z]/g) || []).length
  return letters / line.length > 0.55
}

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean)
}

// ── detection ──────────────────────────────────────────────────────────────

// Max occurrences of any n-gram, plus the share of the message that occurrence
// covers. Coverage is what separates "a loop" from "prose that reuses a phrase".
function ngramCoverage(words, n) {
  if (words.length < n * 3) return { best: null, count: 0, coverage: 0 }
  const counts = new Map()
  let best = null
  let bestCount = 0
  for (let i = 0; i <= words.length - n; i++) {
    const g = words.slice(i, i + n).join(" ")
    const c = (counts.get(g) || 0) + 1
    counts.set(g, c)
    if (c > bestCount) { bestCount = c; best = g }
  }
  return { best, count: bestCount, coverage: (bestCount * n) / words.length }
}

// Returns null when the text is not a loop, otherwise the evidence for the redirect.
function detectSpiral(rawText) {
  if (!rawText) return null
  const text = stripNonProse(rawText)
  const words = normalizeWords(text)
  if (words.length < MIN_WORDS) return null

  // 1. The same sentence twice in a row.
  const sentences = sentencesOf(text)
  for (let i = 1; i < sentences.length; i++) {
    const a = sentences[i - 1].toLowerCase().replace(/\s+/g, " ").trim()
    const b = sentences[i].toLowerCase().replace(/\s+/g, " ").trim()
    if (a.length > 30 && a === b) {
      return { kind: "sentence", phrase: sentences[i].slice(0, 140), count: 2 }
    }
  }

  // 2. The same line of prose three or more times.
  const lines = text.split("\n").map(l => l.trim()).filter(isProseLine)
  const lineCounts = new Map()
  for (const l of lines) {
    const key = l.toLowerCase().replace(/\s+/g, " ")
    const c = (lineCounts.get(key) || 0) + 1
    lineCounts.set(key, c)
    if (c >= 3) return { kind: "line", phrase: l.slice(0, 140), count: c }
  }

  // 3. N-gram dominance — the main check. Longer units need less coverage.
  for (const n of [8, 7, 6, 5, 4, 3]) {
    const threshold = n >= 5 ? 0.30 : n === 4 ? 0.40 : 0.55
    const { best, count, coverage } = ngramCoverage(words, n)
    if (count >= 3 && coverage >= threshold) {
      return { kind: "phrase", phrase: best, count, coverage }
    }
  }

  return null
}

// ── helpers ────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return s && typeof s === "object" ? s : {}
  } catch (_) {
    return {}
  }
}

// A counter only means something for a conversation that is still running, so rows
// nobody has touched in a month are dropped on write. Without this the file grows a
// row per session forever. Rows written before `t` existed are kept, not deleted —
// losing a counter is harmless, but silently resetting every live session once on
// upgrade is exactly the kind of surprise this plugin is supposed to avoid.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function pruneSessions(state) {
  const sessions = state.sessions
  if (!sessions) return
  const now = Date.now()
  for (const [id, row] of Object.entries(sessions)) {
    if (!row || typeof row !== "object") { delete sessions[id]; continue }
    const seen = Number.isFinite(row.t) ? row.t : now
    if (now - seen > SESSION_TTL_MS) delete sessions[id]
  }
}

function saveState(state) {
  try {
    pruneSessions(state)
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8")
  } catch (_) {}
}

// The text the assistant produced last, plus whether that turn did any work.
// A tool part means real progress was made, which clears the loop counter.
function lastAssistantTurn(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg?.info || msg.info.role !== "assistant") continue
    const parts = msg.parts || []
    const usedTool = parts.some(p => p && (p.type === "tool" || p.type === "tool-invocation" ||
      (p.type === "step-start" && p.tool)))
    const text = parts
      .filter(p => p && ["text", "thinking", "reasoning"].includes(p.type))
      .map(p => p.text || p.thinking || p.reasoning || p.content || "")
      .join("\n")
    return { text, usedTool, msgID: (msg.info && msg.info.id) || "" }
  }
  return { text: "", usedTool: false, msgID: "" }
}

function uniqueID(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function syntheticMsg(text, messages) {
  const lastUser = [...messages].reverse().find(m => m?.info?.role === "user" && m?.info?.model)
  const agent = lastUser?.info?.agent || "build"
  const model = lastUser?.info?.model || { providerID: "", modelID: "" }
  const id = uniqueID("spiral")
  return {
    info: { role: "user", id, sessionID: "", time: { created: Date.now() }, agent, model },
    parts: [{
      id: uniqueID("sp"),
      sessionID: "", messageID: id,
      type: "text", text, synthetic: true, ignored: false,
    }],
  }
}

// ── redirect messages ──────────────────────────────────────────────────────
// Operational tone, and always carries the evidence: an agent that is shown the
// exact phrase it repeated can act on it. Grandstanding gets filtered as noise.

function describe(evidence) {
  if (evidence.kind === "sentence") return `the same sentence twice in a row: "${evidence.phrase}"`
  if (evidence.kind === "line") return `this line ${evidence.count}x: "${evidence.phrase}"`
  const pct = Math.round(evidence.coverage * 100)
  return `"${evidence.phrase}" repeated ${evidence.count}x (${pct}% of the message)`
}

function redirectMsg(count, evidence) {
  return `[anti-spiral] Repetition detected in your last turn — ${describe(evidence)}.

That is the loop signature: the same unit restated instead of advanced. Nothing here
forbids continuing the task; it asks you to continue it in a different way.

Do exactly one of these, in this turn:
  1. Run the next concrete step as a tool call (read the file, run the command, make the edit).
  2. If the same step has now failed twice, stop repeating it — change the approach, or
     state the blocker and what you need from the user in one line.

Do not restate the plan. Do not re-explain what you are about to do. Act.

(loop ${count}/${FREEZE_AFTER} — three consecutive turns with no tool call and repeated
text will halt narration until a tool call is made.)`
}

function freezeMsg(count, evidence) {
  return `[anti-spiral] HALT — ${count} consecutive turns with repeated text and no tool call.
Last repetition: ${describe(evidence)}.

Narration is paused until real progress happens. Your next turn must be a tool call,
with no commentary before it. Pick the single most useful one:

  • an unread file that blocks the task   -> Read it
  • a command whose result you are guessing at -> Bash it
  • a blocking ambiguity in the request   -> ask the user one direct question, then stop

If you genuinely cannot proceed, say so in one sentence and stop. That is a valid
outcome — repeating the same reasoning is not.`
}

// ── plugin export ──────────────────────────────────────────────────────────

export async function AntiSpiral(_input) {
  console.log("[anti-spiral] loaded — loop detector v2 (progress-aware, code-aware)")
  return {
    "experimental.chat.messages.transform": async (hookInput, output) => {
      try {
        if (!output || !Array.isArray(output.messages)) return
        const sessionID = hookInput?.session?.id || "default"
        const state = loadState()
        // A state file written by the old detector carries a counter that is
        // already at freeze — start clean instead of inheriting its verdict.
        if (state.v !== STATE_VERSION) {
          state.v = STATE_VERSION
          state.sessions = {}
        }
        if (!state.sessions) state.sessions = {}
        if (!state.sessions[sessionID]) state.sessions[sessionID] = { loops: 0 }
        const s = state.sessions[sessionID]
        s.t = Date.now() // last-seen stamp; pruneSessions() drops stale rows

        const { text, usedTool, msgID } = lastAssistantTurn(output.messages)

        // Progress clears the counter: the assistant did something, whatever it wrote.
        if (usedTool) {
          if (s.loops > 0 || s.lastMsg) {
            s.loops = 0
            s.lastMsg = ""
            saveState(state)
          }
          return
        }

        // This exact turn has already been judged. Re-running the transform on it
        // (a retry, or a second request before the model answers) must not count it
        // again, or one loop would escalate as if it were three.
        if (msgID && msgID === s.lastMsg) return

        const evidence = detectSpiral(text)
        if (evidence) {
          s.loops++
          s.lastMsg = msgID
          saveState(state)
          console.log(`[anti-spiral] loop #${s.loops} (session=${sessionID}, ${evidence.kind})`)
          const msg = s.loops >= FREEZE_AFTER ? freezeMsg(s.loops, evidence) : redirectMsg(s.loops, evidence)
          output.messages.push(syntheticMsg(msg, output.messages))
        } else if (s.loops > 0) {
          s.loops = 0
          s.lastMsg = ""
          saveState(state)
        }
      } catch (err) {
        try { console.error("[anti-spiral] error:", String(err?.message || err)) } catch (_) {}
      }
    },
  }
}

export default { id: "anti.spiral", server: AntiSpiral }
