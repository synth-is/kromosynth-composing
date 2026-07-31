/**
 * Thin client for the Synth.is backends.
 *
 * Design note: this app is a *separate origin* from synth.is, so it keeps no
 * build-time link to the closed platform — it only speaks HTTP to two services:
 *   - kromosynth-recommend : sound listings, preview WAVs, user sequences
 *   - kromosynth-auth      : login (only needed for the garden + saving)
 *
 * All sounds are addressed by their already-public, CORS-open, immutable
 * preview-WAV URLs, so browsing + composing needs no auth at all.
 */

export const RECOMMEND_URL =
  import.meta.env.VITE_RECOMMEND_SERVICE_URL || 'http://localhost:3004';
export const AUTH_URL =
  import.meta.env.VITE_AUTH_SERVICE_URL || 'http://127.0.0.1:3002';
// Main Synth.is web app, for the “back to Synth.is” link (dev vs prod via env).
export const SYNTHIS_APP_URL =
  import.meta.env.VITE_SYNTHIS_APP_URL || 'http://localhost:5173';

// Marks our sequences so they don't collide with Biomes' tree-bound ones,
// while still living in the same account and /api/user/sequences store.
export const UNIT_TYPE = 'STRUDEL_STANDALONE';

// ---------------------------------------------------------------------------
// Session (localStorage keys are shared with the main app for same-origin reuse)
// ---------------------------------------------------------------------------
let _token = null;
let _user = null;

export function getToken() { return _token; }
export function getUser() { return _user; }
export function isAuthed() { return !!_token && !!_user; }

function _persist() {
  if (_token && _user) {
    localStorage.setItem('kromosynth_token', _token);
    localStorage.setItem('kromosynth_user', JSON.stringify(_user));
    localStorage.setItem('kromosynth_token_expiry', String(Date.now() + 24 * 60 * 60 * 1000));
  }
}

export function restoreSession() {
  try {
    const token = localStorage.getItem('kromosynth_token');
    const userRaw = localStorage.getItem('kromosynth_user');
    const expiry = parseInt(localStorage.getItem('kromosynth_token_expiry') || '0', 10);
    if (token && userRaw && expiry > Date.now()) {
      _token = token;
      _user = JSON.parse(userRaw);
      return _user;
    }
  } catch { /* ignore */ }
  return null;
}

export async function login(email, password) {
  try {
    const res = await fetch(`${AUTH_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const result = await res.json().catch(() => ({}));
    if (res.ok && result.success) {
      _token = result.data.token;
      _user = result.data.user;
      _persist();
      return { success: true, user: _user };
    }
    return { success: false, error: result.error || `Login failed (HTTP ${res.status})` };
  } catch (err) {
    return { success: false, error: err.message || 'Login failed' };
  }
}

/** Fetch the current user for a bearer token (used by the cross-app SSO handoff). */
export async function fetchProfile(token) {
  const res = await fetch(`${AUTH_URL}/api/auth/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await res.json().catch(() => ({}));
  if (res.ok && result.success && result.data?.user) return result.data.user;
  return null;
}

/**
 * Single-sign-on handoff from the main app: it links here with the JWT in the URL
 * fragment (#token=...), which — unlike a query string — is never sent to a server
 * or written to logs. We adopt it, fetch the profile, persist a session, strip the hash.
 */
export async function adoptTokenFromHash() {
  let token = null;
  try {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      const params = new URLSearchParams(hash);
      token = params.get('token') || params.get('access_token');
    }
  } catch { /* ignore */ }
  if (!token) return null;

  // Strip the token from the URL immediately, regardless of outcome.
  try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }

  try {
    const user = await fetchProfile(token);
    if (user) {
      _token = token;
      _user = user;
      _persist();
      return user;
    }
  } catch { /* ignore */ }
  return null;
}

