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

Version 2 fixed that and then missed a real one. On 2026-09-10 a DeepSeek session produced
a 26,669-character reasoning stream that was `Let me go. / Let me read.` repeated **1,006
times**, ending only when the provider hit its output-token limit. v2 never logged a word,
for three reasons that are each fixed in v3:

1. **It could not see a generation in flight.** Its only hook, `chat.messages.transform`,
   runs *before the next request*. A spiral inside one response is invisible to it until
   that response ends, and nothing it does can shorten one.
2. **A tool call anywhere in the turn cleared everything.** The spirals before the big one
   were 5×, 16×, 20× in reasoning streams that then emitted one `read` — "progress", so no
   redirect, ever. The habit grew unchecked from 5× to 1006×.
3. **Coverage was measured over the whole message.** A 1,000-word reasoning that ends in 20
   short looping lines has 16% coverage. Invisible. The loop is what the text *degenerates
   into*, so the tail has to be judged on its own.

It also keyed every session under the name `"default"`, because the transform hook's input
is `{}` in opencode 1.18 and `hookInput.session.id` was always undefined.

## What v3 does

Two independent layers:

**Layer 1 — mid-stream kill switch** (`event` hook). Every streamed `reasoning`/`text`
delta of an *assistant* message is watched (`message.part.updated`). When the tail of the
stream is dominated by a repeated unit, the plugin calls `client.session.abort()` right
there, shows a TUI toast, and sends a redirect as the next user message so the agent resumes
from the last real thought with one concrete action. A spiral is cut at a few hundred
characters instead of tens of thousands. User messages are never judged (a user pasting a
spiral into the prompt must not abort their own session), and a message is cut at most once.

**Layer 2 — turn review** (`experimental.chat.messages.transform`). Before each request the
previous assistant turn — *all* reasoning and text in it, back to the preceding user
message — is judged. A loop injects a redirect with the evidence. A tool call in the turn
still resets the **escalation**, but the loop is still reported as a one-off redirect that
cannot escalate on its own. Three consecutive looping turns with no tool call halt.



## Install

```bash
cp anti-spiral.js ~/.config/opencode/plugins/
systemctl --user restart opencode-serve.service     # plugins are cached at serve boot
```

Editing a file under `plugins/` does **not** take effect until the server restarts. `openbot`
(the launcher in this setup) restarts the serve automatically when the installed plugin is
newer than the running process, and prints which detector version loaded. Confirm by hand:

```bash
journalctl --user -u opencode-serve.service --since "5 min ago" | grep "anti-spiral"
#  [anti-spiral] loaded — loop detector v3 (mid-stream kill switch + turn review)
```

The default export must carry the key belonging to the loader that reads the file — `server`
for the server, which scans `plugins/*.js`:

```js
export default { id: "anti.spiral", server: AntiSpiral }
```

## How detection works

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

Check 3 is the early-warning one. In every real spiral examined it was the first symptom: a
varied, sensible reasoning stream punctuated by `Let me go.` between thoughts, before it
collapsed into pure repetition. Nothing legitimate repeats a four-word line that often.
Labels (`old:`), transcript prefixes (`user: …`) and numbered lines (`step 3.`) are
excluded.

Check 5 is what the mid-stream layer runs on every 200 characters of growth once a part has
400 characters, together with the stall tic at a higher bar (≥6× / ≥8× in the last 40
lines).

Messages shorter than `MIN_WORDS = 40` are never inspected by layer 2.

Replayed against 961 real assistant reasoning/text parts from this machine's session
database: all 31 parts containing a known spiral are caught, and every additional flag
examined by hand was a genuine stall (`Let me run.` ×24, `Let me output.` ×31, `Hmm.` ×14).

## Escalation

| Situation | Injected |
|---|---|
| mid-stream cut | abort + toast + a redirect: "your previous response was cut off mid-stream … resume with ONE concrete action, emit the tool call directly" |
| loop, turn had a tool call | a non-escalating redirect (`loop 1/3`) naming the repeated unit |
| loops 1–2, no tool call | a redirect with the evidence and two options: act, or state the blocker in one line |
| 3+ consecutive (`FREEZE_AFTER`) | a halt: narration paused until a tool call happens |

Mid-stream cuts count toward the same counter, so repeated cuts without a tool call reach
the halt too. A turn is counted **at most once** (by assistant message id), and a turn the
kill switch already counted is not counted again by the turn review.

## State

```
${ANTI_SPIRAL_STATE_DIR:-~/.local/share/opencode/anti-spiral}/state.json
```

```json
{ "v": 3, "sessions": { "<sessionID>": { "loops": 1, "aborts": 0, "lastMsg": "msg_abc", "t": 1757500000000 } } }
```

Keyed by the session id read from the messages' `info.sessionID`. `v` is a version stamp:
state written by an older detector is discarded rather than inherited. Rows idle for more
than 30 days are dropped on write.

## Tuning

| Constant | Default | Effect |
|---|---|---|
| `FREEZE_AFTER` | `3` | consecutive loops (turns or cuts) before the halt message |
| `MIN_WORDS` | `40` | turn-review minimum |
| `STREAM_MIN_CHARS` | `400` (env `ANTI_SPIRAL_STREAM_MIN_CHARS`) | mid-stream: text length before the first check |
| `STREAM_STEP` | `200` | mid-stream: re-check every N characters of growth |
| `TAIL_WORDS` / `TAIL_LINES` | `150` / `12` | size of the tail window |
| `STATE_VERSION` | `3` | bump to invalidate every stored counter |

## Tests

```bash
node test/anti-spiral.test.mjs
```

39 cases driving the real module — the transform hook through synthetic message arrays, and
the event hook through a streamed sequence of `message.part.updated` events against a fake
client that records `abort`/`prompt`/`showToast` calls. Covers: the three real spiral shapes
from the 2026-09-10 session (the 1006× stream, a 1,000-word reasoning ending in a short-line
loop next to a tool call, the same with a normal ending), session identity from messages,
the mid-stream cut (fires on the right session, once per message, never on a user message,
never inside an open code fence, never on a finished part, never on normal long reasoning),
the tool-call-does-not-hide-a-loop rule, one-turn-one-count, escalation, stale state and
TTL pruning.

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

`reference/anti-spiral.v1.js` is the previous detector, kept verbatim so the behaviour
described under "Why this exists" can be read rather than taken on trust. It is **not**
loaded by anything — do not install it.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 ronisaguey-ux.
