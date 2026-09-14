// anti-spiral.js — opencode plugin: catches genuine reasoning loops and stops them.
//
// v4. What v3 got wrong, measured on a real 15-minute spiral (09-14, 34,576 chars,
// reasoning tics "Let me act." x176 / "OK." x163 / "Let me make the call." x133):
//
//   1. THE TOOL-CALL SPIRAL WAS IMMUNE. The turn hook reset the escalation counter
//      whenever the turn contained a tool call, so a spiral that kept *making* calls
//      ("Let me act." + one Read, 20 seconds apart) zeroed its own counter forever.
//      It was detected 18 times in 15 minutes and never escalated past a redirect.
//      FIX: a separate `toolLoops` counter (a clean tool turn still resets).
//   2. LAYER 1 COULD NOT FIRE AT ALL. Replaying the real spiral through the detector
//      shows the mid-stream check trips at 3,600 chars (10% in) — yet the live journal
//      has ZERO "MID-STREAM CUT" lines, because layer 1 gated every part behind a role
//      map fed by `message.updated`, and a part whose role was never seen was silently
//      skipped. FIX: a reasoning part is assistant by construction (only assistants
//      emit reasoning), so it is judged directly; for text parts an unknown role must
//      first show real stream growth, which a static user message can never do.
//   3. EVERY DETECTION WAS FORGETTABLE. Resetting counters is what let 18 detections
//      pass for silence. FIX: a rate trip — RATE_LIMIT detections inside RATE_WINDOW_MS
//      halts the session regardless of what the counters were reset to. Hits are never
//      cleared by hand; the rolling window is the only thing that forgets, because one
//      clean turn between two loops is precisely the pattern that survived v3.
//   4. SHORT LOOPING TURNS WERE INVISIBLE. `MIN_WORDS = 40` returned early, so a
//      three-line "Let me act." turn (9 words, 100% repetition) scored null. FIX:
//      a short-text path that judges repeated n-grams by coverage, not by length.
//
// v4 measured (test/run.mjs): 3 consecutive looping turns -> HALT on the third; 5
// detections in 5 minutes -> HALT even with every counter reset between them; 20
// clean tool-call turns -> 0 detections; the real 34,576-char spiral -> HALT on
// turn 4, 17% in, about a minute of wall clock instead of fifteen.
//
// v3. Two independent layers, because v2 had one and it missed a 26,000-character
// "Let me go. / Let me read." spiral in a single DeepSeek reasoning stream:
//
//   LAYER 1 — MID-STREAM KILL SWITCH (the `event` hook)
//     Every streamed reasoning/text delta of an ASSISTANT message is watched. When
//     the tail of the stream is dominated by a repeated unit, the session is aborted
//     right there (client.session.abort) and a redirect is sent as the next user
//     message. A spiral is cut at a few hundred characters instead of running to the
//     provider's output-token limit. v2 only had the transform hook, which runs
//     *before the next request* — it cannot touch a generation already in flight.
//
//   LAYER 2 — TURN REVIEW (the `experimental.chat.messages.transform` hook)
//     Before each request the previous assistant turn is judged. A loop injects a
//     redirect with the evidence; three consecutive looping turns without a tool call
//     escalate to a halt. v2 skipped this entirely when the turn contained a tool
//     call, so a reasoning stream that looped 20x and then emitted one Read counted
//     as "progress" — and grew, turn by turn, into the 1006x spiral. Now a tool call
//     still resets the ESCALATION, but a loop is still reported.
//
// WHAT A REAL LOOP IS: the same substantial unit — a sentence, a phrase, a line —
// repeated enough that the repetition DOMINATES a window of text. Ordinary prose
// reuses short phrases; that is not a loop. Five signatures are checked:
//   1. Same sentence (>30 chars) twice in a row.
//   2. Same prose line (>= 6 words) three or more times.
//   3. N-gram dominance over the whole message (n = 3..8, >= 3x, coverage threshold).
//   4. The stall tic: a line of <= 4 words ("Let me go.", "(Run.)", "OK.") standing on
//      its own >= 4 times. Every real spiral examined started this way.
//   5. TAIL dominance: the last ~150 words are >= 60% one repeated n-gram (n = 2..10,
//      >= 4x), or the last 12 lines are short and have <= 4 distinct values. This is
//      the live-spiral signature — the message may be long and mostly fine, and the
//      loop is what it has degenerated into at the end. v2 dropped this check and
//      a 1,000-word reasoning that ended in 20 "Let me read / Let me go" lines
//      scored 16% coverage: invisible.
//
// Code, logs, tables and tool output are stripped before measuring, because those
// repeat lines for legitimate reasons.
//
// Session identity comes from the messages themselves (info.sessionID): the transform
// hook's input is `{}` in opencode 1.18, so v2's `hookInput.session.id` was always
// undefined and every session shared one counter named "default".
//
// A turn is counted at most once (by assistant message id). State is per session,
// pruned after 30 idle days.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const VERSION = "v4"
const STATE_DIR =
  process.env.ANTI_SPIRAL_STATE_DIR ||
  path.join(os.homedir(), ".local", "share", "opencode", "anti-spiral")