export function logout() {
  _token = null;
  _user = null;
  localStorage.removeItem('kromosynth_token');
  localStorage.removeItem('kromosynth_user');
  localStorage.removeItem('kromosynth_token_expiry');
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` };
}

// ---------------------------------------------------------------------------
// Sounds — normalized from the community-graph node shape
// ---------------------------------------------------------------------------
function pick(node, ...keys) {
  for (const k of keys) if (node[k] != null) return node[k];
  return undefined;
}

export function resolvePreviewUrl(node) {
  const raw = pick(node, 'audio_preview_url', 'audioPreviewUrl');
  if (!raw) return null; // most community sounds have no pre-rendered preview → render on demand
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${RECOMMEND_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function normalizeDate(val) {
  if (val == null) return null;
  if (typeof val === 'number') return new Date(val).toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ULIDs encode a 48-bit millisecond timestamp in their first 10 Crockford-base32
// characters, so we can date a sound from its id even when creation_date is absent.
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulidToIso(id) {
  if (typeof id !== 'string' || id.length < 10) return null;
  const t = id.slice(0, 10).toUpperCase();
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const v = CROCKFORD32.indexOf(t[i]);
    if (v < 0) return null; // not a ULID
    ms = ms * 32 + v;
  }
  // plausibility guard: between 2015-01-01 and now + 1 day
  if (ms < 1420070400000 || ms > Date.now() + 86400000) return null;
  return new Date(ms).toISOString();
}

/** Compact human summary of the perceptual descriptors, e.g. "bright, tonal, loud". */
function descriptorSummary(node) {
  const parts = [];
  const add = (v, skip) => { if (v && v !== skip) parts.push(v); };
  add(pick(node, 'descriptor_brightness', 'descriptorBrightness'), 'neutral');
  add(pick(node, 'descriptor_noisiness', 'descriptorNoisiness'), 'mixed');
  add(pick(node, 'descriptor_energy', 'descriptorEnergy'), 'moderate');
  add(pick(node, 'descriptor_richness', 'descriptorRichness'), 'moderate');
  add(pick(node, 'descriptor_width', 'descriptorWidth'), 'moderate');
  return parts.length ? parts.join(', ') : null;
}

function normalizeSound(node) {
  const id = pick(node, 'id');
  const name = pick(node, 'name');
  const soundType = pick(node, 'sound_type', 'soundType');
  const klass = pick(node, 'class');
  const label = name && name !== id ? name : (soundType || klass || 'sound');
  return {
    id,
    label,
    soundType: soundType || null,
    class: klass || null,
    duration: pick(node, 'duration') || null,
    generation: pick(node, 'generation_number', 'generation') || 0,
    createdAt: normalizeDate(pick(node, 'creation_date', 'createdAt')) || ulidToIso(id),
    descriptors: descriptorSummary(node),
    previewUrl: resolvePreviewUrl(node),
    raw: node,
  };
}

/** Resolve a spectrogram `image` value (data URL, absolute URL, or path) to a URL. */
export function resolveSpecImage(img) {
  if (!img) return null;
  if (img.startsWith('data:') || /^https?:\/\//i.test(img)) return img;
  if (img.startsWith('/')) return `${RECOMMEND_URL}${img}`;
  return `${RECOMMEND_URL}/api/spectrograms/file/${img}`;
}

// Spectrogram PNGs (from the recommend service), cached per sound for the session.
const _specCache = new Map();
export async function fetchSpectrogramUrl(soundId) {
  if (_specCache.has(soundId)) return _specCache.get(soundId);
  let url = null;
  try {
    const res = await fetch(`${RECOMMEND_URL}/api/spectrograms/${encodeURIComponent(soundId)}`);
    if (res.ok) url = resolveSpecImage((await res.json())?.image);
  } catch { /* ignore */ }
  _specCache.set(soundId, url);
  return url;
}

// Semantic (embedding) search encoders. clap covers the broadest corpus; the
// others are backfilled over the adopted pool only.
export const SEARCH_ENCODERS = [
  { id: 'clap', label: 'CLAP' },
  { id: 'mga_clap', label: 'MGA-CLAP' },
  { id: 'languagebind', label: 'LanguageBind' },
];

function normalizeSearchEntry(entry) {
  const s = normalizeSound(entry.sound || {});
  return { ...s, similarity: entry.similarity ?? null, spec: resolveSpecImage(entry.spectrogram?.image) };
}

async function embeddingSearch(query, { encoder = 'clap', topK = 48 } = {}) {
  const res = await fetch(`${RECOMMEND_URL}/api/exploration/search/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, encoder, mode: 'similar', topK }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Search failed (HTTP ${res.status})`);
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data?.data) ? data.data : [];
  return list.map(normalizeSearchEntry).filter((s) => s.id);
}

/** Semantic search: a text query → sounds ranked by the chosen encoder's similarity. */
export function semanticSearch(text, opts) {
  return embeddingSearch({ kind: 'text', text }, opts);
}

/** "More like this": rank sounds by similarity to an existing sound's own vector. */
export function similarToSound(soundId, opts) {
  return embeddingSearch({ kind: 'sound', soundId }, opts);
}

async function fetchGraph(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const result = await res.json();
  if (result && result.success === false) throw new Error(result.error || 'Request failed');
  return result?.data || {};
}

/** Public community pool (no auth). orderBy: 'recent' | 'popularity'. */
export async function fetchPublicSounds({ limit = 200, orderBy = 'recent', minAdoptions = 1 } = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    minAdoptions: String(minAdoptions),
    includeAncestors: 'false',
  });
  if (orderBy !== 'popularity') params.append('orderBy', orderBy);
  const data = await fetchGraph(`${RECOMMEND_URL}/api/community/tree/graph?${params}`);
  const nodes = (data.nodes || []).map(normalizeSound).filter((s) => s.id);
  // de-dupe by id
  const seen = new Set();
  return nodes.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
}

/** The signed-in user's adopted garden (needs a userId from login). */
export async function fetchGardenSounds(userId, { depth = 1 } = {}) {
  const params = new URLSearchParams({ depth: String(depth), includeAncestors: 'false' });
  const data = await fetchGraph(`${RECOMMEND_URL}/api/community/tree/user-graph/${userId}?${params}`);
  const ownIds = new Set(data.userSoundIds || []);
  const nodes = (data.nodes || []).map(normalizeSound).filter((s) => s.id);
  // Restrict to the user's own adopted sounds (the graph also carries ancestors).
  const own = ownIds.size ? nodes.filter((s) => ownIds.has(s.id)) : nodes;
  const seen = new Set();
  return own.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
}

// ---------------------------------------------------------------------------
// Strudel-safe sample names
// ---------------------------------------------------------------------------
export function slugifySampleName(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) s = 'sound';
  if (/^[0-9]/.test(s)) s = `s_${s}`;
  return s.slice(0, 24);
}

/** Produce a unique sample name for `sound`, avoiding names in `taken` (a Set). */
export function uniqueSampleName(sound, taken) {
  const base = slugifySampleName(sound.label || sound.id);
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  return name;
}

// ---------------------------------------------------------------------------
// Sequences (compositions) — reuses the existing /api/user/sequences store
// ---------------------------------------------------------------------------
function unwrap(data, key) {
  if (Array.isArray(data)) return data;
  return data?.[key] || data?.data || data;
}

export async function listMySequences({ limit = 100, offset = 0 } = {}) {
  const res = await fetch(`${RECOMMEND_URL}/api/user/sequences?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text() || 'Failed to list sequences');
  const list = unwrap(await res.json(), 'sequences');
  return (Array.isArray(list) ? list : []).filter((s) => s.unitType === UNIT_TYPE);
}

