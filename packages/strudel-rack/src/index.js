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
// the voice
// ---------------------------------------------------------------------------

const freqToKey = (f) => Math.round(69 + 12 * Math.log2(f / 440));

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
// applied on a per-hap gain node fed from the shared node (fan-out does not stack).
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

/** One hap's voice: superdough's { node, nodes, stop } contract. */
async function rackVoice(t, value, onended, deps) {
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

	if (ctx instanceof OfflineAudioContext) {
		// bounce path: render the rack offline around this note
		const { rack, bundles } = await loadRackBundle(rackSpec);
		const sr = ctx.sampleRate;
		const len = Math.max(1, Math.round(dur * sr));
		if (rack.source) {
			rack.source.length = len; // renderRack sizes the render from source.length
			rack.source.notes = [{ key, velocity: vel, frame: 0, frames: len }];
		}
		const r = await renderRack({ rack, bundles, input: null, sampleRate: sr, preRoll: 128 });
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
	// per-hap gain node fed from the shared rack node (fan-out; superdough's own per-hap gain
	// still applies on top of this node)
	const hapGain = ctx.createGain();
	node.connect(hapGain);
	// note articulation for source racks: note on at t, off at t+duration, on the SHARED node
	if (rack.source) {
		const at = (when, fn) => setTimeout(fn, Math.max(0, (when - ctx.currentTime) * 1000));
		at(t, () => node.port.postMessage({ type: 'note', on: true, key, velocity: vel }));
		at(t + dur, () => node.port.postMessage({ type: 'note', on: false, key }));
	}
	let torn = false;
	const teardown = () => {
		if (torn) return;
		torn = true;
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
			setTimeout(teardown, Math.max(0, (time - ctx.currentTime) * 1000) + 50);
		},
	};
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Install into a Strudel instance: registers the "wclap-rack" sound and the .rack(cfg) pattern
 * method (with .wclaprack as a guaranteed alias, same collision policy as strudel-faust's .fp).
 * Call twice if the page has two Strudel instances (editor + app), exactly like faustSounds().
 */
export function installRack(deps = {}) {
	const d = resolveBindings(deps);
	d.registerSound('wclap-rack', (t, value, onended) => rackVoice(t, value, onended, d), { type: 'wclap-rack', prebake: false });

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
	} else {
		d.logger?.('[strudel-rack] Pattern/reify not available — the "wclap-rack" sound is registered but .rack() is not installed.', 'warning');
	}
	return 'wclap-rack';
}

export { resolveBindings, strudelScopeReady } from './bindings.js';
export { untarArchiveAsync, loadBundleBytesAsync, validateRackBundle, renderRack, sha256Hex } from './vendor/wclap-rack/index.mjs';
