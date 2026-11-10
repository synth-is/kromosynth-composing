# @kromosynth/strudel-rack

Play **wclap-rack bundles** — saved rack configurations from Synth.is / the wclap-rack test host:
an optional `source` instrument plus a serial chain of WCLAP audio effects — from Strudel patterns.

```js
await installRack();   // after the editor's prebake (globalThis.registerSound must exist)

note("c3 e3 g3").s("wclap-rack").rack('/racks/synth-fx-rack.wclap-rack.tar.gz')
note("c3").s("wclap-rack").rack({ format: 'wclap-rack', version: 1, ... })   // parsed rack.json + bundles via loadRackBundle
```

## Driving module parameters from the pattern: `.rp()` + `.lfo()`

Each WCLAP module in the rack (the source and every device) can be addressed from Strudel by
**module id + param name** — exactly what the rack viz shows (click a param name there to copy
its target). `.rp(target, value)` (alias `.rackparam`) sets the param per hap, from a value or a
pattern; Strudel's `.lfo()` modulates it:

```js
// static per-hap value (the value may be a pattern: "5 40" splits per note)
note("c3 e3").s("wclap-rack").rack('/racks/synth-fx-rack.wclap-rack.tar.gz')
  .rp('org.faust.aether/detune_cents', "5 40")

// object form sets several at once
note("c3").s("wclap-rack").rack(url).rp({ 'org.faust.aether/detune_cents': 12, 'studio.opendaw.commons.wet-chorus/Speed': 2 })

// LFO on a rack param — explicit target:
note("c3").s("wclap-rack").rack(url).rp('org.faust.aether/detune_cents', 30)
  .lfo({ c: 'org.faust.aether/detune_cents', rate: 3, depthabs: 25 })       // rate in Hz, depthabs absolute
// or implicit: .lfo() with no `c` modulates the control set just before it — the .rp() target:
note("c3").s("wclap-rack").rack(url).rp('org.faust.aether/detune_cents', 30)
  .lfo({ rate: 3, depthabs: 25, shape: 'sine' })                           // shape: tri|sine|ramp|saw|square

// per-note envelope on a rack param (same implicit/explicit `c` rule as .lfo):
note("c3").s("wclap-rack").rack(url).rp('org.faust.aether/cutoff', 300)
  .env({ a: 0.05, d: 0.2, s: 0.1, r: 0.3, depthabs: 15000 })   // ADSR; sustains until note-off, then releases
```

Target forms: `'module.id/param_name'` (the device's CLAP plugin id, as in the viz row — for
params whose name repeats inside a plugin, e.g. several `depth`, use
`'org.faust.aether/osc2/depth'`), `'0/param'` / `'-1/param'` / `'source/param'` (device index;
-1 / `source` = the source instrument), or a bare `'param_name'` when exactly one slot has it.
In the REPL use **single quotes** for targets and the rack URL (double-quoted strings become
mini-notation); double quotes only for value patterns like `"5 40"`.

