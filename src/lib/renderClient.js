/**
 * On-demand genome rendering for the composing app.
 *
 * Ports the preview-WebSocket render the Ableton extension and the web app's
 * SoundRenderer use (the latter runs it in-browser, so it's browser-safe):
 *   → { type:'render', genome, duration, noteDelta, velocity, useGPU:true, batch:true, requestId }
 *   ← { type:'batch-result', sampleRate }   (JSON header)
 *   ← <binary Float32 mono payload>          (peak-normalised)
 *
 * Result is encoded to a WAV blob URL so Strudel's samples() can load it — which
 * makes custom per-sound render settings (duration/pitch/velocity) *audible* in the
 * live-coding session, not just in the Ableton stems export.
 *
 * Genomes come from the recommend service (resolves all sound types by id).
 */
import { RECOMMEND_URL } from './api.js';
import { encodeWavPcm16 } from './wav.js';

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
const cache = new Map();

function keyOf(soundId, { duration, noteDelta, velocity }) {
  return `${soundId}|${duration}|${noteDelta ?? 0}|${velocity ?? 1}`;
}

/**
 * Render (or reuse) a WAV blob URL for a sound at the given settings.
 * `duration` must be resolved to a concrete number by the caller.
 */
export async function renderToWavUrl(soundId, evoRunId, settings) {
  const key = keyOf(soundId, settings);
  if (cache.has(key)) return cache.get(key);
  const genome = await fetchGenome(soundId, evoRunId);
  const { samples, sampleRate } = await renderViaWebSocket(genome, settings);
  const wav = encodeWavPcm16(samples, sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  cache.set(key, url);
  return url;
}
