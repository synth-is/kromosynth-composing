/**
 * Bridge to the kromosynth-live Ableton extension.
 *
 * When the extension opens a Synth.is web view it appends `?host=ableton` and
 * waits for a `close_and_send` postMessage carrying a Selection:
 *
 *   { version: 1, items: SelectionItem[] }
 *   SelectionItem = { soundId, evoRunId?, name?, duration?, noteDelta?, velocity?, genome? }
 *
 * The extension then renders each item to WAV (honouring duration/noteDelta/
 * velocity) and lays them into Live as clips/tracks. So exporting the kit as
 * *stems with their render settings* maps onto the existing pipeline directly —
 * no extension change needed for that path.
 *
 * (See docs/ABLETON_BRIDGE.md for the composition-bounce path, which needs a
 * small extension addition plus rendering Strudel to audio.)
 */
import { isDefaultSettings } from './render.js';

export function isAbletonHost() {
  try {
    if (new URLSearchParams(window.location.search).get('host') === 'ableton') return true;
  } catch { /* ignore */ }
  return !!(window.webkit?.messageHandlers?.live || window.chrome?.webview);
}

/** Kit → the Selection payload the extension expects (stems, with settings). */
export function buildStemsSelection(kit) {
  const items = (kit || []).map((k) => {
    const it = { soundId: k.soundId };
    if (k.name) it.name = k.name;
    if (k.evoRunId) it.evoRunId = k.evoRunId;
    const s = k.settings;
    if (!isDefaultSettings(s)) {
      if (s.duration != null) it.duration = s.duration;
      if (s.noteDelta != null) it.noteDelta = s.noteDelta;
      if (s.velocity != null) it.velocity = s.velocity;
    }
    return it;
  });
  return { version: 1, items };
}

/** Post a Selection back to the host extension and close the modal.
 *
 * `resume` carries the signed-in token and the current composition id. Live opens
 * each modal in a FRESH WebView with an ephemeral data store, so localStorage
 * (where the JWT lives) does not survive between opens — without this you'd have
 * to sign in again every time. The extension keeps it for the session and hands
 * it back on the next open as `#token=…` / `?seq=…`, which the app already knows
 * how to consume (adoptTokenFromHash / the ?seq deep link).
 */
export function sendToLive(selection, resume) {
  const payload = resume && (resume.token || resume.seq) ? { ...selection, resume } : selection;
  console.log('[ableton] sending to Live:', {
    items: payload.items?.length ?? 0,
    signedIn: !!resume?.token,
    seq: resume?.seq || '(none)',
    resumeIncluded: !!payload.resume,
  });
  const msg = { method: 'close_and_send', params: [JSON.stringify(payload)] };
  if (window.webkit?.messageHandlers?.live) {
    window.webkit.messageHandlers.live.postMessage(msg);
  } else if (window.chrome?.webview) {
    window.chrome.webview.postMessage(msg);
  } else {
    // Not inside Live — useful for testing the payload in a normal browser.
    console.warn('[ableton] no host bridge found; would send:', payload);
    return false;
  }
  return true;
}