const STATE_FILE = path.join(STATE_DIR, "state.json")
const STATE_VERSION = 4 // bump invalidates counters written by an older detector
const FREEZE_AFTER = 3
const MIN_WORDS = 40
const MIN_SHORT_WORDS = 8 // below MIN_WORDS but still judgeable (short looping turn)

// Rate trip: the escape hatch a counter-reset spiral used to walk through. 18
// detections in 15 minutes stayed a redirect because each one reset a counter;
// five inside five minutes halts no matter what the counters say.
const RATE_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT = 5

// Mid-stream: don't judge a stream before it has this much text, then re-check
// every STREAM_STEP characters of growth (cheap: the check is O(tail)).
const STREAM_MIN_CHARS = Number(process.env.ANTI_SPIRAL_STREAM_MIN_CHARS) || 400
const STREAM_STEP = 200
const TAIL_WORDS = 150
const TAIL_LINES = 12

// ── prose extraction ───────────────────────────────────────────────────────

function stripNonProse(text) {
  return text
    .replace(/```[\s\S]*?```/g, "\n")            // fenced code blocks
    .replace(/~~~[\s\S]*?~~~/g, "\n")            // alt fenced blocks
    .replace(/`[^`\n]*`/g, " ")                  // inline code
    .replace(/^\s*\|.*\|\s*$/gm, "\n")           // markdown table rows
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?=\S)/gm, "") // list bullets (keep the text)
    .replace(/^\s*[>#]+\s?/gm, "")               // quote / heading markers
}

// A stream in flight may have an open code fence with no closing one yet; drop
// everything from that fence so a log being quoted is not judged as prose.
function stripStreaming(text) {
  const fences = (text.match(/```/g) || []).length
  if (fences % 2 === 1) text = text.slice(0, text.lastIndexOf("```"))
  return stripNonProse(text)
}

function isProseLine(line) {
  if (!line) return false
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length < 6) return false
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

// Max occurrences of any n-gram over `words`, and the share of `words` covered.
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

// The stall tic: a short line ("Let me go.", "(Run.)", "OK.") standing on its own,
// over and over. In every real spiral examined it was the first symptom — a
// reasoning stream that was otherwise varied, punctuated by "Let me go." between
// every thought, before it collapsed into pure repetition. Nothing legitimate
// repeats a four-word line `minCount` times.
function detectTic(lines, minCount) {
  const counts = new Map()
  let best = null
  for (const raw of lines) {
    // Labels ("old:", "user: ..."), transcript prefixes and lines where inline code
    // was stripped out (they leave a double space) are structure, not narration.
    if (/:\s*$/.test(raw) || /^(user|assistant|system|old|new|before|after)\s*:/i.test(raw)) continue
    if (raw.includes("  ")) continue
    if (!/[.!?)]$/.test(raw)) continue // a tic is a sentence-shaped line
    const key = raw.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().replace(/\s+/g, " ")
    const words = key.split(" ").filter(Boolean)
    if (words.length === 0 || words.length > 4) continue
    if (words.some(w => /\d/.test(w))) continue // "step 3", "line 42": numbered, not a tic
    // "Let me ..." is THE narration tic and is held to the base threshold; any other
    // short line ("Hmm.", "OK.", "Done.") needs two more repeats to count.
    const need = key.startsWith("let me") ? minCount : minCount + 2
    const c = (counts.get(key) || 0) + 1
    counts.set(key, c)
    if (c >= need && (!best || c > best.count)) best = { kind: "tic", phrase: raw.trim().slice(0, 60), count: c }
  }
  return best
}

