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

## Option B — bounce the composition to one audio clip  ⏳ needs extension work

Bring the actual sequenced result (the thing Live can't easily reproduce) as a
single audio clip: the app renders the Strudel pattern to a WAV and hands *that*
audio to the extension.

Two pieces are required:

1. **Extension: accept provided audio.** Extend `SelectionItem` with an optional
   inline buffer and short-circuit rendering:
   ```ts
   // types.ts
   interface SelectionItem { …; wavBase64?: string; /* pre-rendered audio */ }
   // renderSource.ts::renderItemToWav
   if (item.wavBase64) return Buffer.from(item.wavBase64, 'base64');
   ```
   `injectClips` then imports it like any other WAV (a single item → one clip;
   `mode: 'tracks'` or `'arrangement'` both work). ~15 lines total. For large
   bounces, prefer a loopback-URL variant (mirror `refAudio.ts`'s local server) over
   base64 in the `close_and_send` payload.

2. **App: render Strudel → WAV.** Strudel has no one-call offline bounce, so the
   pragmatic v1 is **real-time capture**: tap the Strudel REPL's audio output into a
   `MediaStreamAudioDestinationNode`, record N cycles with `MediaRecorder`, decode →
   PCM → `encodeWavPcm16`. This needs a handle on Strudel's AudioContext/output node
   (via `<strudel-editor>`'s `editor.repl`) — the one unknown to verify at runtime.
   A deterministic offline bounce (query the pattern's events over a cycle range and
   schedule into an `OfflineAudioContext`) is the nicer follow-up.

The app already stubs the entry point ("→ Live (bounce)" button) so wiring is
localized once the capture handle is confirmed.

## Launching the composing app from Live

Both options need the extension to open *this* app rather than the `/ableton`
picker. Add a command + context-menu action that opens
`${COMPOSING_UI_URL}/?host=ableton` in a modal (same `showModalDialog` +
`close_and_send` handshake), e.g. `synthis.compose.tracks` / `.arrangement`. The
target (`InjectTarget`) is chosen exactly as the discovery commands already do.

## Recommendation

Ship **Option A** first (app side is done; extension side is just the launcher).
It exercises the whole loop and delivers the "raw sounds with correct settings"
use case immediately. **Option B** follows once the Strudel output tap is confirmed
— it's the higher-value "sequencing Live can't replicate" path, and the extension
change is tiny.
