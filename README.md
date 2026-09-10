# anti-spiral.js

An opencode plugin that catches **genuine reasoning loops** — the same sentence, phrase
or line restated over and over instead of advanced — and redirects the agent back to
work. It is a nudge, not a straitjacket.

```
~/.config/opencode/plugins/anti-spiral.js
```

## Why this exists

Version 1 of this plugin fired on essentially every turn. It flagged any 2-word sequence
appearing three times (`ngramRepeat(words, 2, 3)`), any line of four characters appearing
three times, and any message where the unique-word ratio dropped below 0.25 — all measured
across **raw text including code fences and tool output**, where repeated lines are normal
and correct.

Two consequences, both fatal to the point of the plugin:

1. **It fired constantly.** An ordinary long technical answer trips every one of those
   checks. Code blocks, log dumps and tables trip the line checks by construction.
2. **Its counter only reset on a message that was not flagged.** So an agent that kept
   working kept escalating: the counter marched to `FREEZE_AFTER = 5` and then froze on
   every single turn, permanently. Worse, an agent that is *working* — calling tools,
   making progress — was frozen anyway, because the only thing that cleared the counter
   was a message that happened not to trip the detector.

The wording made it worse. The messages were shaming and absolute (`YOU ARE SPINNING IN A
LOOP. THIS IS A CRITICAL FAILURE.`, `You are completely useless in this state.`), which is
exactly the kind of text a capable model learns to classify as noise and ignore — an agent
in its own transcript can see it repeating identically every turn. The observed result was
an agent narrating *"The SPIRAL FREEZE block is injected noise — I should ignore its
demands and just do the work properly."* A guardrail that is always on is not a guardrail.

This is the rewrite: it fires on real loops, and it is silent otherwise.

## Install

```bash
cp anti-spiral.js ~/.config/opencode/plugins/
systemctl --user restart opencode-serve.service     # plugins are cached at serve boot
```

Editing a file under `plugins/` does **not** take effect until the server restarts. Confirm
the load by checking the log for a load failure (there should be none):

```bash
grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
```

The default export must carry the key belonging to the loader that reads the file — `server`
for the server, which scans `plugins/*.js`, and `tui` for anything listed in `tui.json`:

```js
export default { id: "anti.spiral", server: AntiSpiral }   // server-side only, by design
```

That is not cosmetic. The server loader throws `Plugin … must default export an object with
server()` when the key is missing, so a TUI-only plugin (a `tui` key and no `server`) dropped
into `plugins/` logs a load error on every boot and contributes nothing. This plugin has no
TUI half — it hooks a server-side transform — so `server` alone is what it should export.

## How detection works

Everything is measured on **prose only**. Fenced blocks, `~~~` blocks, inline code,
markdown table rows, list bullets and quote/heading markers are stripped first, because
code and logs repeat themselves for legitimate reasons. A line then has to look like prose
to count at all: at least six words, fewer than 18% symbol characters, more than 55%
letters.

Three checks, in order:

| # | Check | Fires when |
|---|---|---|
| 1 | Identical sentence | the same sentence (longer than 30 chars) appears twice **in a row** |
| 2 | Identical prose line | the same ≥6-word line appears **3×** or more |
| 3 | N-gram dominance | an n-gram for n=3..8 appears ≥3× **and** covers enough of the message |

Check 3 is the workhorse, and *coverage* is what separates a loop from ordinary writing
that reuses a phrase. An n-gram that simply appears three times in a long answer is not a
loop; an n-gram that appears three times and occupies most of the message is. Longer units
need less coverage, short units must dominate:

| n | required coverage |
|---|---|
| 8, 7, 6, 5 | 30% |
| 4 | 40% |
| 3 | 55% |

Messages shorter than `MIN_WORDS = 40` are never flagged, so a terse but repetitive
one-liner does not trip anything.

## The counter resets on progress, not on phrasing

This is the fix for the 24/7 freeze. If the assistant's last turn contained a **tool
call**, the loop counter clears immediately — regardless of how the text reads:

```js
const { text, usedTool } = lastAssistantTurn(output.messages)
if (usedTool) { /* clear the counter and return */ }
```

An agent that is calling tools is, by definition, not stuck, so it can never be frozen.
Only consecutive turns that produce **no tool call and repeating text** escalate.

**A turn is not one message.** opencode emits a step-start, the tool call, the tool
result, then a closing text message — all under the same turn, and only the last of them
is the assistant's text. The first version of this check looked at that last message
alone, so a tool call made earlier in the turn was invisible: an agent calling a tool in
every single turn still looked like it was narrating, and the counter marched to a freeze.
That was the bug behind the false freezes. `lastAssistantTurn()` now walks the whole turn
— every assistant message back to the preceding user message — and the turn counts as
work if **any** of them carries a tool call.

A turn is also counted **at most once**, keyed by the message id of the turn that was
judged. The transform can run twice for the same assistant message — a retried request, or
a second request issued before the model answers — and counting it twice would escalate a
single loop as if it were three. A turn that has already been judged is left alone.