// The live-spiral signature: the END of the text is one unit over and over.
// Works on raw text (reasoning streams have no code fences worth stripping, and
// stripping is applied by the caller where it matters).
function detectTailLoop(text) {
  if (!text) return null
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean)
  // (a) the same short line six or more times in the last 40 lines.
  const tic = detectTic(lines.slice(-40), 6)
  if (tic) return { ...tic, coverage: tic.count / Math.min(lines.length, 40) }
  // (b) short lines with almost no variety: "Let me go." / "Let me read." / "OK."
  if (lines.length >= TAIL_LINES) {
    const tail = lines.slice(-TAIL_LINES)
    const short = tail.every(l => l.split(/\s+/).length <= 8)
    const distinct = new Set(tail.map(l => l.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()))
    // <= 4 distinct values over 12 lines: a 2-, 3- or 4-line cycle repeated three
    // times or more ("OK. / (Run.) / Let me read. / Let me do it." was a 4-cycle).
    if (short && distinct.size <= 4) {
      const counts = new Map()
      for (const l of tail) counts.set(l, (counts.get(l) || 0) + 1)
      const [phrase, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      return { kind: "tail", phrase: phrase.slice(0, 140), count, coverage: count / tail.length }
    }
  }
  // (c) one n-gram dominating the last TAIL_WORDS words.
  const words = normalizeWords(text)
  if (words.length < 60) return null
  const tail = words.slice(-TAIL_WORDS)
  for (const n of [10, 9, 8, 7, 6, 5, 4, 3, 2]) {
    const { best, count, coverage } = ngramCoverage(tail, n)
    if (count >= 4 && coverage >= 0.6) {
      return { kind: "tail", phrase: best, count, coverage }
    }
  }
  return null
}

// A short turn that is almost entirely one repeated unit. "Let me act." repeated
// three times is nine words and 100% repetition — far more loop-like than a long
// message that happens to reuse a phrase — but v3 returned null on it for being
// under MIN_WORDS, so those turns reset the counter instead of feeding it.
function detectShortSpiral(text, words) {
  if (words.length < MIN_SHORT_WORDS) return null
  for (const n of [5, 4, 3, 2]) {
    const { best, count, coverage } = ngramCoverage(words, n)
    if (count >= 3 && coverage >= 0.5) {
      return { kind: "short", phrase: best, count, coverage }
    }
  }
  return null
}

// Returns null when the text is not a loop, otherwise the evidence for the redirect.
function detectSpiral(rawText) {
  if (!rawText) return null
  const text = stripNonProse(rawText)
  const words = normalizeWords(text)
  if (words.length < MIN_WORDS) return detectShortSpiral(text, words)

  // 1. The same sentence twice in a row.
  const sentences = sentencesOf(text)
  for (let i = 1; i < sentences.length; i++) {
    const a = sentences[i - 1].toLowerCase().replace(/\s+/g, " ").trim()
    const b = sentences[i].toLowerCase().replace(/\s+/g, " ").trim()
    if (a.length > 30 && a === b) {
      return { kind: "sentence", phrase: sentences[i].slice(0, 140), count: 2 }
    }
  }

  // 2. The same line of prose three or more times. Quotations are exempt: a
  //    summary that restates `user: "..."` three times is quoting, not looping.
  const allLines = text.split("\n").map(l => l.trim()).filter(Boolean)
  const lines = allLines.filter(isProseLine).filter(l => !/^["'\u201c]|:\s*["\u201c]/.test(l))
  const lineCounts = new Map()
  for (const l of lines) {
    const key = l.toLowerCase().replace(/\s+/g, " ")
    const c = (lineCounts.get(key) || 0) + 1
    lineCounts.set(key, c)
    if (c >= 3) return { kind: "line", phrase: l.slice(0, 140), count: c }
  }

  // 3. The stall tic: a short line on its own, four or more times.
  const tic = detectTic(allLines, 4)
  if (tic) return { ...tic, coverage: tic.count / allLines.length }

  // 4. N-gram dominance over the whole message.
  for (const n of [8, 7, 6, 5, 4, 3]) {
    const threshold = n >= 5 ? 0.30 : n === 4 ? 0.40 : 0.55
    const { best, count, coverage } = ngramCoverage(words, n)
    if (count >= 3 && coverage >= threshold) {
      return { kind: "phrase", phrase: best, count, coverage }
    }
  }

  // 5. The tail has degenerated into a loop even if the whole message has not.
  return detectTailLoop(text)
}

