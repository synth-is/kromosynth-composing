# Testing wclap-rack bundles — plugin preset + Strudel

2026-11-09. How to try a saved rack configuration (a `*.wclap-rack.tar.gz` — rack.json +
MANIFEST.json + sha256-pinned WCLAP archives; spec in `~/Developer/apps/WCLAP/wclap-rack/SPEC.md`)
in the two places built tonight:

1. the **Synth.is plugin / Standalone app** (the rack is one instrument = one preset), and
2. **Strudel on composing.synth.is** (`note("c3").s("wclap-rack").rack(url)`).

Example bundle used below: `~/Developer/apps/WCLAP/wclap-rack/examples/synth-fx-rack/synth-fx-rack.wclap-rack.tar.gz`
(Aether plays C4 → WetChorus → Pearls).

## A. In the Synth.is plugin / Standalone app

### Build (once; JUCE's first compile dominates — 15–40 min)

Use the canonical **`scripts/build.sh`** — it reads the signing identity from the keychain and
knows verify-vs-install (see its header comment):

```sh
cd ~/Developer/apps/synth.is/kromosynth-plugin
bash scripts/check-deps.sh                                              # preflight
KROMOSYNTH_WCLAP_HOST=ON scripts/build.sh                               # verify: compiles, installs NOTHING
KROMOSYNTH_WCLAP_HOST=ON scripts/build.sh install --adhoc               # sign ad-hoc + install AU/VST3/Standalone
```

- `KROMOSYNTH_WCLAP_HOST=ON` turns on the wclap-bridge + `WclapEngine`/`WclapRack` code
  (`-DSYNTHIS_WCLAP_HOST=ON`); without it the rack code is compiled out entirely. The script now
  forwards that env var (patched 2026-11-09; previously the spike used the raw cmake flag,
  docs/PLUGIN_WCLAP_HOST_SPIKE.md).
- **Fastest loop**: `KROMOSYNTH_WCLAP_HOST=ON scripts/build.sh` (verify) then run the Standalone
  binary straight from the build dir — no install, no host restart:
  `open build/verify-nocopy/KromosynthPlugin_Standalone/*.app` (path varies; `find build/verify-nocopy -name '*.app'`).
- For DAW testing: `install` copies the AU to `~/Library/Audio/Plug-Ins/Components` — **restart
  the host afterwards**, AU caches component scans. Use `--backup` to keep the current bundle.
- Wasmtime 48.0.1 is a downloaded prebuilt tarball, not a Rust build (`cmake/Wasmtime.cmake`);
  the bridge itself is fetched+patched at configure time (`cmake/WclapBridge.cmake`).

### Prepare the rack as an instrument

The plugin's instrument library on macOS is `~/Music/Synth.is/Instruments`. Unpack the rack
bundle there (rack.json + MANIFEST.json + extracted `bundles/<key>/`):

```sh
node ~/Developer/apps/WCLAP/wclap-rack/tools/unpack-rack.mjs \
  ~/Developer/apps/WCLAP/wclap-rack/examples/synth-fx-rack/synth-fx-rack.wclap-rack.tar.gz \
  "$HOME/Music/Synth.is/Instruments/my-rack"
```

(`unpack-rack.mjs` verifies every MANIFEST sha256 and refuses on mismatch.)

### Run

- Open the **Standalone** app (or load the AU/VST3 in a DAW — Ableton Live works; the plugin is
  `IS_SYNTH` with MIDI in).
