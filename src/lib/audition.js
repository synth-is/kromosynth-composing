/**
 * Click-free audition playback.
 *
 * Replaces the plain <audio> element this used to use. The WAVs themselves are fine —
 * both the preview files and the render-socket output start and end at true zero — but
 * an <audio> element has no way to stop gracefully: `pause()` and reassigning `.src`
 * both cut the waveform dead at whatever value it happened to be at, which is a click
 * on every stop and every switch to another sound. Web Audio gives us a gain node to
 * ramp instead, the same release-ramp approach the web app's /ableton picker uses.
 *
 * One AudioContext for the whole app, created on the first play (a user gesture, so
 * autoplay policy is satisfied) and reused — contexts are a limited resource.
 */

// Short enough to feel immediate, long enough to be inaudible as a click.
const ATTACK_SECONDS = 0.006;
const RELEASE_SECONDS = 0.012;

let _ctx = null;
let _current = null; // { source, gain, token }
let _token = 0;

function getContext() {
  if (!_ctx || _ctx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    _ctx = new Ctx();
  }
  return _ctx;
}

// Decoded buffers keyed by URL. Auditioning the same sound twice shouldn't re-fetch,
// and switching back and forth between two sounds is a common way to compare them.
const bufferCache = new Map();

async function loadBuffer(url) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return await getContext().decodeAudioData(bytes);
  })();
  bufferCache.set(url, promise);
  try {
    return await promise;
  } catch (e) {
    bufferCache.delete(url); // don't cache a failure
    throw e;
  }
}

/**
 * Fade out and stop whatever is playing. Safe to call when nothing is.
 * The source is stopped only after the ramp completes, so the tail is heard.
 */
export function stopAudition() {
  const playing = _current;
  _current = null;
  if (!playing) return;
  const ctx = _ctx;
  const { source, gain } = playing;
  try {
    if (ctx && ctx.state === 'running') {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
      source.stop(now + RELEASE_SECONDS);
    } else {
      source.stop();
    }
  } catch { /* already stopped */ }
}

/**
 * Play `url`, fading out anything already playing first.
 * `onEnded` fires when the sound finishes on its own — not when it's stopped or
 * replaced, so callers can clear their "now playing" state without races.
 *
 * @returns {Promise<boolean>} true once playing; false if a later call superseded this
 *   one while its buffer was still loading — the caller must not then mark itself as
 *   the sound now playing, or a slow-loading sound would steal the label from the one
 *   actually being heard.
 */
export async function playAudition(url, { onEnded } = {}) {
  const ctx = getContext();
  if (ctx.state === 'suspended') await ctx.resume();

  stopAudition();

  // Loading is async; if another audition starts meanwhile, this one is stale and
  // must not sneak into the output.
  const token = ++_token;
  const buffer = await loadBuffer(url);
  if (token !== _token) return false;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  source.connect(gain).connect(ctx.destination);

  const now = ctx.currentTime;
  // Ramp up rather than starting at full gain: the buffer starts at zero, but the
  // context may be mid-block, and this costs nothing perceptually.
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(1, now + ATTACK_SECONDS);

  const entry = { source, gain, token };
  source.onended = () => {
    if (_current === entry) {
      _current = null;
      onEnded?.();
    }
  };
  source.start(now);
  _current = entry;
  return true;
}

/** Drop cached decoded buffers (e.g. when a blob URL is revoked). */
export function forgetAuditionBuffer(url) {
  bufferCache.delete(url);
}
