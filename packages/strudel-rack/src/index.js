/**
 * @kromosynth/strudel-rack — play wclap-rack bundles from Strudel.
 *
 * A rack bundle (wclap-rack spec: rack.json + MANIFEST.json + sha256-pinned .wclap.tar.gz archives,
 * packed as .wclap-rack.tar.gz) is a saved rack configuration: an optional `source` instrument plus a
 * serial chain of WCLAP audio effects. This package registers the sound "wclap-rack" and the pattern
 * method .rack(cfg):
 *
 *   await installRack();                       // after the editor's prebake
 *   note("c3 e3 g3").s("wclap-rack").rack("/path/to/synth-fx-rack.wclap-rack.tar.gz")
 *   note("c3").s("wclap-rack").rack(rackJsonObject)     // an already-parsed rack.json also works
 *
 * The rack runs in an AudioWorklet (src/rack-worklet.js over the vendored wclap-rack reference host),
 * one node per hap, so per-note .lpf()/.pan()/.room() still work around it. In an OfflineAudioContext
 * (Strudel's bounce) the rack is rendered offline with the reference host's renderRack and played as a
 * buffer source.
 */

import { untarArchiveAsync, loadBundleBytesAsync, validateRackBundle, renderRack, sha256Hex } from './vendor/wclap-rack/index.mjs';
import { resolveBindings } from './bindings.js';
import { resolveLfoCfg, resolveEnvCfg, modulatedParamValue } from './modulate.js';

const WORKLET_URL = new URL('./rack-worklet.js', import.meta.url);

// ---------------------------------------------------------------------------
// rack bundle loading (cached by URL)
// ---------------------------------------------------------------------------

const bundleCache = new Map(); // url -> { rack, bundles: { key: archive bytes } }

/**
 * Load a rack bundle from a .wclap-rack.tar.gz URL (or accept an already-loaded
 * { rack, bundles } / parsed rack.json object). Returns { rack, bundles }.
 */
export async function loadRackBundle(spec) {
  if (spec && typeof spec === 'object' && spec.rack && spec.bundles) return spec;
  if (spec && typeof spec === 'object' && spec.format === 'wclap-rack') {
    throw new Error('[strudel-rack] a bare rack.json needs its bundles — pass a .wclap-rack.tar.gz URL or { rack, bundles }');
  }
  const url = String(spec);
  if (bundleCache.has(url)) return bundleCache.get(url);
  const raw = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const files = await untarArchiveAsync(raw);
  const get = (n) => files[n] ?? files[Object.keys(files).find((k) => k.endsWith('/' + n))];
  const rack = JSON.parse(new TextDecoder().decode(get('rack.json')));
  const manifest = JSON.parse(new TextDecoder().decode(get('MANIFEST.json')));
  const bundles = {};
  for (const [key, entry] of Object.entries(manifest)) bundles[key] = get(entry.path);
  const { errors } = await validateRackBundle(rack, manifest, bundles);
  if (errors.length) throw new Error('[strudel-rack] invalid rack bundle: ' + errors.join('; '));
  const out = { rack, bundles, files }; // files: the whole untarred archive, for serving a device's ui/ page
  bundleCache.set(url, out);
  return out;
}

// ---------------------------------------------------------------------------
// rack param targeting — the strings .rp() and .lfo({ c }) accept
// ---------------------------------------------------------------------------
//
// A target names one WCLAP param of one rack slot, using what the rack viz shows:
//   'org.faust.aether/detune_cents'   module id (the device's CLAP plugin id) + param name
//                                     (param names repeat inside a plugin — e.g. several
//                                     'depth' — use 'module/osc2/depth' to pick one by its
//                                     module path, which the host resolves too)
//   '0/detune'  '-1/x'  'source/x'    device by index (numeric head); -1 / 'source' = the
//                                     source instrument
//   'detune_cents'                    bare param name, when exactly one slot exposes it
// The worklet resolves the param part by name, "module/name", or numeric CLAP id.

/** Unwrap a target string that the REPL transpiler turned into a mini-notation pattern. */
function asTargetString(x) {
	if (typeof x === 'string') return x;
	if (x && typeof x.queryArc === 'function') {
		try {
			const values = [...new Set(x.queryArc(0, 1).map((h) => h.value))];
			if (values.length === 1 && typeof values[0] === 'string') return values[0];
		} catch { /* fall through */ }
		throw new Error("[strudel-rack] .rp(): the target became a pattern — in the REPL every double-quoted string is mini-notation; write .rp('org.faust.aether/detune_cents', …) with single quotes.");
	}
	throw new Error(`[strudel-rack] .rp(): expected a target string, got ${typeof x}`);
}