// ── state ──────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    if (!s || typeof s !== "object") return {}
    // Counters from an older detector mean different things (v3 had no toolLoops
    // and no rate trip), so they start from zero rather than being resumed.
    if (s.v !== STATE_VERSION) return {}
    return s
  } catch (_) {
    return {}
  }
}

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

function sessionRow(state, sessionID) {
  if (state.v !== STATE_VERSION) {
    state.v = STATE_VERSION
    state.sessions = {}
  }
  if (!state.sessions) state.sessions = {}
  if (!state.sessions[sessionID]) state.sessions[sessionID] = { loops: 0, aborts: 0, toolLoops: 0, hits: [] }
  const s = state.sessions[sessionID]
  if (!Number.isFinite(s.loops)) s.loops = 0
  if (!Number.isFinite(s.aborts)) s.aborts = 0
  // 09-14: consecutive turns that looped WHILE making a tool call. Kept separate
  // from `loops` because a clean tool-call turn must still reset everything.
  if (!Number.isFinite(s.toolLoops)) s.toolLoops = 0
  // Detection timestamps inside RATE_WINDOW_MS. Survives every counter reset: if
  // the session keeps producing loops at this rate it is spiralling, whatever the
  // individual counters were talked into.
  if (!Array.isArray(s.hits)) s.hits = []
  s.t = Date.now()
  return s
}

// Records one detection and says whether the rate trip is now tripped. Hits are
// never cleared by hand — the rolling window is the only thing that forgets, so a
// spiral that alternates good turns with bad ones still trips it.
function recordHit(s, now = Date.now()) {
  s.hits = (s.hits || []).filter(t => Number.isFinite(t) && now - t < RATE_WINDOW_MS)
  s.hits.push(now)
  if (s.hits.length > 200) s.hits = s.hits.slice(-200)
  return s.hits.length
}

// ── message helpers ────────────────────────────────────────────────────────

function isToolPart(p) {
  if (!p) return false
  if (p.type === "tool" || p.type === "tool-invocation" || p.type === "tool-call") return true
  if (p.type === "step-start" && p.tool) return true
  if (p.tool && p.state) return true
  return false
}

function partText(p) {
  if (!p || !["text", "thinking", "reasoning"].includes(p.type)) return ""
  return p.text || p.thinking || p.reasoning || p.content || ""
}

// The last assistant turn: every assistant message back to the preceding user
// message. `text` is ALL reasoning/text in the turn (a loop that lives in the
// reasoning of an earlier step is still a loop), `usedTool` is whether any message
// in the turn carried a tool call, `msgID` identifies the closing message.
function lastAssistantTurn(messages) {
  let lastIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "assistant") { lastIdx = i; break }
  }
  if (lastIdx < 0) return { text: "", usedTool: false, msgID: "" }

  let usedTool = false
  const chunks = []
  for (let i = lastIdx; i >= 0; i--) {
    const msg = messages[i]
    if (!msg?.info) continue
    if (msg.info.role === "user") break
    if (msg.info.role !== "assistant") continue
    const parts = msg.parts || []
    if (parts.some(isToolPart)) usedTool = true
    const t = parts.map(partText).filter(Boolean).join("\n")
    if (t) chunks.unshift(t)
  }
  const last = messages[lastIdx]
  return { text: chunks.join("\n"), usedTool, msgID: (last.info && last.info.id) || "" }
}

function sessionOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.info?.sessionID
    if (id) return id
  }
  return "default"
}

