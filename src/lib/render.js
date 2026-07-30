/**
 * Per-sound render settings and how a sound becomes a playable URL for Strudel.
 *
 * Settings model (matches kromosynth's renderBatch and the Ableton SelectionItem):
 *   duration (s) · noteDelta (semitones) · velocity (0..1)
 *
 * IMPORTANT — how these settings are (and aren't) used:
 *  - In-app Strudel playback: Strudel's samples() needs a URL. The default
 *    (unmodified) render is available as the sound's immutable preview WAV, so
 *    default settings play that. There is NO general on-demand render-to-URL
 *    service: the evoruns /evorenders endpoint (see EVORUNS_URL) is a STATIC
 *    server for files the CLI pre-rendered, keyed by MIDI pitch/velocity (0..127)
 *    and only for evorun-corpus sounds — it can't serve arbitrary renders for
 *    community/garden sounds. So until an on-demand render→blob-URL path is wired
 *    (render the genome via the preview WebSocket or in-browser, encode WAV,
 *    URL.createObjectURL), custom settings preview the default render in-app.
 *  - Ableton stems export: the settings DO take effect there — buildStemsSelection
 *    passes duration/noteDelta/velocity to the extension, which renders each stem
 *    with them (renderBatch semantics). They are also saved with the composition.
 */

// Reserved for a future on-demand render path and for corpus pre-rendered files.
// NOTE: /evorenders expects MIDI pitch/velocity (0..127), NOT noteDelta / 0..1.
export const EVORUNS_URL =
  import.meta.env.VITE_EVORUNS_SERVICE_URL || 'http://localhost:3010';

export const DEFAULT_RENDER = { duration: null, noteDelta: 0, velocity: 1 };

export function isDefaultSettings(s) {
  if (!s) return true;
  return (s.duration ?? null) === null
    && (s.noteDelta ?? 0) === 0
    && (s.velocity ?? 1) === 1;
}

/** The evorun folder a sound came from, if any (used by the Ableton stems export). */
export function getEvoRunId(sound) {
  const r = (sound && sound.raw) || sound || {};
  return sound?.evoRunId
    || r.origin_evolution_run_id || r.originEvolutionRunId
    || r.source_run_id || r.sourceRunId
    || null;
}

/**
 * Resolve the audio URL Strudel should fetch for a sound at given settings.
 * Default → the immutable preview WAV. Custom → still the preview (no on-demand
 * render-to-URL yet), flagged `degraded` so the UI can say so; the settings are
 * still honoured by the Ableton stems export and saved with the composition.
 */
export function resolveSampleUrl(sound, settings) {
  return { url: sound.previewUrl, degraded: !isDefaultSettings(settings) };
}
