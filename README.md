# anti-spiral.js

An opencode plugin that catches **genuine reasoning loops** — the same sentence, phrase
or line restated over and over instead of advanced — and stops them. A loop caught while
it is still streaming is cut off; a loop found in a finished turn gets a redirect with the
evidence. Ordinary technical writing, code, logs and tables are left alone.

```
~/.config/opencode/plugins/anti-spiral.js
```

## What a loop looks like

The failure this guards against is a model narrating the next step instead of taking it,
and then narrating it again:

```
Let me read rpc.py relevant parts.

Let me go.

Let me look at rpc.py.

Let me go.

Let me read.

Let me go.

Let me read.
…
```

Left alone, that stream runs until the provider's output-token limit — one observed case
was 26,669 characters of `Let me go. / Let me read.` repeated 1,006 times, inside a single
reasoning part. The earlier symptom is milder and easy to miss: a sensible, varied
reasoning stream punctuated by `Let me go.` between every thought, followed by one real
tool call. Both shapes are handled.

## How it works

Two independent layers.

### Layer 1 — mid-stream kill switch (`event` hook)

Every streamed `reasoning` / `text` part of an **assistant** message is watched through
`message.part.updated`. Once a part has 400 characters, and on every 200 characters of
growth after that, its tail is checked. When the tail is dominated by a repeated unit the
plugin:

1. calls `client.session.abort()` — the generation stops right there,
2. shows a TUI toast naming the repeated phrase,
3. sends a redirect as the next user message, so the agent resumes from its last real
   thought with one concrete action (the tool call it was about to make).

A spiral is cut at a few hundred characters instead of tens of thousands. A message is cut
at most once. User messages are never judged — pasting a loop into the prompt must not
abort your own session — and a part that has already finished is left to layer 2.

### Layer 2 — turn review (`experimental.chat.messages.transform`)

Before each request the previous assistant turn is judged: **all** reasoning and text in
it, back to the preceding user message. A loop injects a synthetic user message carrying
the evidence (which unit, how many times, what share of the text) and a short instruction:
take the next step as a tool call, or state the blocker in one line.

A tool call anywhere in the turn resets the **escalation** — an agent that is calling
tools cannot be halted — but a loop in that turn is still reported as a one-off redirect.
Three consecutive looping turns with no tool call escalate to a halt.

Session identity is read from the messages themselves (`info.sessionID`); the transform
hook's own input carries none. A turn is counted at most once, keyed by the assistant
message id, so a retried request does not count the same loop twice, and a turn the kill
switch already counted is not counted again here.

## Detection

Everything is measured on **prose only**. Fenced blocks, `~~~` blocks, inline code,
markdown table rows, list bullets and quote/heading markers are stripped first, because
code and logs repeat themselves for legitimate reasons. Mid-stream, an *unclosed* fence is
dropped from the fence onward, so a log being quoted is never judged before its closing
fence arrives.

Five checks, in order:

| # | Check | Fires when |
|---|---|---|
| 1 | Identical sentence | the same sentence (longer than 30 chars) appears twice **in a row** |
| 2 | Identical prose line | the same ≥6-word line appears **3×** or more (quotations exempt) |
| 3 | Stall tic | a sentence-shaped line of ≤4 words stands on its own ≥4× if it starts with "let me", ≥6× otherwise (`Hmm.`, `OK.`, `(Run.)`) |
| 4 | N-gram dominance | an n-gram for n=3..8 appears ≥3× **and** covers enough of the message (n≥5: 30%, 4: 40%, 3: 55%) |
| 5 | Tail dominance | the last 12 lines are all short with ≤4 distinct values, or one n-gram (n=2..10, ≥4×) covers ≥60% of the last 150 words |

Check 3 is the early warning: nothing legitimate repeats a four-word line that often.
Labels (`old:`), transcript prefixes (`user: …`), numbered lines (`step 3.`) and lines
where inline code was stripped out are excluded.

Check 4 is what separates a loop from prose that reuses a phrase: an n-gram that merely
appears three times in a long answer is normal; one that appears three times and occupies
most of the message is not. Longer units need less coverage.

Check 5 is what the mid-stream layer runs, together with the stall tic at a higher bar
(≥6× / ≥8× within the last 40 lines). A long message that is mostly fine and has
*degenerated* into a loop at the end is caught by the tail even when whole-message
coverage is low.

Layer 2 never inspects a turn shorter than `MIN_WORDS = 40`.

Replayed against 961 real assistant reasoning/text parts from a live session database: all
31 parts containing a known spiral are caught, and every additional flag examined by hand
was a genuine stall (`Let me run.` ×24, `Let me output.` ×31, `Hmm.` ×14).

