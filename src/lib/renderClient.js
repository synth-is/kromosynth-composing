/**
 * On-demand genome rendering for the composing app.
 *
 * Two interchangeable back ends, chosen by the render mode (see renderMode.js):
 *
 *  - SERVER — the preview-WebSocket render the Ableton extension also uses:
 *      → { type:'render', genome, duration, noteDelta, velocity, useGPU:true, batch:true, requestId }
 *      ← { type:'batch-result', sampleRate }   (JSON header)
 *      ← <binary Float32 mono payload>          (clip-protected, not peak-normalised)
 *    One shared process (render.synth.is), so renders queue behind everything else
 *    running on that machine.
 *
 *  - CLIENT — the same kromosynth engine running here, in an OfflineAudioContext.
 *    See browserRender.js.
 *
 * Result is encoded to a WAV blob URL so Strudel's samples() can load it — which
 * makes custom per-sound render settings (duration/pitch/velocity) *audible* in the
 * live-coding session, not just in the Ableton stems export.
 *
 * Genomes come from the recommend service (resolves all sound types by id).
 */
import { RECOMMEND_URL } from './api.js';
import { encodeWavPcm16, declickForDelivery } from './wav.js';
import { renderInBrowser } from './browserRender.js';
import { loadRenderMode, resolveRenderMode } from './renderMode.js';

export const PREVIEW_WS_URL =
  import.meta.env.VITE_PREVIEW_WS_URL || 'ws://localhost:3000';

const RENDER_TIMEOUT_MS = 120_000;

export async function fetchGenome(soundId, evoRunId) {
  let url = `${RECOMMEND_URL}/api/exploration/genome/${encodeURIComponent(soundId)}?format=raw`;
  if (evoRunId) url += `&evoRunId=${encodeURIComponent(evoRunId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch genome ${soundId}: HTTP ${res.status}`);
  return res.json();
}

/** Render a genome to mono Float32 audio over the preview WebSocket. */
export function renderViaWebSocket(genome, { duration, noteDelta = 0, velocity = 1 }) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(PREVIEW_WS_URL);
    } catch (e) {
      reject(new Error(`Could not open render socket: ${e.message}`));
      return;
    }
    ws.binaryType = 'arraybuffer';
    const requestId = `composing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let sampleRate = 48000;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Render timed out'))), RENDER_TIMEOUT_MS);

    ws.onopen = () => ws.send(JSON.stringify({
      type: 'render', genome, duration, noteDelta, velocity, useGPU: true, batch: true, requestId,
    }));
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'batch-result' && typeof msg.sampleRate === 'number') sampleRate = msg.sampleRate;
        else if (msg.type === 'error') finish(() => reject(new Error(msg.message || 'Render server error')));
        return;
      }
      finish(() => resolve({ samples: new Float32Array(ev.data), sampleRate }));
    };
    ws.onerror = () => finish(() => reject(new Error('Render WebSocket error (is the preview render server reachable / origin allowed?)')));
  });
}

// Cache blob URLs by (soundId + resolved settings) so re-renders and re-adds are instant.
// Not keyed on render mode: the two paths are the same engine and should be
// interchangeable — if they ever aren't, that's a bug worth seeing, not caching around.
const cache = new Map();

function keyOf(soundId, { duration, noteDelta, velocity }) {
  return `${soundId}|${duration}|${noteDelta ?? 0}|${velocity ?? 1}`;
}

/**
 * Render (or reuse) a WAV blob URL for a sound at the given settings.
 * `duration` must be resolved to a concrete number by the caller.
 *
 * Falls back to the server once if a client render fails, so a browser-side problem
 * (no WebGPU, an unsupported node type, an OOM on a long duration) degrades to a
 * slower render rather than a dead key in the kit.
 *
 * @returns {Promise<string>} blob URL
 */
export async function renderToWavUrl(soundId, evoRunId, settings) {
  const key = keyOf(soundId, settings);
  if (cache.has(key)) return cache.get(key);

  const genome = await fetchGenome(soundId, evoRunId);
  const wantClient = resolveRenderMode(loadRenderMode()) === 'client';

  let rendered;
  if (wantClient) {
    try {
      rendered = await renderInBrowser(genome, settings);
      // Only the browser path needs this. The server declicks its own delivery output
      // (worklet-offline-renderer.js), and running it a second time would shift the
      // whole buffer by the post-fade DC residue and square the edge curves — small,
      // but it would stop server WAVs being byte-identical to what /ableton imports.
      declickForDelivery(rendered.samples);
    } catch (e) {
      console.warn('[render] browser render failed, falling back to the server:', e);
      rendered = await renderViaWebSocket(genome, settings);
    }
  } else {
    rendered = await renderViaWebSocket(genome, settings);
  }

  const { samples, sampleRate } = rendered;
  const wav = encodeWavPcm16(samples, sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  cache.set(key, url);
  return url;
}