## Escalation

| Consecutive loops | Injected |
|---|---|
| 1–2 | a redirect naming the exact repeated unit, with two concrete options: run the next step as a tool call, or — if the same step has now failed twice — change approach or state the blocker in one line |
| 3+ (`FREEZE_AFTER`) | a halt: narration is paused until a tool call happens, with three suggestions and an explicit "if you genuinely cannot proceed, say so in one sentence and stop" |

Both messages carry the **evidence** — which phrase, how many times, what share of the
message — so the agent can act on it instead of guessing what it did wrong. There is no
shaming language and no all-caps verdict, deliberately: text an agent learns to skim is
text that does not work.

The message is injected as a synthetic user message through `output.messages.push(...)`,
so it appears in the model's context without being written to the session's stored
history as a real turn.

## State

```
${ANTI_SPIRAL_STATE_DIR:-~/.local/share/opencode/anti-spiral}/state.json
```

```json
{ "v": 2, "sessions": { "<sessionID>": { "loops": 1, "lastMsg": "msg_abc", "t": 1757500000000 } } }
```

Keyed by session id, falling back to `"default"`. The `v` field is a version stamp: state
written by the old detector carries a counter that may already be at freeze, so an
unrecognised version discards it rather than inheriting its verdict. `ANTI_SPIRAL_STATE_DIR`
relocates the file (the test suite uses it to stay hermetic).

`lastMsg` is the message id of the last turn counted, which is what makes a retried turn
inert; `t` is when that session was last seen. Rows idle for more than `SESSION_TTL_MS`
(30 days) are dropped when the file is written, so the file does not accumulate one row per
session forever. Losing a row costs nothing — a counter is only meaningful for a
conversation that is still running — and a row written before `t` existed is kept rather
than deleted, so an upgrade does not reset every live session once.

## Tuning

At the top of `anti-spiral.js`:

| Constant | Default | Effect |
|---|---|---|
| `FREEZE_AFTER` | `3` | consecutive loops before the halt message |
| `MIN_WORDS` | `40` | messages shorter than this are never inspected |
| `STATE_VERSION` | `2` | bump to invalidate every stored counter |
| `SESSION_TTL_MS` | 30 days | idle session rows are dropped on write |

Coverage thresholds live in the `[8,7,6,5,4,3]` loop in `detectSpiral()`.

## Tests

```bash
node test/anti-spiral.test.mjs
```

20 cases, driving the real module through synthetic message arrays. The suite sets
`ANTI_SPIRAL_STATE_DIR` to a temp dir before importing, so it never touches a live
session's counters. `ANTI_SPIRAL_PLUGIN=/path/to/anti-spiral.js` points it at a different
copy (useful for testing an installed plugin against this suite).

It asserts both directions, which is the whole point:

- **must fire** — a phrase repeated 4×, an identical sentence repeated, a repeated
  reasoning stream.
- **must stay silent** — a code block with repeating lines, a log dump with 12 identical
  ERROR lines, prose that reuses common phrases, a short message, an empty message.
- **progress wins** — repetitive text that also contains a tool call is not flagged, and a
  loop → tool call → loop sequence restarts the counter at 1 instead of continuing to 2.
- **one turn, one count** — the same assistant message put through the transform twice (a
  retry) is counted once; the second pass injects nothing.
- **escalation** — turns 1 and 2 redirect, turn 3 halts.
- **stale state** — a counter written in the v1 schema does not leak in.
- **stale session rows** — a row idle past the TTL is dropped on write while a recent row
  and the row for the session being processed both survive.

Every case that guards a specific line of logic was checked by mutation: deleting the
same-turn guard or the pruning call fails exactly its own test and nothing else.

## Limitations

Worth being straight about, since the failure mode of this class of plugin is silent:

- **Only the last assistant turn is inspected.** A loop spread thinly across many turns
  with varying phrasing is not detected.
- **The halt is advisory.** It asks for a tool call; it cannot compel one. Nothing here can
  prevent a model from narrating further — it changes what the model sees, not what it can do.
- **Heuristics, not understanding.** A pathological message that repeats a long phrase three
  times for a legitimate reason (quoting a spec back, for instance) will be flagged. The
  message is a nudge, and the agent is free to disagree.
- **`experimental.chat.messages.transform` is an experimental opencode hook.** Built and
  verified against opencode 1.18.29; a change to that hook's contract would need a rewrite.
- **Verified by exercising the transform directly, not by catching a live loop.** The suite
  drives the real hook through the message shapes opencode hands it, and the running server
  is confirmed to load the plugin without error — but no real session has yet been observed
  looping under it. The counter file is where that shows up: a session row appears in
  `state.json` only once a turn has been judged to be looping.

## reference/

`reference/anti-spiral.v1.js` is the previous detector, kept verbatim so the behaviour
described under "Why this exists" can be read rather than taken on trust. It is **not**
loaded by anything — do not install it.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 ronisaguey-ux.
