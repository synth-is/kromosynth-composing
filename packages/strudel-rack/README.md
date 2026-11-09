# @kromosynth/strudel-rack

Play **wclap-rack bundles** — saved rack configurations from Synth.is / the wclap-rack test host:
an optional `source` instrument plus a serial chain of WCLAP audio effects — from Strudel patterns.

```js
await installRack();   // after the editor's prebake (globalThis.registerSound must exist)

note("c3 e3 g3").s("wclap-rack").rack("/racks/synth-fx-rack.wclap-rack.tar.gz")
note("c3").s("wclap-rack").rack({ format: 'wclap-rack', version: 1, ... })   // parsed rack.json + bundles via loadRackBundle
```

- `.rack(cfg)` is a pattern method installed on `Pattern.prototype` (alias `.wclaprack`), storing the
  rack spec (archive URL, `{ rack, bundles }`, see `loadRackBundle`) on the hap value — same pattern as
  `@kromosynth/strudel-faust`'s `.fp()`.
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
node tools/serve.mjs 8139 /Users/bjornpjo/Developer/apps   # from the wclap-rack repo; any static server works
# open http://127.0.0.1:8139/synth.is/kromosynth-composing/packages/strudel-rack/test/
```

The test page installs the module with a mock Strudel scope, plays the bundled
`test/assets/synth-fx-rack.wclap-rack.tar.gz` (Aether source + WetChorus + Pearls) through the voice,
and reports RMS — see `test/index.html`.

## Licence

AGPL-3.0-or-later (matches @kromosynth/strudel-faust). The vendored `src/vendor/wclap-rack/` reference
host is MIT (wclap-rack repo); the WCLAP bundles you load keep their own licences — the MANIFEST pins
them and `validateRackBundle` verifies the bytes.