/**
 * Resolve a target to { index, param, matches } (index -1 = source) or null.
 * `rack` is the parsed rack.json; `info` is the worklet's `ready` message (param names per
 * slot) and may be null — without it, only the module/index forms resolve (bare names need
 * the param list).
 */
export function resolveRackTarget(rack, info, target) {
	if (!rack || typeof target !== 'string' || !target.trim()) return null;
	target = target.trim();
	const devices = rack.devices ?? [];
	const source = rack.source ?? null;
	const slash = target.indexOf('/');
	if (slash > 0) {
		const head = target.slice(0, slash);
		const param = target.slice(slash + 1);
		let index = null;
		if (/^-?\d+$/.test(head)) index = Number(head);
		else if (head === 'source') index = -1;
		else if (source && source.plugin === head) index = -1;
		else {
			const i = devices.findIndex((d) => d.plugin === head);
			if (i >= 0) index = i;
		}
		if (index != null && (index === -1 ? !!source : !!devices[index])) return { index, param, matches: 1 };
	}
	// bare param name (or a "module/name" path whose head matched no plugin): search the
	// ready message's param lists — source first, then devices in rack order
	const slots = [];
	if (info?.source?.params) slots.push({ index: -1, params: info.source.params });
	for (const d of info?.devices ?? []) if (d.params) slots.push({ index: d.index, params: d.params });
	if (!slots.length) return null;
	const matches = [];
	for (const s of slots) {
		if (s.params.some((p) => p.name === target || target.endsWith('/' + p.name))) matches.push({ index: s.index, param: target });
	}
	if (!matches.length) return null;
	return { index: matches[0].index, param: target, matches: matches.length };
}

/** Every 'module/param' target of a loaded rack (for docs, autocomplete, the viz). */
export function listRackTargets(rack, info) {
	const out = [];
	if (!rack) return out;
	const push = (index, plugin, params) => {
		for (const p of params ?? []) out.push(`${index === -1 ? (rack.source?.plugin ?? 'source') : (rack.devices?.[index]?.plugin ?? index)}/${p.name}`);
	};
	if (info?.source) push(-1, info.source.plugin, info.source.params);
	for (const d of info?.devices ?? []) if (d.params) push(d.index, d.plugin, d.params);
	if (!out.length && rack.source) out.push(`source/* (${rack.source.plugin})`);
	return out;
}

// value keys that are never rack param targets
const NON_TARGET_KEYS = new Set(['rack', 'lfo', 'env', 'bmod']);

/**
 * Split a hap value's rack-target keys and rack-target modulator entries out of it.
 * Returns { statics: [{ target, key, value }], lfos: [{ id, cfg, target }], envs: [...] }.
 * The lfo/env entries are REMOVED from value.lfo/value.env so superdough's own
 * connectLFO/connectEnvelope do not try (and fail, noisily) to wire them to a webaudio
 * node — rackVoice runs before superdough's FX loop reads them. bmod entries aimed at a
 * rack target are stripped too (a bus is an audio-rate signal; a wasm param cannot tap it).
 */
function collectRackMods(value, rack, info, isControlName, logger) {
	const statics = [];
	const lfos = [];
	const envs = [];
	if (!value || typeof value !== 'object') return { statics, lfos, envs };
	for (const key of Object.keys(value)) {
		if (NON_TARGET_KEYS.has(key) || key === 'rack') continue;
		if (!key.includes('/') && isControlName && isControlName(key)) continue; // a strudel control, not a param
		const target = resolveRackTarget(rack, info, key);
		if (target) statics.push({ target, key, value: value[key] });
		else if (key.includes('/')) warnOnce(`unknown:${key}`, `"${key}" matches no rack slot/param — ignoring. Targets look like 'module.id/param_name' (module ids are the device rows in the rack viz).`, logger);
	}
	const extract = (bagName, out) => {
		const bag = value[bagName];
		if (!bag || !bag.__ids) return;
		for (const id of [...bag.__ids]) {
			const cfg = bag[id];
			const c = cfg?.control;
			if (typeof c !== 'string') continue;
			if (!c.includes('/') && isControlName && isControlName(c)) continue; // e.g. .lfo() after .lpf()
			const target = resolveRackTarget(rack, info, c);
			if (target) {
				out.push({ id, cfg, target });
				delete bag[id];
				bag.__ids.delete(id);
			} else if (bagName === 'bmod' && c.includes('/')) {
				warnOnce(`bmod:${c}`, `.bmod({ c: '${c}' }) is not supported for rack params (a bus is audio-rate; a wasm param cannot tap it) — use .lfo()/.env().`, logger);
				delete bag[id];
				bag.__ids.delete(id);
			}
		}
		if (bag.__ids.size === 0) delete value[bagName];
	};
	extract('lfo', lfos);
	extract('env', envs);
	extract('bmod', []);
	return { statics, lfos, envs };
}

