# @kromosynth/strudel-faust

Play evolved Faust instruments from Strudel patterns — live, and in the offline
bounce, from one genome.

```js
await faustSounds({ bellish: dspSource });
```
```js
note("c3 e3 g3").s("bellish").fp({ cutMul: "<2 6 12>" }).lpf(900).room(.4)
```

Status: **built, unwired.** Every module is written and the measurements that
decide its shape are done (see [Measurements](#measurements)). It is not yet
called from anywhere in kromosynth-composing.

---

## Why this is not a sample kit

kromosynth-composing already delivers evolved sounds to Strudel as rendered
buffers, registered with `samples({ name: url })`. That works, and for the
CPPN+DSP substrate it is the right answer. For the Faust substrate it throws
away most of what the genome is.

A Faust genome from `kromosynth/faust-genome/` is a **voice**, not a recording:
`faustGenomeToDSP(genome)` emits a self-contained program declaring `freq`,
`gain` and `gate` — the three widget labels Faust's polyphonic engine binds by
name — plus every slider the seed declared. `bakeSliders` writes the evolved
values as those sliders' *initial* values and leaves them as `hslider`
declarations, so they are still live at runtime.

What that buys, none of which survives a pre-render:

- **Note length comes from the pattern.** `gate` holds while the hap sustains,
  so `.clip(2)` on a pad genome actually holds instead of replaying a fixed
  render.
- **Per-note parameter values**, with no re-render and no recompile — just a new
  node from a warm factory.
- **Genome swaps per event.**
- **Live signal through superdough's effects chain**, rather than effects on a
  frozen one.

The genome's own evolved sliders are the interesting part. Patterning `cutMul`
or `damp` from a Strudel expression is live exploration of exactly the parameter
space `param-mutation.js` searches over as the inner rate of the two-rate
architecture. That is not an analogy; it is the same vector.

## Measurements

Everything below was decided by measurement rather than by preference. Run
`measure/` again on any machine where the timing feels wrong.

Chrome, macOS, 48 kHz, `baseLatency` 5.3 ms, `outputLatency` 24.0 ms —
2026-08-27, on the default test voice in `measure/measure.js`:

| what | result |
|---|---|
| cold compile | 28 ms |
| `createNode`, warm factory, n=50 | **0.10 ms** median, 0.10 ms p90, 5.90 ms max (first call, `addModule`) |
| gate: deferred to the audio clock | 0.94 ms mean, **0.17 ms spread** |
| gate: fired on arrival, no deferral | 1.03 ms mean, **5.33 ms spread** |
| gate: `AudioBufferSourceNode.start(t)` (floor) | 0.02 ms mean, 0.00 ms spread |
| 32 concurrent voices | created + gated in 5.7 ms |
| live vs offline render, matched rate | peak ratio **1.000**, diff rms **0** |

What each one settled:

**Node construction is free**, so a per-note mono node is the default. Had it
not been, the default would have had to become one shared polyphonic node —
which cannot be a `registerSound` at all, because superdough builds a fresh
effects chain per event and one source feeding all of them would stack gain — so
the whole public API would have been a pattern method in the `@strudel/csound`
style, without per-note `.lpf()`, `.pan()` or `.room()`.

**Deferring the gate is worth it.** Same mean either way; the difference is
spread, 0.17 ms against 5.33 ms. Firing "now" from the main thread lands at a
random point inside the 2.67 ms render quantum. Firing from a
`ConstantSourceNode`'s `onended` lands in the same place every time. The
remaining ~0.92 ms is a constant, so `voice-live.js` subtracts it
(`setGateLatency` to retune).

**Live and offline agree exactly** at a matched sample rate — the same block
sequence from the same initial state. So the clip that reaches Ableton is not
close to what was played, it is the same samples.

Two caveats. These were measured one voice at a time on an idle main thread;
under a dense pattern the deferred callback can be delayed, and the 5.33 ms tail
of the undeferred arm is roughly what main-thread variance looks like here.
Treat 0.17 ms as a floor. And the agreement test ran at 48 kHz on both sides —
at a mismatched rate the two will not be sample-identical and should not be,
since Faust recomputes its constants per rate.

## Two backends, one instrument

```
                      ┌── live: FaustMonoAudioWorkletNode, deferred gate
  one .dsp source ────┤
                      └── offline: createOfflineProcessor, block-driven gate
```

Selected inside a single `registerSound` callback, by context type:

```js
return ctx instanceof OfflineAudioContext
  ? renderOfflineVoice(args)
  : createLiveVoice(args);
```

The offline path is not a degraded copy. On accuracy it is *better*: driving
`compute()` in blocks puts the gate and every slider on a known block boundary,
which the live path cannot do.

**It is also not optional.** `docs/ABLETON_BRIDGE.md` option B — the bounce that
produces the clip the Live extension injects — renders through
`src/lib/offlineRender.js`, i.e. an `OfflineAudioContext`. Without the offline
backend a composition using Faust instruments would bounce to silence exactly
where those events are. Two earlier bounce approaches were already tried and
rejected (a MediaRecorder tap on superdough's master, and `getDisplayMedia` tab
capture); the offline render is the one that works inside Live's WebView.

The offline voice renders until the tail decays rather than to a fixed length,
so a pluck and a genome with a four-second reverb cost what they cost, and
neither gets an audible truncation.

## Why the live path needs a scheduler at all

`faustwasm`'s `FaustAudioWorkletNode.setParamValue` posts the value over the
MessagePort and writes the AudioParam only as a dead write — its own source
says `// Set value on AudioParam (but this is not used on Processor side for
now)`. `keyOn` and `keyOff` are `postMessage` too.

So a Faust worklet has **no sample-accurate gate**. `gate.setValueAtTime(1, t)`
means nothing. Strudel hands `onTrigger` an absolute future `t`, so the only way
to honour it is to hold the message until the audio clock reaches `t` — which is
what `src/schedule.js` does, with a `ConstantSourceNode`'s `onended` rather than
`setTimeout` (the audio clock does not drift against itself and is not throttled
in a background tab).

A consequence worth stating plainly: **there is no audio-rate modulation of a
Faust slider from Strudel.** `.fp({ cutMul: sine.range(2,8).slow(4) })` gives one
value per event, which is ordinary Strudel behaviour, but it is not a modulation
signal. Continuous mid-note modulation would mean either posting parameter
messages on a timer (crude) or compiling a genome variant whose modulation
target is an audio *input* rather than an `hslider`. The second is interesting
and is a different piece of work.

## The pattern surface, and why it has this shape

### `faustSounds(map, options)`

```js
await faustSounds(
  { bellish: dspSource, thump: dspSource2 },
  { deps: { registerSound, getAudioContext, getFrequencyFromValue, Pattern, reify } }
);
```

A map of name → `.dsp` **source string**, mirroring `samples({ name: url })`
deliberately: the host app already knows that shape, and the Strudel pad already
prepends kit registration at play time, so Faust instruments slot into the same
place with the same lifecycle. Names are lowercased and whitespace becomes `_`,
because superdough's `registerSound` does that to its keys regardless.

`deps` is not decoration. A page embedding `<strudel-editor>` has **two**
Strudel instances and a sound registered in one is invisible to the other:

- `@strudel/repl`'s own build inlines core, webaudio and superdough (its
  `vite.config.js` has `external` commented out), so `resolve.dedupe` cannot
  unify it with the app's copy.
- The way into the editor's instance is `globalThis` — `prebake` calls
  `evalScope(import('@strudel/webaudio'), ...)`, and `evalScope` assigns every
  export onto `globalThis`. That is what `deps` defaults to.
- The **app's** instance is what `offlineRender.js` renders the bounce on, and
  it needs the same registration. Pass its imports in explicitly.

So `faustSounds` gets called twice, exactly as `samples(kitMap)` is called twice
today: once into the editor scope before play, once into the app's instance
before a bounce. This is the same fact that made a MediaRecorder bounce record
silence, written down as an API instead of as a bug.

### `s("bellish")` rather than `.faust("bellish")`

`@strudel/csound` registers a pattern method, because Csound owns its own output
(`setOption('-odac')`) and its audio never enters superdough. A Faust worklet is
an ordinary `AudioNode`, so it can be a **sound source** instead:
`registerSound` hands the node to superdough, which then wires gain and
velocity, filters, vowel, coarse/crush/shape/distort, pan, phaser, delay, room,
bus, orbit and analyser around it. `note("c3 e3").s("bellish").lpf(800).room(.4)`
needs no code on our side.

Registering as a source also means the bounce works, patterns compose normally,
and there is no second scheduling path to keep in step.

### `.fp({ name: value })` rather than one control per slider

```js
note("c3 e3 g3").s("bellish").fp({ cutMul: "<2 6 12>", q: 4 })
note("c3").s("bellish").fp('cutMul', "<2 6>")     // pair form, single quotes
```

Two design constraints produced this signature, and both are worth knowing
before changing it.

**Slider names collide with Strudel's own controls.** The obvious alternative —
introspect the instrument and register a top-level control per slider, so you
could write `.cutMul(...)` — fails on the seeds themselves. Every seed in
`kromosynth/faust-genome/seeds.js` declares `gain`, and most declare `lvl`, `q`,
`res`, `drive`, `att`, `dec` or `rel`. `gain` and `drive` are existing Strudel
controls and several others are one rename away from becoming one. Shadowing a
Strudel control with a per-instrument one would break patterns silently and
differently for each genome loaded, which is the worst available failure mode. A
namespaced accessor keeps the genome's parameter space in its own namespace,
where a name means whatever the seed says it means.

**The object form leads because it survives the transpiler.**
`@strudel/transpiler`'s mini plugin rewrites *every* double-quoted string
literal into a mini-notation pattern — `plugin-mini.mjs` checks nothing more
than `node.raw[0] === '"'`. So in the REPL, `.fp("cutMul", "<2 6>")` hands the
function a `Pattern` where a name was meant. An identifier key in an object
literal is not a `Literal` node, so `.fp({ cutMul: … })` is immune by
construction, while the values still get patterned, which is what you want. The
pair form works with single quotes, and a double-quoted *constant* is unwrapped
rather than rejected, since that case is unambiguous; anything with real pattern
structure gets an error explaining the quoting.

The rest of the behaviour:

- **Values clamp to the declared range** from the Faust descriptor
  (`min`/`max`/`init` come out of the compiled JSON), so a pattern cannot drive
  a slider outside the bounds its own genome was evaluated within.
  `ve.moog_vcf` going non-finite *inside* its declared range is already a known
  hazard here; driving outside it is not worth discovering live.
- **Unknown names warn once and are ignored**, rather than throwing. Faust
  prunes widgets that reach no output, so a structural mutant legitimately loses
  sliders its siblings have. A pattern written for one elite should degrade on
  another, not stop. The warning lists what the instrument does have.
- **`freq`, `gain` and `gate` are not reachable through `.fp()`.** They are the
  note. Naming one warns once and is ignored.
- Calls **chain**: `.fp({a: 1}).fp('b', 2)` keeps both.

`faustSliders(name)` returns what a registered instrument actually exposes.

### Velocity, and note length

Velocity goes to Faust's `gain`, because that widget *is* the MIDI velocity
binding by Faust convention, and an evolved instrument's response to it may be
anything but linear. Note that superdough also scales by velocity, so a
patterned `.velocity()` applies twice; `.gain()` is the single-application
control, and `velocityToGain: false` leaves the Faust widget at 1 and lets
superdough own level entirely.

Note length comes from the hap, not from the genome's `gateOffRatio` render
hint. That hint exists for fixed-length previews and exports; inside a pattern,
the pattern owns time. `.clip()` and `.legato()` work as usual.

## Layout

```
src/
  index.js         faustSounds(), registerFaustSound(), .fp, public surface
  bindings.js      reaching a Strudel instance without importing one
  compiler.js      libfaust singleton, factory cache, live nodes, offline processors
  params.js        descriptor plan, range clamping, warn-once on unknown names
  voice-live.js    per-note worklet node, gate deferred to the audio clock
  voice-offline.js block-driven render for the bounce
  schedule.js      fire a callback on the audio clock
measure/
  index.html       the measurement page
  measure.js       the four measurements
  tap-worklet.js   pass-through + onset timestamps + level + capture
```

## Not done yet

- **Nothing calls it.** The app-side adapter (fetch genome → `faustGenomeToDSP`
  → `faustSounds`) and the two call sites in `StrudelPad.jsx` and
  `offlineRender.js` are not written.
- **Re-measure jitter under load**, with a real pattern running.
- **Confirm the bounce at a mismatched sample rate** (44.1 kHz session, 48 kHz
  render). The envelope should match even though the samples will not.
- No offline render cache. A repetitive pattern re-renders identical notes;
  keying on source + freq + duration + params would pay for itself.

## Design rules

**The input is a `.dsp` string, always.** No genome type crosses this boundary,
and nothing here imports `kromosynth`. Genome deserialisation, CPPN activation
and slider baking stay upstream in `kromosynth/faust-genome/`, where they
already are. This is what makes the package independently useful, testable
without an evolution run, and extractable later.

**It never imports from the host app's `src/`.** It lives inside
kromosynth-composing today for the single dev loop, wired in with
`"@kromosynth/strudel-faust": "file:./packages/strudel-faust"`. It moves to its
own repo the moment a second consumer appears — most likely kromosynth-desktop —
and that move is a `git mv` plus flipping `private` in `package.json`.

**faustwasm arrives by URL or by injection, never by bare import.** It generates
AudioWorklet processor source with `${ClassName.name}` + `${ClassName
.toString()}`, so any minifier renames those classes to identifiers that do not
exist inside `AudioWorkletGlobalScope`. kromosynth-composing's `vite.config.js`
already serves the unprocessed bundle at `/vendor/faustwasm/index.js` and marks
it external; a host that already owns a libfaust instance
(kromosynth-desktop's `faustBrowser.js`) hands it in with
`setFaustWasmModule()` rather than loading 7.6 MB twice. The dynamic import goes
through a `Function` body so Vite's import-analysis cannot rewrite the URL —
`import(variable)` gets `?import` appended, which the dev middleware 404s on and
which would also key a second copy of the module.

## Licence

AGPL-3.0-or-later, matching Strudel and kromosynth-composing.
