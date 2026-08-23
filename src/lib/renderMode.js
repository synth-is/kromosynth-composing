/**
 * Where on-demand renders happen: this browser, or the render socket server.
 *
 * Same three-way shape as the render-mode cogwheel in the web app's /ableton picker
 * (kromosynth-desktop AbletonPickerView), and persisted the same way, so the mental
 * model carries across the two apps.
 *
 *   auto   → server (see below)
 *   client → always render here (~300ms on a GPU; no server queue)
 *   server → always render on render.synth.is (one shared process; queues under load)
 *
 * WHY AUTO PREFERS THE SERVER, even though client rendering is much faster:
 *
 * The two engines don't agree. Browser rendering runs kromosynth's Web Audio graph;
 * the server runs its own worklet-offline reimplementation over node-web-audio-api.
 * Measured over kit genomes at 1.7s, one pair matched closely (correlation 0.98) while
 * another diverged badly (best correlation 0.57 at an 8ms offset, client 4.8× louder in
 * RMS). This is the known browser-vs-backend graph-engine axis the web app's
 * RenderParityTest exists to probe — it predates this app.
 *
 * That matters here specifically because a kit MIXES the two: keys at default settings
 * play the pre-rendered preview WAV, which is made server-side. Silently rendering
 * custom-duration keys in the browser would put two different engines in one
 * composition, and a saved piece could come back sounding different.
 *
 * So client rendering is a deliberate choice, not a default — the answer to "the render
 * server is bogged down right now". Flip auto → 'client' here once the two engines are
 * reconciled (or once previews are client-rendered too).
 */
import { hasGpu } from './browserRender.js';

export const RENDER_MODE_KEY = 'composing.renderMode';

export const RENDER_MODE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'client', label: 'This browser' },
  { value: 'server', label: 'Server' },
];

export const RENDER_MODE_HINTS = {
  auto: 'Uses the server, to match the pre-rendered previews the rest of the kit plays.',
  client: 'Renders here in ~⅓s — no server queue. Can sound different from the previews.',
  server: 'Renders on render.synth.is — shared with everything else running there.',
};

export function loadRenderMode() {
  try {
    const v = localStorage.getItem(RENDER_MODE_KEY);
    if (v === 'auto' || v === 'client' || v === 'server') return v;
  } catch { /* private mode / storage disabled */ }
  return 'auto';
}

export function saveRenderMode(mode) {
  try { localStorage.setItem(RENDER_MODE_KEY, mode); } catch { /* ignore */ }
}

/** Resolve a stored mode to the one actually used for a render: 'client' | 'server'. */
export function resolveRenderMode(mode) {
  if (mode === 'server') return 'server';
  // Without WebGPU the CPPN falls back to the CPU, which is slow enough that the shared
  // server wins even when it's busy — so honour the spirit of 'client', not the letter.
  if (mode === 'client') return hasGpu() ? 'client' : 'server';
  return 'server'; // auto — see the note at the top of this file
}