Semantics match superdough's own modulators: an `.lfo()` adds to the param's current value
(`depth` is relative to it, `depthabs` absolute, default `dcoffset -0.5` centers the swing),
`sync` instead of `rate` is tempo-synced (`sync * cps`); an `.env()` is an ADSR (`a`/`d`/`s`/`r`,
`acurve`/`dcurve`/`rcurve`, same depth rules) that sustains until note-off, then releases. The
result is clamped to the param's declared min/max. Live, the worklet runs the modulator itself
from the audio clock (one param event per 128-frame block — sample-accurate timing, no
main-thread jitter), and the param returns to its base value when the hap ends. In the offline
bounce the same curve is rendered as param events, so bounce matches live. Strudel's third
modulator, `.bmod()`, needs an audio-rate bus, which a wasm param cannot tap — a `.bmod()` aimed
at a rack target is stripped with a warning (use `.lfo()`/`.env()` instead). Unknown targets
warn once and are ignored (like strudel-faust's `.fp`); the worklet answers bad param ids with a
`paramError` message instead of crashing the audio thread. Page-side helpers:
`resolveRackTarget(rack, info, target)`, `listRackTargets(rack, info)`,
`queryRackParam(rackSpec, index, paramId)` (current base/modulated value, for viz/debug).

**Viz sync (two-way).** The worklet pushes live param values to the page — a `paramValue` message
on every applied `param` (so slider drags echo back clamped), and `paramValues` on each meter
tick for params with active modulators plus any changed param. The rack viz panel feeds these
into the sliders: sliders track `.rp()`/`.lfo()`/`.env()` changes from the code (an LFO visibly
animates its slider, marked amber), and dragging a slider sends `param` and the echo updates the
slider to the clamped value. While you are dragging, your drag value wins over the live one.

**Examples** (also in the app's Concepts palette under "WCLAP racks"):

```js
const rack = '/racks/synth-fx-rack.wclap-rack.tar.gz';
note("c3 e3 g3 c4").s("wclap-rack").rack(rack)
  .rp('org.faust.aether/detune_cents', "0 12 24 45")            // per-note param values

note("c2").slow(2).s("wclap-rack").rack(rack)
  .rp('org.faust.aether/cutoff', 500)
  .lfo({ rate: 0.5, depthabs: 4000, shape: 'saw' })             // filter LFO (implicit target)

note("c3 e3 g3 e3").s("wclap-rack").rack(rack)
  .rp('org.faust.aether/cutoff', 200)
  .env({ a: 0.05, d: 0.4, s: 0.2, r: 0.5, depthabs: 8000 })     // per-note filter envelope

note("c3").slow(2).s("wclap-rack").rack(rack)
  .rp({ 'studio.opendaw.commons.wet-chorus/Speed': 5, '1/Size': 0.6 })   // object form, device ids
  .lfo({ c: 'studio.opendaw.commons.wet-chorus/Speed', rate: 0.25, depth: 0.8 }) // explicit target
```

- `.rack(cfg)` is a pattern method installed on `Pattern.prototype` (alias `.wclaprack`), storing the
  rack spec (archive URL, `{ rack, bundles }`, see `loadRackBundle`) on the hap value — same pattern as
  `@kromosynth/strudel-faust`'s `.fp()`. `.rp(target, value)` (alias `.rackparam`) is installed the same
  way and stores per-hap rack param values on the hap value (see "Driving module parameters" above).
- The sound `"wclap-rack"` renders one AudioWorklet node per hap (`src/rack-worklet.js` over the
  vendored wclap-rack reference host in `src/vendor/wclap-rack/`), so per-note `.lpf()`, `.pan()`,
  `.room()` still compose around it. Source racks get note on/off from the hap's frequency/duration.
- In an `OfflineAudioContext` (Strudel's bounce) the rack is rendered offline via the reference host's
  `renderRack` and played as a buffer source.
- Bundles are sha256-verified against the MANIFEST before loading (reference host's
  `validateRackBundle`); a mismatch throws.
- Register twice if the page has two Strudel instances (editor + app), exactly like `faustSounds()` —
  see `src/bindings.js`.

## Test

```sh
node test/node-tests.mjs     # LFO math, target resolution, offline render with param events
node tools/serve.mjs 8139 /Users/bjornpjo/Developer/apps   # from the wclap-rack repo; any static server works
# open http://127.0.0.1:8139/synth.is/kromosynth-composing/packages/strudel-rack/test/
```

The test page installs the module with a mock Strudel scope, plays the bundled
`test/assets/synth-fx-rack.wclap-rack.tar.gz` (Aether source + WetChorus + Pearls) through the voice,
and reports RMS — see `test/index.html`. `test/node-tests.mjs` covers the `.rp()`/`.lfo()`/`.env()`
machinery without a browser: the LFO/env math against superdough's reference processors,
`resolveRackTarget` against the bundled rack, and offline `renderRack` with param events
(static + time-varying).

`docs/WCLAP_RACK_TESTING.md` is the end-to-end testing log: plugin/Standalone, this package in the
composing app (live + bounce + rack viz + native device views), and the wclap-rack CLI — including
how each surface was verified in the browser.

## Licence

AGPL-3.0-or-later (matches @kromosynth/strudel-faust). The vendored `src/vendor/wclap-rack/` reference
host is MIT (wclap-rack repo); the WCLAP bundles you load keep their own licences — the MANIFEST pins
them and `validateRackBundle` verifies the bytes.
