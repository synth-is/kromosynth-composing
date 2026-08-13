# Bringing live-coding material into Ableton Live

Two ways to get from a composing-app session into a Live set. Both reuse the
existing kromosynth-live inject pipeline; one is essentially free, the other needs
a small extension addition.

## How the extension works today (verified)

- The extension opens a Synth.is web view at `…/ableton?host=ableton&backend=<ws|vi>`
  (`extension.ts::pickSounds`) and waits for the page to post a **Selection**:
  ```ts
  { version: 1, items: SelectionItem[] }
  SelectionItem = { soundId, evoRunId?, name?, duration?, noteDelta?, velocity?, genome? }
  ```
  via `window.webkit.messageHandlers.live.postMessage({ method: 'close_and_send', params: [json] })`
  (WKWebView) or `window.chrome.webview.postMessage(...)` (WebView2).
- For each item, `renderSource.ts::renderItemToWav` resolves
  `{ duration, noteDelta, velocity }` (defaults applied) and renders a WAV — either
  over the preview WebSocket (`ws`, fetch genome → render → `encodeWavPcm16`) or via
  the VI service (`vi`, quota pipeline). A pad-perturbed `genome` can be sent inline.
- `inject.ts::injectClips` imports each WAV and lays it into Live as Session clips,
  new tracks, filled track slots, or Arrangement clips (clip length derived from
  each item's `duration` at the song tempo).

The key fact: **`SelectionItem` already carries the per-sound render settings**, and
clip creation is driven by a provided WAV. That's exactly what both options need.

## Option A — send the kit as stems (with render settings)  ✅ app-side done

The most natural fit: the composing app returns its kit as `SelectionItem`s
(soundId + evoRunId + duration/noteDelta/velocity). The extension renders each with
those settings and lays them out — one clip/track per sound. The live-coding
sequencing itself isn't reproduced in Live; you get the raw materials, correctly
rendered, to re-sequence with Live's tools.

- **App side (implemented):** `src/lib/ableton.js::buildStemsSelection(kit)` +
  `sendToLive(...)`; the "→ Live (stems)" button appears when `host=ableton`.
- **Extension side:** needs only a way to *open the composing app* in Live (see
  "Launching" below). No change to `renderSource`/`inject`.

## Option B — bounce the composition to one audio clip  ✅ offline render (current)

Bring the actual sequenced result (the thing Live can't easily reproduce) as a
single audio clip: the app renders the pattern to a WAV and hands *that* audio to the
extension.

### How it renders: OfflineAudioContext, faster than realtime

`src/lib/offlineRender.js` renders the evaluated pattern through an
**`OfflineAudioContext`** and returns WAV bytes. Two earlier approaches were tried and
rejected — worth recording so they aren't re-attempted:

| approach | verdict |
|---|---|
| Tap superdough's master (`destinationGain`) + `MediaRecorder` | ❌ The `<strudel-editor>` component bundles **its own** superdough with its own AudioContext, so the tap was on a different, silent instance. Vite `resolve.dedupe` can't unify code already baked into a dependency's dist. |
| `getDisplayMedia({audio:true})` tab capture | ❌ The Screen Capture API isn't available in **embedded webviews** — and this UI runs inside Live's modal WebView (`showModalDialog`, WKWebView/WebView2). Also needs a permission prompt. |
| **OfflineAudioContext render** | ✅ Plain Web Audio (works in the WebView, no permissions), **faster than realtime** so minutes-long drones are practical, deterministic and cycle-accurate, and needs nothing from the editor's own audio engine. |

Upstream Strudel added non-realtime export in `@strudel/webaudio` (`renderPatternAudio`,
merged 2025-12-19, shipped in **1.3.0** — already the pinned version here, so no upgrade
was needed). We deliberately don't call it directly: it triggers a browser download and
returns nothing, while we need the bytes. `offlineRender.js` reimplements the same
approach with superdough's exported primitives and returns the WAV.

Mechanics: take the evaluated `pattern` + `cps` from the editor's scheduler
(`repl.scheduler.pattern` / `.cps`), create an `OfflineAudioContext` sized
`((toCycle - fromCycle) / cps) * sampleRate`, point **our** superdough instance at it,
re-register the kit samples there, schedule every hap in ascending onset order,
`startRendering()`, encode interleaved 16-bit WAV. Global audio state is restored in a
`finally`. Rendering on our own instance means live playback in the editor is untouched.

**UI:** `Bounce…` (start cycle / end cycle / sample rate, with a live seconds estimate)
→ **Download WAV** always, plus **→ Live** inside the extension.

### Engine-agnostic by design

`renderOffline` is an optional capability on the environment interface
(`src/lib/environments.js`). Strudel implements it via `OfflineAudioContext`; Csound and
WebChucK both have non-realtime rendering natively, so each future language supplies its
own implementation and the Bounce UI keeps working unchanged. This is a better boundary
than an app-owned shared AudioContext, since it doesn't require every engine to accept an
injected context.

### Extension side  ✅ done

`SelectionItem` gained an optional `wavBase64`, and `renderSource.ts::renderItemToWav`
short-circuits when it's present:
```ts
if (item.wavBase64) return Buffer.from(item.wavBase64, "base64");
```
`injectClips` then imports it like any other WAV (single item → one clip; `tracks` and
`arrangement` both work). `soundId` is a placeholder in this case.

### Known limitation: payload size for long bounces

Base64 inflates bytes ~33%, so a multi-minute WAV is impractical inline — the app
refuses above ~40 MB and downloads instead. **TODO:** accept a file path / loopback URL
(mirroring `refAudio.ts`'s local server) so length is bounded by disk, not string size.

## Launching the composing app from Live

Both options need the extension to open *this* app rather than the `/ableton`
picker. Add a command + context-menu action that opens
`${COMPOSING_UI_URL}/?host=ableton` in a modal (same `showModalDialog` +
`close_and_send` handshake), e.g. `synthis.compose.tracks` / `.arrangement`. The
target (`InjectTarget`) is chosen exactly as the discovery commands already do.

## Status

Both options are implemented app-side, and the extension accepts both shapes.
**Option A (stems)** needs the extension rebuilt with `SYNTHIS_COMPOSE_UI_URL` set (and
`SYNTHIS_PREVIEW_WS_URL=wss://render.synth.is` — the config fallback points at the stale
`preview.synth.is`). **Option B (bounce)** works via the offline render; only the
large-payload hand-off (file/URL instead of base64) remains as a TODO.

The now-unused realtime capture helper (`src/lib/bounce.js`) is superseded by
`offlineRender.js` and can be deleted.