## Escalation

| Situation | Injected |
|---|---|
| mid-stream cut | abort + toast + a redirect: "your previous response was cut off mid-stream … resume with ONE concrete action, emit the tool call directly" |
| loop, turn had a tool call | a non-escalating redirect (`loop 1/3`) naming the repeated unit |
| loops 1–2, no tool call | a redirect with the evidence and two options: act, or state the blocker in one line |
| 3+ consecutive (`FREEZE_AFTER`) | a halt: narration paused until a tool call happens |

Mid-stream cuts count toward the same counter, so repeated cuts without a tool call reach
the halt too. The messages are operational and always carry the evidence — an agent shown
the exact phrase it repeated can act on it; grandstanding gets skimmed as noise.

## Install

```bash
cp anti-spiral.js ~/.config/opencode/plugins/
systemctl --user restart opencode-serve.service     # plugins are cached at serve boot
```

Editing a file under `plugins/` does **not** take effect until the server restarts. Confirm
the load:

```bash
journalctl --user -u opencode-serve.service --since "5 min ago" | grep "anti-spiral"
#  [anti-spiral] loaded — loop detector v3 (mid-stream kill switch + turn review)
```

The default export must carry the key belonging to the loader that reads the file — `server`
for the server, which scans `plugins/*.js`:

```js
export default { id: "anti.spiral", server: AntiSpiral }
```

## State

```
${ANTI_SPIRAL_STATE_DIR:-~/.local/share/opencode/anti-spiral}/state.json
```

```json
{ "v": 3, "sessions": { "<sessionID>": { "loops": 1, "aborts": 0, "lastMsg": "msg_abc", "t": 1757500000000 } } }
```

Keyed by session id. `v` is a schema stamp: a file written by a different version is
discarded rather than inherited. `lastMsg` is the id of the last turn counted; `t` is when
the session was last seen. Rows idle for more than 30 days are dropped on write.
`ANTI_SPIRAL_STATE_DIR` relocates the file (the test suite uses it to stay hermetic).

## Tuning

| Constant | Default | Effect |
|---|---|---|
| `FREEZE_AFTER` | `3` | consecutive loops (turns or cuts) before the halt message |
| `MIN_WORDS` | `40` | turn-review minimum |
| `STREAM_MIN_CHARS` | `400` (env `ANTI_SPIRAL_STREAM_MIN_CHARS`) | mid-stream: text length before the first check |
| `STREAM_STEP` | `200` | mid-stream: re-check every N characters of growth |
| `TAIL_WORDS` / `TAIL_LINES` | `150` / `12` | size of the tail window |
| `STATE_VERSION` | `3` | bump to invalidate every stored counter |

Coverage thresholds live in the `[8,7,6,5,4,3]` loop in `detectSpiral()`; the tic
thresholds in `detectTic()`.

## Tests

```bash
node test/anti-spiral.test.mjs
```

39 cases driving the real module — the transform hook through synthetic message arrays, and
the event hook through a streamed sequence of `message.part.updated` events against a fake
client that records `abort` / `prompt` / `showToast` calls. Covers the real spiral shapes
(the 1006× stream; a 1,000-word reasoning ending in a short-line loop next to a tool call;
the same with a normal ending), session identity from messages, the mid-stream cut (fires
on the right session, once per message, never on a user message, never inside an open code
fence, never on a finished part, never on normal long reasoning), the
tool-call-does-not-hide-a-loop rule, one-turn-one-count, escalation, stale state and TTL
pruning — and, in the other direction, code blocks, log dumps, prose that reuses common
phrases, short and empty messages all staying silent.

`ANTI_SPIRAL_PLUGIN=/path/to/anti-spiral.js` points the suite at a different copy (useful
for checking an installed plugin).

## Limitations

- **The halt is advisory; the cut is not.** Layer 2 changes what the model sees. Layer 1
  actually aborts the generation — which also discards any tool call the model was about
  to emit after the loop. The redirect asks for exactly that tool call, so the cost is one
  wasted generation, but it is a real intervention and it is deliberate.
- **Heuristics, not understanding.** A message that legitimately repeats a short line six
  times will be flagged. The redirect is a nudge and the agent may disagree.
- **`experimental.chat.messages.transform` and the `event` payload shapes are opencode
  1.18.29 contracts.** A change to either needs a rewrite; the test suite pins both.
- **Mid-stream detection needs streamed part updates.** A provider/path that delivers the
  whole part in one update is only caught by layer 2, after the fact.

## reference/

`reference/anti-spiral.v1.js` is the original detector, kept for comparison. It is **not**
loaded by anything — do not install it.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 ronisaguey-ux.