- The instrument list should show `my-rack` (kind `wclap-rack` — detected by `rack.json`).
- Select it and play a MIDI note (or the plugin's test-note button): you should hear Aether's C4
  through chorus + granular delay. The status log lines show `kind=wclap-rack devices=3`.
- **Preset check**: change a device param isn't exposed yet (editor UI is the known gap) — instead
  verify save/load: save the host session (or the plugin preset) in the DAW, reload it, and the
  rack's state blob (`wclapRackState` = rack.json + per-device clap.state) restores the sound.
- Logs: `instrument_load id=my-rack kind=wclap-rack ok=1 devices=3 …`.

Known gaps (see `kromosynth-plugin/docs/WCLAP_RACK_PRESET_2026-11-09.md`): no per-device editor UI
yet; no headless fingerprint comparison vs the JS reference host (needs the bridge built locally
— do that on the Studio).

## B. In Strudel — locally and on composing.synth.is

The package `@kromosynth/strudel-rack` (packages/strudel-rack) is wired into this project:
`src/lib/rackSounds.js` self-installs at import (App.jsx imports it), registering the sound
`wclap-rack` and the pattern method `.rack(cfg)` (alias `.wclaprack()`) into the editor's Strudel
instance after prebake — same pattern as `faustInstruments.js`.

On **composing.synth.is** (after deploy of this change) the REPL buffer reads:

```js
note("c3 e3 g3").s("wclap-rack").rack('/racks/synth-fx-rack.wclap-rack.tar.gz')
```

Quoting matters in the REPL: double-quoted strings are mini-notation (use them inside
`note(...)`/`s(...)`), but `.rack(...)` needs a plain string, so the bundle URL goes in
**single quotes** — `.rack("/racks/…")` hands the method a Pattern instead of a string.
(`.rack()` unwraps a single constant string pattern, so even a double-quoted URL that survived
as one constant still works.)

The bundle is fetched, sha256-verified against its MANIFEST, and rendered in ONE AudioWorklet
node per rack URL, shared by every hap (a node per hap re-instantiates every bundle's wasm per
note and OOMs the renderer's wasm memory — measured: the 2nd node fails in a busy page).
Per-hap gain is applied on per-hap gain nodes fanned out from the shared node, so per-note
`.lpf()/.pan()/.room()` still compose around it. In an offline bounce (the app's "Bounce…"
button) the rack is rendered per note with the reference host's `renderRack` and played as a
buffer source.

Verified 2026-11-09 with `npm run start` (http://localhost:5273), the example bundle copied to
`public/racks/synth-fx-rack.wclap-rack.tar.gz`, pattern
`note("c3 e3 g3 c4").s("wclap-rack").rack('/racks/synth-fx-rack.wclap-rack.tar.gz')`:

- live: exactly 1 `wclap-rack` worklet node for the whole pattern, audio out of it
  (RMS ≈ 0.024, peak ≈ 0.058 at the default cps);
- offline bounce (cycles 0–2, 48 kHz): 8 haps, 0 skipped, WAV peak ≈ 0.067, RMS ≈ 0.015 —
  matches the reference host's direct `renderRack` output for the same notes.

**Locally** (dev server), serve a rack bundle and use its URL, or the self-contained test page:

```sh
# from the wclap-rack repo: serve the apps tree
node ~/Developer/apps/WCLAP/wclap-rack/tools/serve.mjs 8139 /Users/bjornpjo/Developer/apps
# test page (mock Strudel scope, plays the bundled example through the voice):
open http://127.0.0.1:8139/synth.is/kromosynth-composing/packages/strudel-rack/test/
# or the full assembler/test host:
open http://127.0.0.1:8137/test-host/?bundle=/examples/synth-fx-rack/synth-fx-rack.wclap-rack.tar.gz
```

In the composing dev server (`npm run dev` in kromosynth-composing) the bundle must be reachable
by URL — drop it under `public/` or serve it from anywhere and pass the absolute URL to `.rack()`.

## C. Command-line (no browser)

```sh
cd ~/Developer/apps/WCLAP/wclap-rack
node --test tests/*.test.mjs                 # conformance + source-device harness (10 tests)
node tools/validate.mjs --bundle examples/synth-fx-rack
node tools/render.mjs  --bundle examples/synth-fx-rack --seconds 2 --out /tmp/rack.wav --json
node tools/pack-rack.mjs examples/synth-fx-rack --out /tmp/out.wclap-rack.tar.gz
```

`render.mjs` prints per-device latency and a determinism-checked fingerprint — compare with the
plugin's render later (the pending headless check).

## Field notes 2026-11-09 (Standalone crashes on rack load, being fixed)

If a rack crashes the Standalone on click, rebuild with the current WclapRack.cpp (fixes: settle
process chunked at the activated max block; process() holds its lock for the whole call; per-device
port channel counts) via KROMOSYNTH_WCLAP_HOST=ON scripts/build.sh. To get a precise stack if it
still crashes, build a Debug verify tree and run under lldb:

  cmake -S . -B build/verify-debug -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Debug -DKROMOSYNTH_BUILD_SAMPLER=ON -DKROMOSYNTH_BUILD_FAUST=ON -DKROMOSYNTH_COPY_AFTER_BUILD=OFF -DSYNTHIS_WCLAP_HOST=ON
  cmake --build build/verify-debug --target KromosynthPlugin_Standalone -j $(sysctl -n hw.ncpu)
  lldb -- build/verify-debug/src/KromosynthPlugin_artefacts/Debug/Standalone/Synth.is.app/Contents/MacOS/Synth.is
  (lldb) run            # click the rack in the app
  (lldb) bt full        # paste this if it still crashes