function uniqueID(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function syntheticMsg(text, messages, sessionID) {
  const lastUser = [...messages].reverse().find(m => m?.info?.role === "user" && m?.info?.model)
  const agent = lastUser?.info?.agent || "build"
  const model = lastUser?.info?.model || { providerID: "", modelID: "" }
  const id = uniqueID("spiral")
  return {
    info: { role: "user", id, sessionID, time: { created: Date.now() }, agent, model },
    parts: [{
      id: uniqueID("sp"),
      sessionID, messageID: id,
      type: "text", text, synthetic: true, ignored: false,
    }],
  }
}

// ── redirect messages ──────────────────────────────────────────────────────

function describe(evidence) {
  if (evidence.kind === "short") {
    const pct = Math.round((evidence.coverage || 0) * 100)
    return `"${evidence.phrase}" repeated ${evidence.count}x (${pct}% of a short turn)`
  }
  if (evidence.kind === "sentence") return `the same sentence twice in a row: "${evidence.phrase}"`
  if (evidence.kind === "line") return `this line ${evidence.count}x: "${evidence.phrase}"`
  if (evidence.kind === "tic") return `the line "${evidence.phrase}" on its own ${evidence.count}x — narrating the next step instead of taking it`
  const pct = Math.round((evidence.coverage || 0) * 100)
  const where = evidence.kind === "tail" ? " of the end of the message" : " of the message"
  return `"${evidence.phrase}" repeated ${evidence.count}x (${pct}%${where})`
}

function redirectMsg(count, evidence, tool) {
  return `[anti-spiral] Repetition detected in your last turn — ${describe(evidence)}.

That is the loop signature: the same unit restated instead of advanced. Nothing here
forbids continuing the task; it asks you to continue it in a different way.

Do exactly one of these, in this turn:
  1. Run the next concrete step as a tool call (read the file, run the command, make the edit).
  2. If the same step has now failed twice, stop repeating it — change the approach, or
     state the blocker and what you need from the user in one line.

Do not restate the plan. Do not re-explain what you are about to do. Do not write
"let me" — call the tool. Act.

(loop ${count}/${FREEZE_AFTER} — ${tool
    ? "a third turn like this one halts narration. Make the call; do not narrate the call."
    : "three consecutive turns with no tool call and repeated text halt narration."})`
}

function freezeMsg(count, evidence, rate) {
  const why = rate && rate >= RATE_LIMIT
    ? `${rate} loops detected in the last ${Math.round(RATE_WINDOW_MS / 60000)} minutes`
    : `${count} consecutive turns with repeated text`
  return `[anti-spiral] HALT — ${why}.
Last repetition: ${describe(evidence)}.

Narration is paused until real progress happens. Your next turn must be a tool call,
with no commentary before it. Pick the single most useful one:

  • an unread file that blocks the task   -> Read it
  • a command whose result you are guessing at -> Bash it
  • a blocking ambiguity in the request   -> ask the user one direct question, then stop

If you genuinely cannot proceed, say so in one sentence and stop. That is a valid
outcome — repeating the same reasoning is not.`
}

function abortMsg(count, evidence) {
  return `[anti-spiral] Your previous response was cut off mid-stream: it had degenerated into
a loop — ${describe(evidence)} — and was going nowhere.

Everything before the loop still stands. Resume from there with ONE concrete action:
the tool call you were about to make (read the file, run the command, make the edit).
Emit the tool call directly. No "let me", no restating what you are about to do.

If you cannot decide what the next step is, say what is blocking you in one sentence
and stop.

(mid-stream cut ${count} — repeated cuts without a tool call will halt this session.)`
}

// ── plugin ─────────────────────────────────────────────────────────────────

export async function AntiSpiral(input) {
  const client = input?.client
  console.log(`[anti-spiral] loaded — loop detector ${VERSION} (mid-stream kill switch + turn review, halt on ${FREEZE_AFTER} straight or ${RATE_LIMIT} in ${Math.round(RATE_WINDOW_MS / 60000)}min)`)

  // Layer 1 bookkeeping. roles: messageID -> role (a user pasting a spiral into the
  // prompt must never abort their own session — but v3 gated on the role map alone,
  // and when message.updated never populated it every part was skipped in silence,
  // which is why a 15-minute spiral produced zero cuts). streams: partID -> last
  // length judged. cut: messageIDs already aborted. diag: what layer 1 actually saw.
  const roles = new Map()
  const streams = new Map()
  const cut = new Set()
  const bound = (m, max) => { if (m.size > max) { const first = m.keys().next().value; m.delete(first) } }
  const diag = { seen: 0, finished: 0, reasoning: 0, text: 0, roleKnown: 0, roleUnknown: 0, user: 0, judged: 0, cuts: 0 }
  function flushDiag() {
    if (diag.seen < 200) return
    console.log(`[anti-spiral] stream diag — parts=${diag.seen} finished=${diag.finished} reasoning=${diag.reasoning} text=${diag.text} roleKnown=${diag.roleKnown} roleUnknown=${diag.roleUnknown} user=${diag.user} judged=${diag.judged} cuts=${diag.cuts}`)
    diag.seen = diag.finished = diag.reasoning = diag.text = 0
    diag.roleKnown = diag.roleUnknown = diag.user = diag.judged = 0
  }

  async function cutStream(part, evidence) {
    const sessionID = part.sessionID
    const messageID = part.messageID
    if (!sessionID || !messageID || cut.has(messageID)) return
    cut.add(messageID); bound(cut, 500)

    const state = loadState()
    const s = sessionRow(state, sessionID)
    s.aborts += 1
    s.loops += 1
    const rate = recordHit(s)
    s.lastMsg = messageID
    saveState(state)
    diag.cuts += 1
    console.log(`[anti-spiral] MID-STREAM CUT #${s.aborts} rate=${rate}/${RATE_LIMIT} (session=${sessionID}, msg=${messageID}, ${evidence.count}x "${String(evidence.phrase).slice(0, 60)}")`)

    if (!client) return
    try {
      await client.session.abort({ path: { id: sessionID } })
    } catch (err) {
      console.error("[anti-spiral] abort failed:", String(err?.message || err))
      return
    }
    try {
      await client.tui.showToast({ body: {
        title: "anti-spiral", variant: "warning", duration: 6000,
        message: `Cut a reasoning loop (${evidence.count}x "${String(evidence.phrase).slice(0, 40)}") and redirected.`,
      } })
    } catch (_) {}
    // Give the abort a moment to settle before the redirect opens a new turn.
    await new Promise(r => setTimeout(r, 400))
    const halt = s.loops >= FREEZE_AFTER || rate >= RATE_LIMIT
    const text = halt ? freezeMsg(s.loops, evidence, rate) : abortMsg(s.aborts, evidence)
    try {
      await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
    } catch (err) {
      console.error("[anti-spiral] redirect prompt failed:", String(err?.message || err))
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (!event) return
        if (event.type === "message.updated") {
          const info = event.properties?.info
          if (info?.id && info.role) { roles.set(info.id, info.role); bound(roles, 2000) }
          return
        }
        if (event.type !== "message.part.updated") return
        const part = event.properties?.part
        if (!part || (part.type !== "reasoning" && part.type !== "text")) return
        diag.seen += 1
        if (part.time?.end) { diag.finished += 1; streams.delete(part.id); flushDiag(); return } // finished: layer 2 owns it now
        if (part.type === "reasoning") diag.reasoning += 1; else diag.text += 1
        const role = roles.get(part.messageID)
        if (role === "assistant") diag.roleKnown += 1
        else if (role) { diag.user += 1; flushDiag(); return } // a user message: never cut their own turn
        else diag.roleUnknown += 1
        if (cut.has(part.messageID)) return
        const text = partText(part)
        const seen = streams.get(part.id)
        // Reasoning exists only on assistant messages, so it is safe to judge at once.
        // Text is not: without a role, a long static user paste is indistinguishable
        // from an assistant stream already in flight. Such a part is judged only after
        // it is seen to GROW, so its first sighting just records a length to compare
        // against — a user paste is written once and never grows.
        if (part.type !== "reasoning" && role !== "assistant" && seen === undefined) {
          if (text.length) { streams.set(part.id, text.length); bound(streams, 500) }
          flushDiag(); return
        }
        if (text.length < STREAM_MIN_CHARS) { flushDiag(); return }
        if (seen !== undefined && text.length - seen < STREAM_STEP) { flushDiag(); return }
        streams.set(part.id, text.length); bound(streams, 500)
        diag.judged += 1
        const evidence = detectTailLoop(stripStreaming(text))
        if (evidence) await cutStream(part, evidence)
        flushDiag()
      } catch (err) {
        try { console.error("[anti-spiral] event error:", String(err?.message || err)) } catch (_) {}
      }
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      try {
        if (!output || !Array.isArray(output.messages)) return
        const sessionID = sessionOf(output.messages)
        const state = loadState()
        const s = sessionRow(state, sessionID)

        const { text, usedTool, msgID } = lastAssistantTurn(output.messages)

        // This exact turn has already been judged (a retry, or a second request
        // before the model answered, or a mid-stream cut that already counted it).
        if (msgID && msgID === s.lastMsg) return

        const evidence = detectSpiral(text)

        if (usedTool) {
          if (!evidence) {
            // Genuine work with no loop: escalation resets. A working agent that
            // makes tool calls must never be frozen — that was the v2 bug.
            s.loops = 0
            s.aborts = 0
            s.toolLoops = 0
            s.lastMsg = ""
            saveState(state)
            return
          }

          // 09-14: A LOOP *ALONGSIDE* A TOOL CALL USED TO RESET THE COUNTER, so a
          // spiral that keeps making tool calls could never escalate. Measured live:
          // a 15-minute "Let me act. / Let me make the call." spiral was detected
          // 8 times between 02:02 and 02:17 and every single one logged
          // "redirect, no escalation" — the counter was zeroed by the very tool call
          // the spiral was producing. A clean tool-call turn still resets (above);
          // a LOOPING tool-call turn now accumulates in its own counter.
          s.loops = 0
          s.aborts = 0
          s.toolLoops = (s.toolLoops || 0) + 1
          const rate = recordHit(s)
          s.lastMsg = msgID
          saveState(state)
          // Two ways to halt: three consecutive looping tool-turns, or five drifting
          // turns in five minutes however many of them got their counter reset.
          const halt = s.toolLoops >= FREEZE_AFTER || rate >= RATE_LIMIT
          if (halt) {
            console.log(`[anti-spiral] TOOL-CALL LOOP #${s.toolLoops} rate=${rate}/${RATE_LIMIT} (session=${sessionID}, ${evidence.kind}) — halting`)
            output.messages.push(syntheticMsg(freezeMsg(s.toolLoops, evidence, rate), output.messages, sessionID))
          } else {
            console.log(`[anti-spiral] loop alongside a tool call #${s.toolLoops}/${FREEZE_AFTER} rate=${rate}/${RATE_LIMIT} (session=${sessionID}, ${evidence.kind}) — redirect`)
            output.messages.push(syntheticMsg(redirectMsg(s.toolLoops, evidence, true), output.messages, sessionID))
          }
          return
        }
        // a non-tool turn that is NOT looping also clears the consecutive tool-call
        // counter. It deliberately does NOT clear the rate-trip hits: one clean turn
        // between two loops is exactly how v3's spirals survived. Hits expire only
        // by falling out of the rolling window, which is what makes the trip
        // un-forgettable.
        if (!evidence && s.toolLoops) s.toolLoops = 0

        if (evidence) {
          s.loops++
          const rate = recordHit(s)
          s.lastMsg = msgID
          saveState(state)
          const halt = s.loops >= FREEZE_AFTER || rate >= RATE_LIMIT
          console.log(`[anti-spiral] loop #${s.loops} rate=${rate}/${RATE_LIMIT} (session=${sessionID}, ${evidence.kind})${halt ? " — halting" : ""}`)
          const msg = halt ? freezeMsg(s.loops, evidence, rate) : redirectMsg(s.loops, evidence)
          output.messages.push(syntheticMsg(msg, output.messages, sessionID))
        } else if (s.loops > 0 || s.aborts > 0) {
          s.loops = 0
          s.aborts = 0
          s.lastMsg = ""
          saveState(state)
        }
      } catch (err) {
        try { console.error("[anti-spiral] error:", String(err?.message || err)) } catch (_) {}
      }
    },
  }
}

export { detectSpiral, detectTailLoop }
export default { id: "anti.spiral", server: AntiSpiral }
