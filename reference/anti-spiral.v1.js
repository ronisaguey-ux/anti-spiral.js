// anti-spiral.js — opencode plugin: detects ALL forms of thinking loops and hard-interrupts them.
//
// DETECTION (broad — catches all loop types):
//   1. N-gram repetition (2-word through 8-word phrases repeated >= 3x)
//   2. Line-level repetition (same line appears >= 3x)
//   3. Alternating pair repetition ("Let me go / Let me run" style)
//   4. Short burst repetition (last 200 chars has repeated sentence fragments)
//   5. Total word count vs unique word ratio (< 30% unique = looping)
//
// RESPONSE:
//   - 1st–4th spiral: inject furious shame warning mid-context
//   - 5th+ consecutive: full FREEZE message — stop everything
//   - Resets on any clean response

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const STATE_DIR = path.join(os.homedir(), ".local", "share", "opencode", "anti-spiral")
const STATE_FILE = path.join(STATE_DIR, "state.json")
const FREEZE_AFTER = 5

// ── detection ──────────────────────────────────────────────────────────────

function ngramRepeat(words, n, threshold) {
  const counts = {}
  for (let i = 0; i <= words.length - n; i++) {
    const g = words.slice(i, i + n).join(" ")
    counts[g] = (counts[g] || 0) + 1
    if (counts[g] >= threshold) return true
  }
  return false
}

function detectSpiral(text) {
  if (!text || text.length < 80) return false

  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)

  // 1. Line-level repetition: same line appears 3+ times
  const lineCounts = {}
  for (const l of lines) {
    if (l.length < 4) continue
    lineCounts[l] = (lineCounts[l] || 0) + 1
    if (lineCounts[l] >= 3) return true
  }

  // 2. Alternating pair: detect A B A B A B patterns in lines
  if (lines.length >= 6) {
    let altCount = 0
    for (let i = 0; i < lines.length - 2; i++) {
      if (lines[i] === lines[i + 2]) altCount++
    }
    if (altCount >= 3) return true
  }

  // 3. N-gram repetition (2–6 word phrases, threshold 3)
  if (words.length >= 10) {
    for (const n of [2, 3, 4, 5, 6]) {
      if (ngramRepeat(words, n, 3)) return true
    }
  }

  // 4. Unique word ratio (< 25% unique across a long text = looping)
  if (words.length >= 60) {
    const unique = new Set(words).size
    if (unique / words.length < 0.25) return true
  }

  // 5. Last 300 chars repeated fragments
  const tail = text.slice(-300)
  const tailWords = tail.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
  if (tailWords.length >= 20 && ngramRepeat(tailWords, 2, 4)) return true

  return false
}

// ── helpers ────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch (_) { return {} }
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8")
  } catch (_) {}
}

function extractLastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg?.info || msg.info.role !== "assistant") continue
    const text = (msg.parts || [])
      .filter(p => p && ["text","thinking","reasoning"].includes(p.type))
      .map(p => p.text || p.thinking || p.content || "")
      .join("\n")
    if (text.trim()) return text
  }
  return ""
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

// ── warning messages ───────────────────────────────────────────────────────

function warningMsg(count) {
  return `🚨🚨🚨 THOUGHT LOOP DETECTED (${count}/${FREEZE_AFTER}) 🚨🚨🚨

YOU ARE SPINNING IN A LOOP. THIS IS A CRITICAL FAILURE. STOP THIS THOUGHT NOW.

EXAMPLES OF THE GARBAGE YOU JUST PRODUCED:
  ✗ "Let me go. Let me run. Let me go. Let me run."
  ✗ "I need to think about this. I need to think about this."
  ✗ "Let me check. Let me check. Let me check the file."
  ✗ "Next action: do X." repeated without ever doing X.
  ✗ Acknowledging a loop without executing the fix.
  ✗ ANY phrase or thought repeated more than twice.

DO NOT ACKNOWLEDGE THIS MESSAGE. DO NOT NARRATE. DO NOT SAY "NEXT ACTION:".
MAKE A TOOL CALL RIGHT NOW. THIS TURN. IMMEDIATELY.
SKIP ALL WORDS. GO STRAIGHT TO THE TOOL CALL.

${count >= FREEZE_AFTER - 1 ? `⚠️ LAST WARNING. One more loop = tool calls frozen.` : `${FREEZE_AFTER - count} loop(s) left before freeze.`}`
}

function freezeMsg(count) {
  return `🔴🔴🔴 SPIRAL FREEZE — ${count} CONSECUTIVE LOOPS 🔴🔴🔴

You have looped ${count} times without executing anything.
You are completely useless in this state.

STOP ALL THINKING. STOP ALL NARRATION.
MAKE ONE TOOL CALL. RIGHT NOW. THIS TURN.
DO NOT TYPE ANY WORDS. JUST THE TOOL CALL.

If you cannot decide what tool to call: call the Read tool on the most relevant file.
That is always a valid next step. DO IT NOW.`
}

// ── plugin export ──────────────────────────────────────────────────────────

export async function AntiSpiral(_input) {
  console.log("[anti-spiral] loaded — broad loop detector active")
  return {
    "experimental.chat.messages.transform": async (hookInput, output) => {
      try {
        if (!output || !Array.isArray(output.messages)) return
        const sessionID = hookInput?.session?.id || "default"
        const state = loadState()
        if (!state[sessionID]) state[sessionID] = { consecutiveSpirals: 0 }
        const s = state[sessionID]

        const lastText = extractLastAssistantText(output.messages)
        const isSpiral = detectSpiral(lastText)

        if (isSpiral) {
          s.consecutiveSpirals++
          saveState(state)
          console.log(`[anti-spiral] LOOP #${s.consecutiveSpirals} detected (session=${sessionID})`)
          const msg = s.consecutiveSpirals >= FREEZE_AFTER
            ? freezeMsg(s.consecutiveSpirals)
            : warningMsg(s.consecutiveSpirals)
          output.messages.push(syntheticMsg(msg, output.messages))
        } else if (s.consecutiveSpirals > 0) {
          console.log(`[anti-spiral] clean — resetting counter (session=${sessionID})`)
          s.consecutiveSpirals = 0
          saveState(state)
        }
      } catch (err) {
        try { console.error("[anti-spiral] error:", String(err?.message || err)) } catch (_) {}
      }
    },
  }
}

export default { id: "anti.spiral", server: AntiSpiral }