// warn-once helper (unknown targets must degrade, not throw — same rule as strudel-faust's .fp)
const warned = new Set();
function warnOnce(key, msg, logger) {
	if (warned.has(key)) return;
	warned.add(key);
	(logger ?? console.warn)(`[strudel-rack] ${msg}`, 'warning');
}

/** The current base value of a rack param for offline LFO depth — rack.json params by name
    or numeric id (mapped via the live ready message when available), else the param default. */
function rackParamBase(slot, infoEntry, paramName) {
	const params = slot?.params ?? {};
	if (params[paramName] != null && Number.isFinite(Number(params[paramName]))) return Number(params[paramName]);
	const p = infoEntry?.params?.find((q) => q.name === paramName || paramName.endsWith('/' + q.name));
	if (p) {
		if (params[String(p.id)] != null && Number.isFinite(Number(params[String(p.id)]))) return Number(params[String(p.id)]);
		if (Number.isFinite(p.def)) return p.def;
	}
	return undefined;
}

const freqToKey = (f) => Math.round(69 + 12 * Math.log2(f / 440));

let lfoSeq = 0; // unique key per paramLfo registration (the worklet node is per rack, so a global counter is safe)

async function workletBundles(ctx, bundles) {
	// decompress page-side; worklets have no DecompressionStream/import()
	const out = {};
	for (const [k, v] of Object.entries(bundles)) {
		const { wasm } = await loadBundleBytesAsync(v);
		out[k] = wasm;
	}
	return out;
}

// One worklet node per rack spec, shared by every hap: each AudioWorkletNode is its own global
// scope with its own wasm instances, so a node per hap would re-instantiate every bundle per note
// and exhaust the renderer's wasm memory budget (measured: 2nd node OOMs in a busy page).
// The WCLAP source instrument is polyphonic internally, so sharing is correct; per-hap gain is
// applied on a per-hap gain node; for source racks only the NEWEST hap's node is fed (see rackVoice).
const nodeCache = new Map(); // rackSpec string -> { node, rack, ready, refs, analyser, listeners, info }