export async function getSequence(id) {
  const res = await fetch(`${RECOMMEND_URL}/api/user/sequences/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await res.text() || 'Failed to load sequence');
  return unwrap(await res.json(), 'sequence');
}

/**
 * Save a composition. `state` = { code, kit: [{ name, soundId, url }], environment }.
 */
export async function createSequence({ title, description = '', tags = [], visibility = 'private', state }) {
  const payload = {
    title: title || 'Untitled composition',
    description,
    tags,
    visibility,
    unitType: UNIT_TYPE,
    unitConfig: { app: 'kromosynth-composing', environment: state.environment || 'strudel', version: 1 },
    unitState: state,
    treeContext: {},
    soundIds: (state.kit || []).map((k) => k.soundId).filter(Boolean),
  };
  const res = await fetch(`${RECOMMEND_URL}/api/user/sequences`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text() || 'Failed to save');
  return unwrap(await res.json(), 'sequence');
}

/** Metadata update only (title/description/tags/visibility) — matches backend. */
export async function updateSequenceMeta(id, { title, description, tags, visibility }) {
  const res = await fetch(`${RECOMMEND_URL}/api/user/sequences/${id}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ title, description, tags, visibility }),
  });
  if (!res.ok) throw new Error(await res.text() || 'Failed to update');
  return unwrap(await res.json(), 'sequence');
}

export async function deleteSequence(id) {
  const res = await fetch(`${RECOMMEND_URL}/api/user/sequences/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text() || 'Failed to delete');
  return true;
}
