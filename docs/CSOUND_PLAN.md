# Csound (WASM) as a second environment

Status: **planned**. This is the handoff brief for adding Csound alongside Strudel.

The goal is not only "Csound runs". It is that someone who does not know Csound can
**learn it from inside the app**, through the same two surfaces we built for Strudel: the
pedagogical layer (Concepts palette, select-and-transform, Explain this) and the Ask-AI
layer, with the AI grounded in a Csound reference we derive from our own concept library.

---

## 1. Which distribution: `@csound/browser`

Use **`@csound/browser`**, the official package from the Csound project (source in
`csound/csound` under `wasm/browser`). It is what the Csound Web IDE
(<https://ide.csound.com>) uses, and it is documented at <https://csound.com/wasm/>.

Why it fits:

- AudioWorklet based (ScriptProcessorNode support removed), so it is current.
- It accepts **our** `AudioContext` and supports `autoConnect: false` plus an
  `onAudioNodeCreated` event, letting us place Csound in a custom graph. This matters for
  the offline bounce.
- Licensing is clean for us: `@csound/browser` dynamically loads `@csound/wasm-bin` at
  runtime and is therefore not subject to LGPL copyleft requirements. (We are AGPL anyway,
  so LGPL would be compatible regardless, but this keeps it simple.)

The alternative, **`gogins/csound-wasm`** (Michael Gogins, now part of his `cloud-5`
project), is a separate WebAssembly build that also bundles **CsoundAC**, his algorithmic
composition library. It is ported to Csound 7 with a Csound 6 compatible API and adds
conveniences such as reading files back out of the WASM memory filesystem. Worth revisiting
only if we later want CsoundAC's algorithmic composition inside the app. For playing kit
sounds and learning Csound, it is more surface area than we need.

```bash
npm install @csound/browser
```

```js
const csound = await Csound({ audioContext: ourCtx, autoConnect: false });
csound.on('onAudioNodeCreated', (node) => { /* route into our graph */ });
```

---

## 2. What already exists to plug into

Nothing here needs redesigning; the abstractions were built for this moment.

| Piece | Where | Note |
|---|---|---|
| Per-language interface | `src/lib/environments.js` | `id`, `label`, `docsUrl`, `sampleToken`, `hints`, `makeStarter`, `makeRandom`, `renderOffline` |
| Active environment | `App.jsx` `environmentId` state | One per composition; `unitState.environment` persists it |
| Per-environment timelines | `App.jsx` `trajectories` map | Already keyed by environment id |
| Shared kit | `App.jsx` `kit` + `getKitMap()` | Engine agnostic `name -> URL`; the whole point |
| Concepts / transforms / explain | `src/lib/concepts.js` | Registry keyed by environment id |
| AI editing | `src/lib/llm.js` + `docs/AI_EDIT_PLAN.md` | Reads the **active** environment's reference |

So the work is: one new environment object, one new concept list, one Csound editor
component, and the tabs UI.

---

## 3. The structural differences from Strudel (read this first)

These are the places where a straight copy of the Strudel approach will not work.

**a. Samples come from a virtual filesystem, not URLs.**
Strudel takes `samples({ name: url })`. Csound reads soundfiles by **filename** from its
WASM memory filesystem, so each kit entry must be fetched as an ArrayBuffer and written in
(`csound.fs.writeFile(...)` or equivalent) before the orchestra references it via
`diskin2` / `loscil` / `flooper2`. See the official
`webaudio-csound-samples-example` project for the pattern.
Implication: `getKitMap()` stays the same, but the Csound environment needs a
`prepareKit(kitMap)` step that materialises those files. Kit changes must re-sync.

**b. Code is an orchestra plus a score, not a single expression.**
The Strudel rule "only the last expression plays" has no Csound equivalent. Live coding in
Csound is typically `compileOrc()` of instrument definitions plus `readScore()` or
`schedule` events, with `evalCode()` for incremental changes. Steven Yi's
**csound-live-code** is the reference for idiomatic live coding here and is worth studying
before writing the concept list.
Implication: `makeStarter` returns a small complete orchestra plus a score that plays a kit
sound. The Play button compiles and starts; Stop calls the transport stop.

**c. Offline render is native and should be easier than Strudel's was.**
Csound renders non-realtime by design. Render to a file inside its memory filesystem and
read the bytes back out, then hand them to the existing bounce plumbing.
Implication: implement `renderOffline({ fromCycle, toCycle, sampleRate })` on the Csound
environment. Note the cycle vocabulary is Strudel's; for Csound, express the bounce range
in **seconds** and let the shared Bounce dialog adapt per environment (see section 6).
Everything downstream (WAV bytes, Download, the Ableton `wavBase64` hand-off) is unchanged.

**d. Do not repeat the module-instance trap.**
`src/lib/offlineRender.js` documents at length how superdough's dual dist/source packaging
silently produced cross-context audio nodes and a partially silent bounce. Read that header
before wiring Csound's audio graph. Keep Csound on one instance and one context.

---

## 4. Pedagogical layer for Csound

This is the part that makes the app teach, and it is the biggest single piece of work.
Add a `CSOUND_CONCEPTS` list to `src/lib/concepts.js` with the same shape as the Strudel
one: `{ id, category, label, explain, example(names), apply(selected)?, match?, quick? }`.

Same three surfaces come for free once the list exists:
Concepts palette (browse and insert), select-and-transform (wrap a selection), Explain this
(decode a selection).

Proposed categories, aimed at someone starting from zero:

- **Instrument basics**: `instr` / `endin`, `out` / `outs`, a-rate vs k-rate vs i-rate,
  `p` fields.
- **Playing your kit**: `diskin2`, `loscil`, `flooper2`, changing pitch and speed,
  playing a portion. This is the category to write first, because it connects Csound to the
  sounds the user already has.
- **Oscillators**: `poscil`, `vco2`, `foscil` (FM), noise.
- **Envelopes**: `linen`, `madsr`, `linsegr`, `expseg`.
- **Filters**: `moogladder`, `reson`, `butterlp` / `butterhp`, `tone`.
- **Effects**: `reverbsc`, `delayr` / `delayw`, `distort`, `chorus`.
- **Modulation**: LFOs with `lfo` / `poscil` at k-rate, `randomi`, `jspline`.
- **Score and events**: `schedule`, i-statements, `p3` durations, loops in the score.
- **Granular and spectral**: `grain3`, `partikkel`, `pvsanal` family (later; advanced).
- **Live coding**: recompiling instruments, `chnget` / `chnset` control channels, always-on
  instruments.

Two rules carried over from the Strudel work, both important:

1. **Write the explanations ourselves and generate examples from the user's kit.** We take
   the pedagogy (which concepts, in what order, what each does) and re-express it. We do not
   copy the Csound manual's prose. `docsUrl` links out for depth.
2. **Anchor to the bundled version.** The reference should describe the Csound that ships
   with our pinned `@csound/browser`, not the newest opcode in the manual, or the model will
   emit code the runtime rejects.

---

## 5. AI layer for Csound

`llm.js` already asks `buildReference(envId, kit)` for the active environment, so pointing
it at Csound is mostly a matter of the concept list existing. Then:

- **System prompt** needs Csound-specific framing: output a complete orchestra (and score
  where relevant), use the kit sample **filenames** as written into the FS, do not invent
  opcodes, target this Csound version. The Strudel prompt's "only the last expression plays"
  line must not leak across.
- **Validation and repair loop**: the Strudel pad exposes `validate(code)` and the AI does
  one repair pass on failure. Csound's `compileOrc` returns a status and errors arrive via
  the message callback, so the same loop applies. Wire `validate()` on the Csound pad to
  compile and collect messages.
- **Fit a sound in** (the `✦` button) transfers directly: describe the sound, then ask the
  model to weave it into the current orchestra.
- Keep the token ceiling and timeout from `llm.js`. Csound orchestras are longer than
  Strudel one-liners, so if 2048 output tokens proves tight, raise `MAX_TOKENS` for this
  environment rather than globally.

The intended learning loop, for someone new to Csound: browse **Concepts** to see what is
possible, insert an example built from your own sounds, hear it, select part of it and hit
**Explain this**, then ask the **AI** in plain English for the change you now know you want.
Every step lands as a trajectory snapshot, so the whole session is reversible and reviewable.

---

## 6. UI: environment tabs

Agreed shape:

- **Shared, above the tabs**: the sound browser (left column) and the **kit**.
- **Per environment, inside a tab**: editor, hints bar, Concepts, selection transforms,
  docs link, starter and surprise, offline bounce.
- **One active environment per composition.** Tabs switch `environmentId`. Multi-engine
  playback (Strudel and Csound sounding together) is explicitly out of scope for v1; it would
  mean reconciling two clocks and two graphs.
- Each environment keeps its **own trajectory** (already implemented).
- The **source link stays app level** in the header. It covers the whole app, not the
  Strudel part, so it must not move inside a tab.
- The Bounce dialog should ask the active environment what its range units are (cycles for
  Strudel, seconds for Csound). Add something like `bounceUnits` to the environment
  interface rather than hard-coding cycles in the dialog.

---

## 7. Suggested order of work

1. Spike: `@csound/browser` in the app, our `AudioContext`, `autoConnect: false`, compile a
   hard-coded orchestra, hear a sine. Confirm the worklet loads under Vite.
2. Kit into the FS: fetch kit URLs, write them in, play one with `diskin2`. This is the
   moment Csound becomes *ours* rather than generic.
3. `CsoundPad` component with the same imperative handle as `StrudelPad`
   (`getCode`, `setCode`, `play`, `stop`, `validate`, `getSelection`, `replaceSelection`).
   Reuse CodeMirror directly; there is no Csound equivalent of `<strudel-editor>`.
4. Environment object: `hints`, `makeStarter`, `makeRandom`, `docsUrl`
   (<https://csound.com/docs/manual/>), `bounceUnits: 'seconds'`.
5. Tabs UI, switching `environmentId`.
6. `CSOUND_CONCEPTS` in `concepts.js`, starting with "Playing your kit".
7. `renderOffline` via non-realtime rendering to the memory FS.
8. Point the AI at the Csound reference; tune the system prompt; verify the repair loop.

Steps 1 and 2 are the risk; the rest is filling in the shapes that already exist.

---

## 8. Spike results (steps 1 & 2)

Status: **both steps pass** — first run 2026-08-21, Chrome on macOS, `npm run start`
(dev server, `production-local` mode, against the production backends).

### What landed

| File | Role |
|---|---|
| `src/lib/csoundEngine.js` | the engine: one Csound instance, one AudioContext, kit → virtual FS, message log |
| `src/components/CsoundSpike.jsx` | dev-only surface at `?csound=1`; deleted when the tabs land (step 5) |
| `src/main.jsx` | three-line branch, dynamic import so the wasm stays out of the normal bundle |

Nothing in `environments.js`, `concepts.js` or `App.jsx` — those are steps 3–6.

### Decisions taken

- **Csound does not share Strudel's AudioContext.** `offlineRender.js` mutates
  superdough's module-level context during a bounce, so anything resolving its
  context through `getAudioContext()` can attach a worklet to a dead
  `OfflineAudioContext`. Same family as the module-instance trap. Csound owns its
  own context; v1 rules out simultaneous playback anyway (§6).
- **`initCsound()` memoises its promise**, so StrictMode's double-mount yields one
  engine rather than two fighting over the speakers (the `_adoptPromise` pattern
  from `api.js`).
- **Kit files live at `/kit/<name>.wav`.** `api.slugifySampleName` already limits
  names to `[a-z0-9_]{1,24}`, so they are FS-safe unchanged. `syncKit` diffs by
  URL, so a re-render at custom settings rewrites the same filename and user code
  keeps working.
- **Starter code omits `sr`**; the engine passes `--sample-rate` from
  `ctx.sampleRate`. A mismatched rate is a silently detuned render, so
  `compileAndStart` logs `getSr()` against the context rate every time.
- **No COOP/COEP on `composing.synth.is`.** Cross-origin isolation would break the
  CORS-open preview-WAV fetches and the spectrogram images unless every upstream
  response carried CORP. We take whichever threading path `@csound/browser` picks
  without SharedArrayBuffer.

### What the first run established

**The runtime is Csound 7, and it is a beta.** `@csound/browser` resolved to
`7.0.0-beta33`; `getVersion()` returns 7000 and the banner reads *Csound version 7.0
(double samples) 2026-08-12*, commit `ded5d15`, libsndfile 1.2.2. This is the
version anchor §4 rule 2 asks for, and it has teeth — see the `outs` note below.
Pin it **exactly** in `package.json` rather than with a caret: `^7.0.0-beta33`
satisfies any later beta and any 7.x release, so the opcode surface the AI is told
about could change under us without a lockfile change being obvious.

- **Loads under Vite unaided** — no `optimizeDeps.exclude` needed on the dev
  server. `npm run build` output is **not yet exercised**; that's still open.
- **No cross-origin isolation needed.** `crossOriginIsolated: false`,
  SharedArrayBuffer absent, and we still get a real `AudioWorkletNode`, connected
  to our own gain with `autoConnect: false`. Playback is clean. So the COOP/COEP
  decision above stands at no cost.
- **`--sample-rate` wins.** Banner: `sr = 48000.0, kr = 1500.000, ksmps = 32`;
  `getSr()` 48000 = AudioContext 48000. Audio buffered in 256-frame blocks. An
  orchestra with no `sr` line is the right shape.
- **`fs.mkdir` and `fs.writeFile` both exist and work.** `/kit/<name>.wav` is
  written and `diskin2` opens it: *48000 Hz, 1 channel(s), 192000 sample frames*.
- **Kit WAVs are mono, 48 kHz** (4.00 s previews here), as the header parse
  reported — so the single-output `diskin2` form is the one to teach, and
  `uniqueSampleName`'s dedup (`textural`, `textural_2`) survives into filenames
  unchanged.

**`outs` is deprecated in Csound 7** and warns on every compile. The concept
library, the starters and the AI reference must all teach `out aL, aR`. This is
exactly the trap §4 rule 2 exists to avoid: most Csound material online is 6.x, so
both a language model and a copied manual example will reach for `outs` by default.

Still open (never hit in this run): what `compileOrc` returns on a **bad**
orchestra and where the error text surfaces (that pair is `validate()` for step 8),
and whether `fs.readFile` exists for reading bounced bytes back out (step 7).

### Two behaviours to design around

**1. Performance ends when the score runs out.** — **fixed.** The sine's log ended
`B 0.000 .. 2.000 … end of Performance`: Csound stops rather than idling, which
would kill a live-coding session between edits. `compileAndStart` now always
`readScore`s a dummy `f 0 86400` ahead of the user's score, which holds the
instance up and allocates nothing. (`f 0 z` is the idiomatic "forever" form; plain
seconds avoid leaning on the magic value in a beta.) The user never has to know.

**2. Overlap clipped.** — **fixed.** The kit demo scheduled four hits 0.6 s apart
each lasting the full 4.00 s, so four peak-normalised voices summed: `overall amps:
2.07968`, 15352 samples out of range. Per-voice gain is now 0.2. Carry this into
the concept examples generally: every kit sound is peak-normalised, so anything
that layers them needs headroom. Csound's own out-of-range reporting is a good
teaching signal and the message log already surfaces it.

**3. Re-fetching the kit on every Play** — **fixed.** `reset()` invalidates the FS
bookkeeping, so each recompile re-downloaded the kit. Bytes are now cached in
memory keyed by URL; re-sync is a pure `writeFile`, logged as ` · cached`.

---

## 9. Step 3 — CsoundPad

Status: **run; the split bug found and fixed — see below.**

`src/components/CsoundPad.jsx`, exposing the same imperative handle App drives
StrudelPad through: `getCode`, `setCode`, `play`, `stop`, `reevaluate`, `isReady`,
`getSelection`, `replaceSelection`, `validate`. `getPattern` and `getCps` are
deliberately absent — cycles are Strudel's vocabulary, and App already calls both
optionally; the Csound bounce is native and in seconds (step 7 + `bounceUnits`).

**One buffer, orchestra + optional score.** The split marker is the real `.csd`
section tag `<CsScore>`, not something we invented, so what the user learns
transfers to actual Csound files. No tag = the whole buffer is the orchestra, which
is the live-coding case (define instruments, fire them with `schedule`).
`splitCsoundCode()` in the engine does this and is shared with step 7.

**CodeMirror 6 directly** (`codemirror` + `@codemirror/{state,view,language}` +
`theme-one-dark`), since there is no Csound equivalent of `<strudel-editor>`. The
dependency earns itself mainly on **line numbers**: Csound reports problems by line
("warning: opcode outs is deprecated, line 8"), so both learning and the AI repair
loop need them. `vite.config.js` dedupes `@codemirror/state` and `@codemirror/view`
— two copies produce "Unrecognized extension value", and `@strudel/repl` carries its
own CodeMirror in the same bundle.

Highlighting is a small hand-written `StreamLanguage`: comments, strings, numbers,
`.csd` tags, control keywords, p-fields, rate-typed variables. **Opcodes are
deliberately not listed** — once `CSOUND_CONCEPTS` exists (step 6) it can supply
that set, so the palette and the highlighter stay one list rather than two that
drift.

`validateOrc()` compiles without starting and reports `{ ok, error }`, taking both
`compileOrc`'s status and the error text from the message callback, since what a
beta returns on a bad orchestra is unverified. It resets the instance, so it stops
playback — acceptable because the AI loop plays immediately after. The spike's
**Probe validate()** button checks a deliberately broken orchestra and reports
whether the error was caught; that closes the last open question from §8.

### First run — what broke, and what it taught

**The starter played silence.** `splitCsoundCode` matched `<CsScore>` anywhere,
including inside the starter's own explanatory comment ("Everything above
`<CsScore>` is the ORCHESTRA"). The orchestra collapsed to the three header lines
and everything from `instr 1` down went to the SCORE parser — which read `instr`
as an i-statement followed by junk, and `endin` as its `e` end-statement, hence the
`sread:` cascade, the jump to "section 2", and `end of Performance`. Fixed: the tag
now has to be alone on its line. `splitCsoundCode` also strips `<CsoundSynthesizer>`
/ `<CsInstruments>` / `<CsOptions>` wrappers, since a model asked for Csound will
often emit a complete `.csd` (step 8); options are dropped because the engine owns
them.

**Silence was reported as success — twice over.** `compileAndStart` started happily
on an unparseable score, and `validate()` only ever checked the orchestra, so the
mangled buffer came back `ok`. Both now check the score: `readScore`'s messages are
scanned for `sread:` and a failure throws rather than starting a transport that
looks healthy and plays nothing. Same lesson as `offlineRender.js`'s header — the
dangerous failure is the one that looks fine.

The error scan (`collectErrors`) deliberately excludes `warning:` lines. Csound 7
warns about deprecated opcodes on every good compile, and the score failures
themselves emitted `warning: Internal error in print_input_backtrace()`, so a naive
`/error/i` match would fail valid buffers.

**Confirmed working:** keep-alive (no `end of Performance` on the sine), the byte
cache (` · cached`), and the gain fix (`overall amps: 0.20000`, zero samples out of
range). And `validate()` catches a bad opcode with line AND column — `syntax error,
unable to find opcode with name: nosuchopcode, line 6, columns 8-19` — which is
richer repair material for step 8 than Strudel's console-scraped errors.

### The engine module must not be hot-updated

The split fix appeared not to work: an identical `sread:` cascade, and
`compileAndStart` reaching `start()` when the new code would have thrown first. The
file on disk was correct — the page was running the previous build.

That is not just a reload people forget. `csoundEngine.js` holds an AudioContext,
an AudioWorklet and the single Csound instance in module state, so a hot swap
leaves the old Csound performing through the old node while a fresh module
instance (new maps, new `initPromise`) believes it owns everything — `offlineRender.js`'s
two-module-instances trap, except audible. It also runs stale engine code against a
live editor, which is how a fixed bug looked unfixed.

Two guards: `import.meta.hot.accept()` at the foot of the module forces a full page
reload on any edit to it, and `ENGINE_REVISION` prints to the console at module
evaluation and into the in-app log, so a stale module is visible at a glance. Bump
it when editing.

### Then

Step 5 (tabs). It is the larger diff: `App.jsx` hard-codes `s("${name}")` in
`copyToken` and the kit empty-state, passes literal `'strudel'` to
`conceptTransforms` and `ConceptsModal`, and `BounceDialog` is built in cycles
throughout — `bounceUnits` now exists to fix that last one.

---

## 10. Step 4 — the Csound environment object

Status: **runs.**

In `lib/environments.js`: `id`, `label`, `docsUrl`, `sampleToken`, `hints`,
`makeStarter`, `makeRandom`, `bounceUnits: 'seconds'`. `renderOffline` is absent
until step 7, which App already handles ("this environment can't bounce offline").
`bounceUnits: 'cycles'` added to Strudel for symmetry.

**`lib/csoundPaths.js` is new and exists for a bundling reason.** `environments.js`
and later `concepts.js` GENERATE CODE that names kit files, and App.jsx imports
both on every load — so importing `csoundEngine.js` there would pull
`@csound/browser` and its wasm into the main bundle for people who only open the
Strudel tab. The path constant lives in its own dependency-free module instead.

While splitting it out, the engine's `kitFilePath` lost its root-directory
fallback. It was defensive, but every generated snippet hard-codes the path, so a
path that could silently differ at runtime would break all of them at once. Missing
`fs.mkdir` now throws.

**`sampleToken` is the quoted path**, `"/kit/name.wav"` — what drops straight into
`diskin2`. (App's `copyToken` still hard-codes Strudel's `s("name")`; step 5.)

### On looping, and not making Csound into Strudel

A Strudel pattern repeats until stopped; a Csound score is a timeline that ends.
The temptation was to treat "plays four hits and stops" as a defect to hide. It
isn't — they are different instruments with different affordances, and the score's
finitude is a real property worth learning.

So `makeStarter` loops, but visibly and as a choice: `instr 99` lays out one bar
and its last line books itself again. The comment says deleting that line makes the
bar play once. Both behaviours are one edit apart and neither is presented as the
normal one. That also gives §4's "Score and events" and "Live coding" categories
their first concrete content.

The mechanism is self-rescheduling with `schedule`, not `metro` + `schedkwhen`.
Both are idiomatic; `schedule` was chosen because its signature is verified against
this build, and the starter is the first thing anyone presses Play on. Everything
in `makeStarter`, `makeRandom` and `hints` uses only opcodes this build has
actually run: `diskin2`, `linen`, `poscil`, `out`, `schedule`. Filters, reverb and
modulation wait for step 6, where they get validated before they reach a user.

### Then

Step 6 (`CSOUND_CONCEPTS`) — which now unblocks three things at once: the Concepts
palette, select-and-transform, and the Ask-AI bar, all of which read the same list.

---

## 11. Step 5 — environment tabs

Status: **runs.** Tabs switch, both pads survive switching, and neither bleeds
into the other's view.

Tabs sit between the kit and the trajectory bar. Above them (sound browser, kit)
is shared; below them everything belongs to the active environment, per §6. The
header's AGPL source link stays app-level.

**Both pads stay mounted; the tabs only toggle `display`.** StrudelPad's web
component is built once for the page's lifetime by design, and CsoundPad guards its
CodeMirror the same way — unmounting on a switch would leave a dead editor. The
consequence is that a single `ref` can't move between them, so `padRef` became a
plain object with a `get current()` that resolves to the active pad. That keeps
every existing `padRef.current?.x` call site correct instead of rewriting twenty of
them to thread an environment argument through.

Because the hidden pad is still live, `padEvents(id)` ignores `onEval` and
`onSelectionChange` from whichever pad isn't active — a leaked eval would otherwise
land in the wrong environment's trajectory.

**Switching stops the outgoing engine.** `padRef` still resolves to the old
environment at that moment, which is exactly the pad to stop.

### What stopped being Strudel-shaped

- `copyToken`, the kit chip tooltips, the "Added as" toast and the "fit a sound in"
  prompt all go through `env.sampleToken` — `s("name")` for Strudel,
  `"/kit/name.wav"` for Csound.
- `conceptTransforms` and `explainConcepts` take `environmentId`; `ConceptsModal`
  takes `envId`, and its MIDI device panel is Strudel-only.
- `HintsBar`'s hard-coded "only the last expression plays" moved into the
  environment as `tip`.
- `BounceDialog` reads `env.bounceUnits` and labels its fields cycles or seconds,
  showing the cps conversion only for cycles. `runBounce` takes `{ from, to }` and
  maps to `fromCycle`/`toCycle` or `fromSeconds`/`toSeconds`. The Bounce button is
  disabled when the environment has no `renderOffline` — Csound until step 7.
- `buildState` now saves `codes: { [envId]: buffer }` alongside the legacy single
  `code`, so working in one tab and saving doesn't discard the other. `handleOpen`
  restores both and falls back to `code` for older saves.

### The AI bar is off under Csound, on purpose

`buildReference()` returns `''` when an environment has no concept library, and
`hasConcepts()` gates the bar. A model asked for Csound without grounding falls back
on what it remembers, which is overwhelmingly 6.x material — `outs`, and opcodes
this beta has moved or removed. Better to say "not yet" than to ship a feature whose
output reliably fails to compile. It switches itself on when step 6 lands.

---

## 12. Getting Csound knowledge to the model

Reading `@csound/browser`'s own `index.d.ts` (the pinned 7.0.0-beta33) changed the
answer, and corrects two things §1 assumed:

- The package is **Apache-2.0**, not an LGPL question.
- The wasm is **inlined** into the 2.6 MB `dist/csound.js`; `@csound/wasm-bin` is a
  devDependency, not a runtime fetch. That is why it loaded under Vite unaided, and
  why there is no Node entry point to generate anything at build time.

Three capabilities in that API matter:

| | |
|---|---|
| `csoundUgenListOpcodes(factory)` | every opcode in the build as `{ opname, outypes, intypes }` |
| `libcsound()` | a synchronous Csound with **no AudioContext and no AudioWorklet** |
| `fs.readFile` | confirmed present — step 7's bounce can read WAV bytes back out |

`lib/csoundOpcodes.js` uses the first two: it spins a throwaway wasm instance,
lists the opcodes, destroys the instance, and memoises the result. Csound
describing itself.

### Why not RAG, and definitely not finetuning

`llm.js` is bring-your-own-endpoint with no backend and no shared key. You cannot
finetune the user's LM Studio; doing it would force a hosted model, contradict the
no-shared-key principle, and freeze knowledge at one Csound version.

RAG is possible but poorly matched: it means shipping a corpus into the browser or
standing up a service, and it is the option with the sharpest licensing exposure,
since it stores and re-emits source prose. The cheap substitute, if prompts get too
big, is two-stage prompting — ask the model which opcode families the request
touches, then inject only those slices. No embeddings, no vector store, works on any
endpoint.

### The layering

1. **Breadth** — the runtime opcode index. ~thousands of names with signatures. Too
   big for every prompt; right as an existence filter, as a nearest-name lookup when
   the compiler says `unable to find opcode with name: X`, and as a
   category-filtered slice per request.
2. **Teaching** — `CSOUND_CONCEPTS` (step 6), our own words, validated.
3. **Middle** — one-line descriptions we write for ~200 opcodes across families,
   bridging the index and the palette.

For the actual goal (surprises from features that are hard to find), breadth beats
depth: the model needs to KNOW `partikkel` and `sndwarp` exist far more than it
needs their manual pages. Correctness comes from the validate→repair loop, which
now has line-and-column errors plus `suggest()`. Grounding by correction rather
than by context stuffing.

This also suggests an action worth building: **surprise me with an opcode I haven't
used** — sample from a curated interesting-subset, ask the model to weave it into
the current orchestra, validate, repair. Quality-diversity applied to the opcode
space rather than the genome space.

### On the linked sources

The reference manual, the FLOSS Manuals book and the two personal tutorial sites are
separate rights situations and each needs its licence checked before anything is
ingested or redistributed. The distinction that matters: opcode names and argument
signatures are an API surface reported by the program, while the manual's
explanatory prose and its example `.csd` files are authored work. §4 rule 1 already
commits us to writing the explanations ourselves; the runtime index is how we get
the breadth without touching the prose.

### Generated code carries its own teaching

A standing rule, now in `environments.js`'s header. Starters, "surprise me",
concept examples and the code we ask the AI to produce should explain themselves in
comments: what each line does, and which number to change to hear something
different. The buffer is the main place someone learns the language; the docs link
is the fallback. `makeRandom` now generates comments describing the choices it
actually made — a surprise you can't read is just noise.

### Then (pedagogy)

Set `CSOUND_REFERENCE_VERSION` in `concepts.js` to the pinned `@csound/browser`
version, and carry two facts into the "Playing your kit" category (§4) and the AI
reference (§5): kit files are **mono**, and output is **`out`, never `outs`**.

---

## 13. Step 6 — the Csound concept library

Status: **34 concepts across ten categories; all compile against 7.0.0-beta33.**

Categories so far: Instrument basics, Playing your kit, Filters, Effects, Movement,
Function tables, Oscillators, Chords & arrangement, Spectral, Live coding, plus
three select-and-transform entries under Shaping a signal.

Every example is a COMPLETE playable buffer, because that is what `insertConcept`
replaces and what the pad plays — unlike Strudel's one-liners. And every one
comments itself (§12).

### The harness, and what it does not prove

The spike's **Validate all concepts** button compiles every example, and probes the
transform concepts by wrapping a real signal in `apply()` — that last part matters
because the transforms depend on Csound's functional call syntax
(`moogladder(aSig, 800, 0.3)`), which is confirmed working.

This is what makes §4 rule 2 enforceable rather than aspirational: re-run it after
any `@csound/browser` bump and the table says what broke.

**But a tick only means the compiler accepted it.** The comments make claims about
SOUND, and a wrong one is the failure mode that already bit us once — a generated
comment said a doubled playback rate made the note "half as long", which compiles
perfectly and is false (`p3` sets the length; the rate changes how far through the
file you get). So the results table has a ▶ per row that loads the example into the
pad and plays it. The ear pass is not optional.

Claims most worth hearing, because they are asserted rather than verified:

- `ftgen` + GEN01 is a HEADER-level statement, so it may run at `start()` rather
  than at `compileOrc` — a green tick may not prove the file loaded at all. That
  affects the three table concepts (`loscil`, `flooper2`, `mincer`).
- `mincer` decoupling time from pitch — the single most valuable claim in the
  library if true, since it turns a four-second evolved timbre into stretchable
  material.
- `pvsfreeze`'s two thresholds, and whether the ramp really does settle the sound
  into a chord.
- `i 100 0 -1` held alongside the engine's injected `f 0 86400`.
- `loscil`'s `ibas` of 1: correct arity, but the semantics only show up as pitch.

### The kit is mostly sustained textures, and examples have to account for it

The ear pass found one: the Echo example was inaudible. Not a wrong signature —
`vdelay` compiled and ran — but a wrong assumption. A 250 ms echo underneath a
four-second sustained texture just thickens it; you only hear a delay as a delay if
the source stops first. The example was written as though the kit contained drum
hits, and Synth.is genomes usually don't.

Fixed by giving the source a short `linseg` blip (0.25 s) inside a 2 s note, with
three decaying taps, so the repeats sound into silence. The general rule for the
rest of the library: **any time-based effect needs a transient source to be
legible**, and if an example depends on the material having an attack, it has to
manufacture one rather than assume it.

Worth re-checking the other time-domain examples against this: reverb reads fine on
a texture (it is heard as space rather than as repeats), but anything that relies on
hearing a copy — flanging, comb filtering, granular density — will have the same
problem.

### Still to write

Granular proper (`grain3`, `partikkel`), spectral morphing between two kit sounds,
MIDI. Then: build "surprise me with an opcode I haven't used" — the point at which
the 2346-name index starts earning its keep in the other direction.

---

## 14. Grounding the repair loop, and a bundle regression

### `suggest()` is wired in

`CsoundPad.enrichError()` matches `unable to find opcode with name: X` and appends
the nearest real names from this build's index. It applies to BOTH paths:
`validate()` (so the AI's repair prompt carries the neighbours, since App feeds
`check.error` straight into it) and `play()` (so a human typo gets the same help in
the status line).

The asymmetry worth noting: correcting on failure costs one memoised index build,
whereas putting thousands of opcode names into every prompt costs tokens on every
request and still wouldn't guarantee the model picks a real one. Grounding by
correction scales better than grounding by context.

Failures in the index are swallowed — it's a nicety, and must never break
validation.

### The threshold matters more than the ranking

First try, `arpeggiate` came back with `create, reinit, release, prepiano, specfilt,
spechist`. Raw edit distance always returns *something*, and none of that is a
suggestion — it's the closest strings in a 2346-name corpus to a word that isn't a
typo of anything. In a repair prompt that is actively harmful: the model treats a
suggestion as authoritative and may well reach for `prepiano`.

`suggest()` is now strict — a candidate must be within a length-scaled edit distance,
share a four-character stem, or contain/be contained by the query. Two real cases
survive that: a fumbled name (`moogladder2` → moogladder) and a stem (`reverb` →
reverbsc, nreverb). An invented CONCEPT returns nothing, and the message says so
and points back at the grounded technique list instead.

General principle for the AI layer: a wrong suggestion costs more than no
suggestion, because the model cannot tell them apart.

### Why `@csound/browser` is pinned exactly

`"7.0.0-beta33"`, no caret. Three things are anchored to that exact build: the 34
concept examples the harness validated, `CSOUND_REFERENCE_VERSION` in `concepts.js`,
and the opcode index the repair loop corrects against. A caret on a prerelease
matches every later beta AND 7.x stable, so a fresh `npm install` months from now
could change the opcode surface under all three without any visible change here.

The cost is that fixes don't arrive on their own. That is the intended trade: a
bump should be deliberate, and it has a procedure.

**Bumping the dependency:** change the version, `npm install`, then in the spike
rebuild the opcode index and run **Validate all concepts**; fix whatever turns red;
update `CSOUND_REFERENCE_VERSION`; and audition anything whose behaviour (not just
its arity) might have shifted.

### Bundle regression from step 5, fixed

Step 5 imported `CsoundPad` statically into `App.jsx`, which pulls
`@csound/browser` — 2.6 MB with the wasm inlined — into the main bundle for
everyone, including people who only open the Strudel tab. That is exactly what
`lib/csoundPaths.js` exists to prevent (§10), undone without noticing.

Now `React.lazy` + `Suspense`, mounted the first time the Csound tab is selected or
a saved Csound composition is opened. The "both pads stay mounted" rule is
unaffected: it requires never UNmounting, not mounting both up front.

Two consequences that needed handling, both easy to get silently wrong:

- `handleOpen` could `setCode` on a null ref and lose the buffer. Codes for an
  unmounted pad now park in `pendingCodesRef` and are applied by that pad's
  `onReady`.
- `padReady` gated the `?seq` deep link on BOTH pads being ready, which would never
  happen if Csound was never loaded. It now waits for Csound only if Csound was
  actually pulled in.