async function sharedRackNode(ctx, rackSpec) {
	const key = String(rackSpec);
	if (nodeCache.has(key)) {
		const entry = nodeCache.get(key);
		entry.refs++;
		await entry.ready;
		return entry;
	}
	const { rack, bundles } = await loadRackBundle(rackSpec);
	await ctx.audioWorklet.addModule(WORKLET_URL, { type: 'module' });
	const node = new AudioWorkletNode(ctx, 'wclap-rack', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
	// analyser fan-out on the shared node: the RAW rack output (all voices summed, pre per-hap FX),
	// for viz. Passive — an analyser does not load the audio path.
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 2048;
	node.connect(analyser);
	const wasm = await workletBundles(ctx, bundles);
	const bundlesAB = {};
	for (const [k, v] of Object.entries(wasm)) bundlesAB[k] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
	const entry = {
		node, rack, analyser, refs: 1, listeners: new Set(), info: null,
		chains: new Set(), // per-hap gain nodes currently fed by the shared node (source racks: at most one)
		ready: new Promise((resolve, reject) => {
			node.port.onmessage = (e) => {
				const m = e.data;
				if (m.type === 'ready') { entry.info = m; resolve(); }
				else if (m.type === 'error') reject(new Error(m.message));
				for (const fn of entry.listeners) { try { fn(m); } catch { /* a listener must not break the others */ } }
			};
		}),
	};
	nodeCache.set(key, entry);
	node.port.postMessage({ type: 'load', rack, bundles: bundlesAB });
	await entry.ready;
	return entry;
}

// ── viz / control surface over the shared node ──────────────────────────────

/** The shared rack node's analyser (raw rack output), or null when the rack is not loaded. */
export function getRackAnalyser(rackSpec) {
	const entry = nodeCache.get(String(rackSpec));
	return entry ? entry.analyser : null;
}

/** The `ready` message the worklet posted (latency, source + per-device params), or null. */
export function getRackInfo(rackSpec) {
	const entry = nodeCache.get(String(rackSpec));
	return entry ? entry.info : null;
}

/** Subscribe to worklet messages (ready/levels/note/latencyUpdate/error) for one rack.
    Returns an unsubscribe function. */
export function onRackEvent(rackSpec, fn) {
	const key = String(rackSpec);
	const entry = nodeCache.get(key);
	if (!entry) return () => {};
	entry.listeners.add(fn);
	return () => entry.listeners.delete(fn);
}

/** Post a message to the shared node (param / setOn / meter / note …). No-op when not loaded. */
export function sendRackMessage(rackSpec, msg) {
	const entry = nodeCache.get(String(rackSpec));
	if (entry) entry.node.port.postMessage(msg);
}

/** Set a device (or the source, index -1) parameter on the shared node. */
export function setRackParam(rackSpec, deviceIndex, paramId, value) {
	sendRackMessage(rackSpec, { type: 'param', index: deviceIndex, id: paramId, value });
}

/** Bypass/unbypass a device on the shared node. */
export function setRackDeviceOn(rackSpec, deviceIndex, on) {
	sendRackMessage(rackSpec, { type: 'setOn', index: deviceIndex, on });
}

/** Ask the shared node for a param's current state. Resolves with the worklet's
    { type:'paramValue', index, id, base, value, lfos } reply ({ ok:false } when the rack
    is not loaded). Useful to see an active .lfo() oscillating the value. */
export function queryRackParam(rackSpec, deviceIndex, paramId, timeoutMs = 3000) {
	const key = String(rackSpec);
	const entry = nodeCache.get(key);
	if (!entry) return Promise.resolve({ ok: false, detail: 'rack not loaded' });
	return new Promise((resolve) => {
		const timer = setTimeout(() => { entry.listeners.delete(fn); resolve({ ok: false, detail: 'timeout' }); }, timeoutMs);
		const fn = (m) => {
			// pushes carry the numeric pid as id plus the name; queries may use either
			const match = (m.index === deviceIndex) && (String(m.id) === String(paramId) || m.name === paramId);
			if (m.type === 'paramValue' && match) {
				clearTimeout(timer);
				entry.listeners.delete(fn);
				resolve({ ok: true, ...m });
			} else if (m.type === 'paramError' && match) {
				clearTimeout(timer);
				entry.listeners.delete(fn);
				resolve({ ok: false, detail: 'unknown param' });
			}
		};
		entry.listeners.add(fn);
		entry.node.port.postMessage({ type: 'paramQuery', index: deviceIndex, id: paramId });
	});
}

/** Turn level metering on/off (posts {type:'levels'} every `every` blocks while on). */
export function setRackMeter(rackSpec, on, every = 16) {
	sendRackMessage(rackSpec, { type: 'meter', on, every });
}

// ── a device's own editor page (the plugin's "native" view, in an iframe) ──────
//
// The worklet relays clap.webview frames between the guest and the page; the page here loads the
// bundle's ui files into an iframe served by the app's /wclap-sw.js service worker under
// /__wclap__/<prefix>/… and shuttles ArrayBuffers across the iframe boundary with postMessage.

const pendingGui = new Map(); // `${spec}|${index}` -> resolve

/** Open device `index` (-1 = source) editor page in the worklet; resolves with the worklet's
    { ok, uri, width, height } 'gui' message. */
export function openRackDeviceGui(rackSpec, index) {
	const entry = nodeCache.get(String(rackSpec));
	if (!entry) return Promise.resolve({ ok: false, detail: 'rack not loaded' });
	const key = `${String(rackSpec)}|${index}`;
	return new Promise((resolve) => {
		pendingGui.set(key, resolve);
		entry.node.port.postMessage({ type: 'guiOpen', index });
		setTimeout(() => { if (pendingGui.delete(key)) resolve({ ok: false, detail: 'timeout' }); }, 8000);
	});
}

/** page -> guest frame (from the iframe). `data` is an ArrayBuffer. */
export function sendRackGuiFrame(rackSpec, index, data) {
	sendRackMessage(rackSpec, { type: 'guiReceive', index, data });
}

/** Close the device's editor page in the worklet. */
export function closeRackDeviceGui(rackSpec, index) {
	sendRackMessage(rackSpec, { type: 'guiClose', index });
}

/** Dispatch worklet 'gui'/'guiFrame'/'guiClosed' messages to any pending openRackDeviceGui caller;
    call this from an onRackEvent subscription. Returns the message (for guiFrame forwarding). */
export function handleRackGuiMessage(rackSpec, m) {
	if (m.type === 'gui') {
		const key = `${String(rackSpec)}|${m.index}`;
		const resolve = pendingGui.get(key);
		if (resolve) { pendingGui.delete(key); resolve(m); }
	}
	return m;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
const mimeFor = (name) => MIME[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';

/** The parsed rack document of a loaded rack (for device bundle keys), or null. */
export function getRack(rackSpec) {
	return nodeCache.get(String(rackSpec))?.rack ?? null;
}

/** The untarred archive files of a loaded rack (name -> bytes), or null. */
export function getRackFiles(rackSpec) {
	return bundleCache.get(String(rackSpec))?.files ?? null;
}

/** Serve one bundle's ui files to the app's /wclap-sw.js service worker and return the URL prefix
    (e.g. "/__wclap__/…/wet-chorus") the iframe should load the guest's uri under. Null when no SW.
    The rack archive packs each WCLAP bundle as a flat `<key>.wclap.tar.gz`; its inner entries carry
    a `<key>.wclap/` prefix, which is stripped here. Async (it untars the inner bundle). */
export async function serveRackBundleUi(rackSpec, bundleKey) {
	const files = bundleCache.get(String(rackSpec))?.files; // the archive map lives in bundleCache
	const sw = navigator.serviceWorker?.controller;
	if (!files || !sw) return null;
	const prefix = `__wclap__/${encodeURIComponent(String(rackSpec)).replace(/[^a-zA-Z0-9]/g, '_')}/${encodeURIComponent(String(bundleKey)).replace(/[^a-zA-Z0-9]/g, '_')}`;
	const esc = bundleKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const archiveRe = new RegExp(`(?:^|/)${esc}\\.wclap\\.tar\\.gz$`);
	const innerPrefixRe = new RegExp(`(?:^|/)${esc}\\.wclap/`);
	const out = {};
	for (const [name, bytes] of Object.entries(files)) {
		if (!archiveRe.test(name)) continue;
		const inner = await untarArchiveAsync(bytes);
		for (const [n2, b2] of Object.entries(inner)) {
			const rel = n2.replace(innerPrefixRe, '');
			if (rel) out[rel] = { mime: mimeFor(n2), data: b2 };
		}
	}
	if (!Object.keys(out).length) return null;
	sw.postMessage({ type: 'wclapFiles', prefix, files: out });
	return `/${prefix}`;
}

/** One hap's voice: superdough's { node, nodes, stop } contract. `cps` is registerSound's 4th arg. */
async function rackVoice(t, value, onended, deps, cps) {
	const ctx = deps.getAudioContext();
	const rackSpec = value.rack;
	if (!rackSpec) throw new Error('[strudel-rack] hap has no rack — use .rack(<url-or-object>)');
	// note("c3") carries the pitch as `note`, not `frequency` — resolve it the way
	// strudel-faust does, falling back to raw value fields (and to 440 if the value
	// is not a note at all, so one bad hap cannot silence the whole bounce).
	let freq;
	try {
		freq = deps.getFrequencyFromValue ? deps.getFrequencyFromValue(value) : (value.frequency ?? value.freq ?? 440);
	} catch { freq = value.frequency ?? value.freq ?? 440; }
	const key = freqToKey(freq);
	const vel = value.velocity ?? 0.8;
	const dur = Number.isFinite(value.duration) ? value.duration : 0.5;
	const cpsVal = Number.isFinite(cps) && cps > 0 ? cps : (deps.getCps?.() ?? globalThis.getCps?.() ?? 1);
	const isControlName = deps.isControlName ?? globalThis.isControlName;

	// Pull this hap's rack-param controls (.rp targets, stored as value keys) and its
	// rack-target LFOs (.lfo entries whose control resolves to a module/param) out of the
	// value before returning: superdough's FX loop reads value.lfo only after onTrigger
	// resolves, and must not try to wire rack LFOs to webaudio nodes (it would log
	// "could not find control data" for every one).
	const { rack: rackDoc } = await loadRackBundle(rackSpec).catch(() => ({ rack: null }));
	const liveInfo = nodeCache.get(String(rackSpec))?.info ?? null;
	const mods = collectRackMods(value, rackDoc, liveInfo, isControlName, deps.logger);
	for (const s of mods.statics) {
		if (!Number.isFinite(Number(s.value))) {
			warnOnce(`nan:${s.target.param}`, `.rp('…/${s.target.param}') got a non-numeric value — ignoring.`, deps.logger);
			s.value = undefined;
		} else s.value = Number(s.value);
	}

	if (ctx instanceof OfflineAudioContext) {
		// bounce path: render the rack offline around this note
		const { rack, bundles } = await loadRackBundle(rackSpec);
		const sr = ctx.sampleRate;
		const len = Math.max(1, Math.round(dur * sr));
		const preRoll = 128;
		// clone — the bundle cache must not be mutated by per-hap values/events
		const r2 = { ...rack };
		if (rack.source) r2.source = { ...rack.source, length: len, notes: [{ key, velocity: vel, frame: 0, frames: len }] }; // renderRack sizes the render from source.length
		// per-hap static params (.rp) merge into the slot's params (applied at frame 0 of the
		// pre-rolled stream); LFOs become paramEvents sampled per 128-frame block, in pre-rolled
		// stream coordinates (the note starts at frame `preRoll`, so note-local f sits at preRoll+f)
		const slotInfo = (index) => (index === -1 ? liveInfo?.source : liveInfo?.devices?.find((x) => x.index === index));
		const slotDoc = (index) => (index === -1 ? r2.source : r2.devices?.[index]);
		const lfoEventsFor = (index) => {
			const byParam = new Map(); // param -> { base, meta, cfgs: [resolved mod cfgs] }
			const addMod = (mod, kind) => {
				const k = mod.target.param;
				if (!byParam.has(k)) {
					byParam.set(k, {
						base: rackParamBase(slotDoc(index), slotInfo(index), k),
						meta: slotInfo(index)?.params?.find((p) => p.name === k || k.endsWith('/' + p.name)) ?? null,
						cfgs: [],
					});
				}
				const g = byParam.get(k);
				g.cfgs.push(kind === 'env'
					? resolveEnvCfg(mod.cfg, { base: g.base, susTime: dur })
					: resolveLfoCfg(mod.cfg, { cps: cpsVal, base: g.base }));
			};
			for (const l of mods.lfos.filter((x) => x.target.index === index)) addMod(l, 'lfo');
			for (const e of mods.envs.filter((x) => x.target.index === index)) addMod(e, 'env');
			const out = [];
			for (const [param, g] of byParam) {
				for (let f = 0; f < len; f += 128) {
					const entries = g.cfgs.map((cfg) => ({ cfg, t: f / sr }));
					out.push({ frame: preRoll + f, type: 'param', id: param, value: modulatedParamValue(g.base ?? 0, g.meta, entries) });
				}
			}
			return out;
		};
		for (const s of mods.statics) {
			if (s.value === undefined) continue;
			if (s.target.index === -1) { if (r2.source) r2.source.params = { ...(r2.source.params ?? {}), [s.target.param]: s.value }; continue; }
			if (!r2.devices?.[s.target.index]) continue;
			r2.devices[s.target.index] = { ...r2.devices[s.target.index], params: { ...(r2.devices[s.target.index].params ?? {}), [s.target.param]: s.value } };
		}
		const hasMods = (i) => mods.lfos.some((l) => l.target.index === i) || mods.envs.some((e) => e.target.index === i);
		if (r2.source) r2.source.paramEvents = lfoEventsFor(-1);
		r2.devices = (r2.devices ?? []).map((d0, i) => (hasMods(i) ? { ...d0, paramEvents: lfoEventsFor(i) } : d0));
		const r = await renderRack({ rack: r2, bundles, input: null, sampleRate: sr, preRoll });
		const buf = ctx.createBuffer(2, r.left.length, sr);
		buf.copyToChannel(r.left, 0);
		buf.copyToChannel(r.right, 1);
		const src = ctx.createBufferSource();
		src.buffer = buf;
		src.onended = () => onended?.();
		src.start(t); // MANDATORY: a BufferSource that is never started renders silence
		return { node: src, nodes: { source: [src] }, stop: (time) => { try { src.stop(time); } catch { /* already stopped */ } } };
	}

	const entry = await sharedRackNode(ctx, rackSpec);
	const { node, rack } = entry;
	const at = (when, fn) => setTimeout(fn, Math.max(0, (when - ctx.currentTime) * 1000));
	// per-hap static params (.rp targets): one param message at the hap's onset. Re-resolve
	// against the now-ready info (on the first hap liveInfo was still null for bare names).
	for (const s of mods.statics) {
		if (s.value === undefined) continue;
		const tgt = resolveRackTarget(rack, entry.info, s.key) ?? s.target;
		if (!tgt) { warnOnce(`unknown:${s.key}`, `"${s.key}" matches no rack slot/param — ignoring.`, deps.logger); continue; }
		s.target = tgt;
		at(t, () => sendRackMessage(rackSpec, { type: 'param', index: tgt.index, id: tgt.param, value: s.value }));
	}
	// per-hap modulators (.lfo()/.env() with a rack target as control): the worklet runs them
	// itself from audio-clock `at`, so there is no main-thread scheduling jitter — the page
	// only registers/unregisters
	const myMods = [];
	for (const l of mods.lfos) {
		const tgt = resolveRackTarget(rack, entry.info, l.cfg.control) ?? l.target; // re-resolve: first hap had no liveInfo yet
		const lkey = `h${++lfoSeq}`;
		myMods.push({ type: 'paramLfo', index: tgt.index, param: tgt.param, key: lkey });
		sendRackMessage(rackSpec, {
			type: 'paramLfo', op: 'add', index: tgt.index, id: tgt.param, key: lkey,
			at: t, cps: cpsVal,
			rate: l.cfg.rate, sync: l.cfg.sync, depth: l.cfg.depth, depthabs: l.cfg.depthabs,
			dcoffset: l.cfg.dcoffset, shape: l.cfg.shape, skew: l.cfg.skew, curve: l.cfg.curve, phaseoffset: l.cfg.phaseoffset,
		});
		// schedule the end up front: the worklet deactivates at `off` itself (audio clock, no
		// main-thread drift) and restores the param's base value. stop() may never be called
		// for a normal hap end — superdough only calls it on polyphony eviction.
		sendRackMessage(rackSpec, { type: 'paramLfo', op: 'remove', index: tgt.index, id: tgt.param, key: lkey, off: t + dur });
	}
	for (const e of mods.envs) {
		const tgt = resolveRackTarget(rack, entry.info, e.cfg.control) ?? e.target;
		const ekey = `h${++lfoSeq}`;
		const rel = Number(e.cfg.release ?? e.cfg.r ?? 0.1);
		myMods.push({ type: 'paramEnv', index: tgt.index, param: tgt.param, key: ekey });
		// an env sustains until the note ends (susTime = hap duration), then releases for `r`
		sendRackMessage(rackSpec, {
			type: 'paramEnv', op: 'add', index: tgt.index, id: tgt.param, key: ekey,
			at: t, susTime: dur,
			attack: e.cfg.attack ?? e.cfg.a, decay: e.cfg.decay ?? e.cfg.d, sustain: e.cfg.sustain ?? e.cfg.s,
			release: e.cfg.release ?? e.cfg.r, acurve: e.cfg.acurve ?? e.cfg.ac, dcurve: e.cfg.dcurve ?? e.cfg.dc,
			rcurve: e.cfg.rcurve ?? e.cfg.rc, depth: e.cfg.depth, depthabs: e.cfg.depthabs,
		});
		sendRackMessage(rackSpec, { type: 'paramEnv', op: 'remove', index: tgt.index, id: tgt.param, key: ekey, off: t + dur + rel + 0.05 });
	}
	// per-hap gain node: superdough's per-hap chain (.gain, filters, envelope) hangs off it.
	// The shared node outputs ALL voices summed, so if every live hap were connected, each chain
	// would carry the whole mix: an older hap (long .slow() haps live seconds) would keep passing
	// the sound at its OLD gain, and .gain(0) set mid-session could not silence anything. For a
	// source rack we therefore feed ONLY the newest hap's chain, switching at its note-on time.
	let torn = false;
	const hapGain = ctx.createGain();
	if (rack.source) {
		at(t, () => {
			for (const g of entry.chains) { if (g !== hapGain) { try { node.disconnect(g); } catch {} entry.chains.delete(g); } }
			if (!torn) { node.connect(hapGain); entry.chains.add(hapGain); }
			node.port.postMessage({ type: 'note', on: true, key, velocity: vel });
		});
		at(t + dur, () => node.port.postMessage({ type: 'note', on: false, key }));
	} else {
		node.connect(hapGain);
	}
	const teardown = () => {
		if (torn) return;
		torn = true;
		entry.chains.delete(hapGain);
		try { node.disconnect(hapGain); } catch {}
		try { hapGain.disconnect(); } catch {}
		if (--entry.refs <= 0) { // last hap for this rack: drop the shared node (frees the wasm memory)
			nodeCache.delete(String(rackSpec));
			try { node.disconnect(); } catch {}
			try { entry.analyser?.disconnect(); } catch {}
			try { node.port.close(); } catch {}
		}
		onended?.();
	};
	return {
		node: hapGain,
		nodes: { source: [hapGain] },
		stop: (time) => {
			if (rack.source) node.port.postMessage({ type: 'note', on: false, key });
			// hand the param back to its base value when this hap's modulators end
			for (const l of myMods) sendRackMessage(rackSpec, { type: l.type, op: 'remove', index: l.index, id: l.param, key: l.key, off: time });
			setTimeout(teardown, Math.max(0, (time - ctx.currentTime) * 1000) + 50);
		},
	};
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Install into a Strudel instance: registers the "wclap-rack" sound, the .rack(cfg) pattern
 * method (with .wclaprack as a guaranteed alias) and the .rp(target, value) param method
 * (alias .rackparam) — same collision policy as strudel-faust's .fp.
 * Call twice if the page has two Strudel instances (editor + app), exactly like faustSounds().
 */
export function installRack(deps = {}) {
	const d = resolveBindings(deps);
	d.registerSound('wclap-rack', (t, value, onended, cps) => rackVoice(t, value, onended, d, cps), { type: 'wclap-rack', prebake: false });

	if (d.Pattern && d.reify) {
		// The REPL's transpiler turns DOUBLE-quoted strings into mini-notation patterns, so
		// .rack("/racks/x.tar.gz") hands us a Pattern, not a string (same trap as strudel-faust's
		// .fp("name")). Unwrap a single constant string; anything structured is an error.
		const asRackSpec = (x) => {
			if (typeof x === 'string') return x;
			if (x && typeof x.queryArc === 'function') {
				try {
					const values = [...new Set(x.queryArc(0, 1).map((h) => h.value))];
					if (values.length === 1 && typeof values[0] === 'string') return values[0];
				} catch { /* fall through */ }
				throw new Error('[strudel-rack] .rack(): the bundle URL became a pattern — in the REPL every double-quoted string is mini-notation; write .rack(\'/racks/x.wclap-rack.tar.gz\') with single quotes.');
			}
			return x; // already an object ({ rack, bundles } / parsed rack.json)
		};
		const impl = function rack(cfg) {
			const spec = asRackSpec(cfg);
			return this.withValue((v) => ({ ...v, rack: spec }));
		};
		impl.__strudelRack = true;
		for (const name of ['rack', 'wclaprack']) {
			const existing = d.Pattern.prototype[name];
			if (existing?.__strudelRack || !existing) {
				d.Pattern.prototype[name] = impl;
			} else {
				d.logger?.(`[strudel-rack] Pattern.prototype.${name} already exists and is not ours — not overwriting.`, 'error');
			}
		}

		// .rp(target, value) — set a WCLAP module param of the rack, per hap, from a pattern:
		//   .rp('org.faust.aether/detune_cents', "<0 45>")
		//   .rp({ 'org.faust.aether/detune_cents': 12, '1/feedback': 0.3 })
		// The target is stored as a plain value key, so a following .lfo()/.env() with no
		// explicit control modulates it (Strudel's default-control rule: the key set just
		// before):
		//   .rp('org.faust.aether/detune_cents', 12).lfo({ rate: 4, depthabs: 20 })
		//   .rp('org.faust.aether/cutoff', 2000).env({ a: 0.01, d: 0.3, s: 0.2, r: 0.4 })
		// — or target them explicitly: .lfo({ c: 'org.faust.aether/detune_cents', … }).
		// Same withValue+appLeft idiom as strudel-faust's .fp (structure from the left, the
		// param value from the right, merged key by key so .rp() calls chain).
		const rpImpl = function rp(...args) {
			const merge = (pat, target, v) =>
				pat.withValue((val) => (pv) => ({ ...val, [target]: pv })).appLeft(d.reify(v));
			if (args.length === 1 && args[0] && typeof args[0] === 'object' && typeof args[0].queryArc !== 'function') {
				return Object.entries(args[0]).reduce((pat, [k, v]) => merge(pat, asTargetString(k), v), this);
			}
			if (args.length >= 2) return merge(this, asTargetString(args[0]), args[1]);
			throw new Error("[strudel-rack] .rp() takes ({ 'module/param': value, … }) or ('module/param', value)");
		};
		rpImpl.__strudelRack = true;
		for (const name of ['rp', 'rackparam']) {
			const existing = d.Pattern.prototype[name];
			if (existing?.__strudelRack || !existing) {
				d.Pattern.prototype[name] = rpImpl;
			} else {
				d.logger?.(`[strudel-rack] Pattern.prototype.${name} already exists and is not ours — not overwriting.`, 'error');
			}
		}
	} else {
		d.logger?.('[strudel-rack] Pattern/reify not available — the "wclap-rack" sound is registered but .rack()/.rp() are not installed.', 'warning');
	}
	return 'wclap-rack';
}

export { resolveBindings, strudelScopeReady } from './bindings.js';
export { untarArchiveAsync, loadBundleBytesAsync, validateRackBundle, renderRack, sha256Hex } from './vendor/wclap-rack/index.mjs';
export { lfoWave, lfoValue, envValue, modValue, resolveLfoCfg, resolveEnvCfg, modulatedParamValue, shapeIndex, LFO_SHAPES } from './modulate.js';
