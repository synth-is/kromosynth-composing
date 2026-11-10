// rack-worklet.js — realtime wclap-rack host inside an AudioWorklet (loaded as a module worklet:
// ctx.audioWorklet.addModule('rack-worklet.js', { type: 'module' })).
//
// One WclapHost per bundle; one plugin per device; devices run serially in process() in rack order.
// The page sends `bundles` as { key: module.wasm bytes } — decompression happens page-side (worklets
// have no DecompressionStream/import()).
// Realtime semantics per SPEC.md §3: no frames are dropped; the summed latency is reported to the
// page (a DAW host would compensate it upward).
import { WclapHost } from './vendor/wclap-rack/index.mjs';
import { resolveLfoCfg, resolveEnvCfg, modulatedParamValue } from './modulate.js';

const B = 128; // RenderQuantum

// resolve a rack.json param key or a page-sent param id to the numeric CLAP param id
// (names and "module/name" paths pass through plugin.param; unknown ids stay as-is).
const pidOf = (plugin, idOrName) => plugin.param(isNaN(Number(idOrName)) ? idOrName : Number(idOrName))?.id ?? idOrName;

class RackProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.hosts = new Map();
		this.devices = [];
		this.ready = false;
		this.meterEvery = 0; // level-meter posting interval, 0 = off (see {type:'meter'})
		this.meterCount = 0;
		this.guiDevice = null; // device index whose editor page is open (webview relay), -1 = source
		// rack parameter state for Strudel-driven modulation (see .rp()/.lfo()/.env() in index.js):
		// paramBase/paramMeta keyed `${index}:${pid}` (index -1 = source); active modulators
		// keyed `${index}:${pid}:${key}`, each { kind:'lfo'|'env', index, pid, at, off, cfg }
		// with cfg from resolveLfoCfg/resolveEnvCfg.
		this.paramBase = new Map();
		this.paramMeta = new Map();
		this.mods = new Map();
		this._lastParamPost = new Map(); // `${index}:${pid}` -> last value pushed to the page (for diffing)
		this.port.onmessage = (e) => { void this.onmsg(e.data); };
	}

	/** Register one plugin's params into paramBase/paramMeta and return its resolved initial events. */
	_initParams(index, plugin, paramsObj) {
		for (const p of plugin.params) {
			const key = `${index}:${p.id}`;
			this.paramMeta.set(key, { min: p.min, max: p.max });
			this.paramBase.set(key, p.def);
		}
		return Object.entries(paramsObj ?? {}).map(([k, v]) => {
			const pid = pidOf(plugin, k);
			const key = `${index}:${pid}`;
			const meta = this.paramMeta.get(key);
			let value = Number(v);
			if (meta && Number.isFinite(meta.min) && Number.isFinite(meta.max)) value = Math.min(meta.max, Math.max(meta.min, value));
			this.paramBase.set(key, value);
			return { frame: 0, type: 'param', id: pid, value };
		});
	}

	async onmsg(m) {
		if (m.type === 'load') {
		 try {
			const { rack, bundles } = m;
			if (rack.source) {
				// the source instrument: rendered from notes, no audio input; feeds the chain
				const s = rack.source;
				const host = await this.hostFor(s.bundle, bundles);
				const plugin = host.createPlugin(s.plugin);
				plugin.activate({ sampleRate, blockSize: B });
				if (s.state) plugin.loadState(Uint8Array.from(atob(s.state), (c) => c.charCodeAt(0)));
				const events = this._initParams(-1, plugin, s.params);
				this.source = { plugin, host, events, first: true, pending: [], params: plugin.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def, stepped: p.stepped })) };
			}
			for (const [i, d] of rack.devices.entries()) {
				if (d.on === false) { this.devices.push({ index: i, on: false }); continue; }
				let host = this.hosts.get(d.bundle);
				if (!host) {
					// the page sends module.wasm bytes per bundle key (it can gunzip; worklets cannot import())
					host = await WclapHost.load(new Uint8Array(bundles[d.bundle]));
					host.snapshot();
					this.hosts.set(d.bundle, host);
				}
				// no restore() here: realtime keeps all devices alive at once, and restore()
				// would invalidate earlier plugins sharing this host (null function table entries)
				const plugin = host.createPlugin(d.plugin);
				plugin.activate({ sampleRate, blockSize: B });
				if (d.state) plugin.loadState(Uint8Array.from(atob(d.state), (c) => c.charCodeAt(0)));
				const events = this._initParams(i, plugin, d.params);
				this.devices.push({
					index: i, on: true, plugin, host, events, first: true, pending: null,
					latency: 0,
				});
			}
			let latency = this.source ? this.source.plugin.latency() : 0;
			for (const d of this.devices) if (d.on) { d.latency = d.plugin.latency(); latency += d.latency; }
			this.port.postMessage({
				type: 'ready',
				latency,
				source: this.source ? { plugin: rack.source.plugin, params: this.source.params } : null,
				devices: this.devices.map((d) => d.on
					? { index: d.index, plugin: rack.devices[d.index].plugin, params: d.plugin.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def, stepped: p.stepped })) }
					: { index: d.index, bypassed: true, plugin: rack.devices[d.index].plugin }),
			});
			this.ready = true;
		 } catch (e) {
			this.port.postMessage({ type: 'error', message: String(e && e.stack || e) });
		 }
		}
		if (m.type === 'note' && this.source) {
			this.source.pending.push({ frame: 0, type: m.on ? 'noteOn' : 'noteOff', key: m.key, velocity: m.on ? (m.velocity ?? 0.8) : 0, channel: 0, noteId: 1 });
			// echo for viz (pianoroll ground truth: what the source is actually sounding)
			this.port.postMessage({ type: 'note', on: m.on, key: m.key, velocity: m.velocity ?? 0.8 });
		}
		if (m.type === 'param') {
			const t = m.index === -1 ? this.source : this.devices[m.index];
			if (!t) { this.port.postMessage({ type: 'paramError', index: m.index, id: m.id, detail: 'no such device' }); return; }
			if (!t.plugin) return; // bypassed device: no plugin instance, nothing to set
			const pid = pidOf(t.plugin, m.id);
			if (t.plugin.param(pid) == null) {
				// never let a bad param id reach render() — this.param(ev.id).id would throw
				// inside process() and kill the whole audio thread
				this.port.postMessage({ type: 'paramError', index: m.index, id: m.id });
				return;
			}
			const key = `${m.index}:${pid}`;
			const meta = this.paramMeta.get(key);
			let value = Number(m.value);
			if (!Number.isFinite(value)) { this.port.postMessage({ type: 'paramError', index: m.index, id: m.id, detail: 'non-numeric' }); return; }
			if (meta && Number.isFinite(meta.min) && Number.isFinite(meta.max)) value = Math.min(meta.max, Math.max(meta.min, value));
			this.paramBase.set(key, value);
			this._injectParam(m.index, pid, this._modulated(key));
			// echo the applied value back so the viz sliders track code/slider changes
			this._postParamValue(m.index, pid, t.plugin);
		}
		// Strudel .lfo()/.env() on a rack param: { type:'paramLfo'|'paramEnv', op:'add'|'remove',
		//   index, id, key, at, off?, …cfg fields } — `at`/`off` are audio-clock seconds; the
		// modulator contributes from `at` until `off`. paramEnv adds susTime (note length in s).
		if (m.type === 'paramLfo' || m.type === 'paramEnv') {
			const kind = m.type === 'paramEnv' ? 'env' : 'lfo';
			const t = m.index === -1 ? this.source : this.devices[m.index];
			if (!t) { this.port.postMessage({ type: 'paramError', index: m.index, id: m.id, via: m.type, detail: 'no such device' }); return; }
			if (!t.plugin) return; // bypassed device
			const pid = pidOf(t.plugin, m.id);
			if (t.plugin.param(pid) == null) {
				this.port.postMessage({ type: 'paramError', index: m.index, id: m.id, via: m.type });
				return;
			}
			const key = `${m.index}:${pid}:${m.key}`;
			if (m.op === 'remove') {
				const existing = this.mods.get(key);
				if (existing && m.off != null && currentTime < m.off) {
					// deferred: keep contributing until `off`; _applyMods prunes it there and restores base
					existing.off = m.off;
					this.port.postMessage({ type: kind, op: 'off', index: m.index, id: m.id, key: m.key, active: this._modsFor(`${m.index}:${pid}`).length });
				} else {
					this.mods.delete(key);
					this.port.postMessage({ type: kind, op: 'remove', index: m.index, id: m.id, key: m.key, active: this._modsFor(`${m.index}:${pid}`).length });
					this._injectParam(m.index, pid, this._modulated(`${m.index}:${pid}`)); // restore base (plus remaining mods)
				}
			} else {
				const base = this.paramBase.get(`${m.index}:${pid}`);
				const cfg = kind === 'env'
					? resolveEnvCfg(m, { base, susTime: m.susTime ?? 0 })
					: resolveLfoCfg(m, { cps: m.cps ?? 1, base });
				this.mods.set(key, { kind, index: m.index, pid, at: m.at ?? 0, off: m.off ?? null, cfg });
				this.port.postMessage({ type: kind, op: 'add', index: m.index, id: m.id, key: m.key, active: this._modsFor(`${m.index}:${pid}`).length, cfg });
			}
		}
		// debug/viz query: reply { type:'paramValue', index, id, base, value, lfos } with the
		// param's base and its current modulated value (base + active LFOs)
		if (m.type === 'paramQuery') {
			const t = m.index === -1 ? this.source : this.devices[m.index];
			const pid = t?.plugin ? pidOf(t.plugin, m.id) : null;
			if (!t?.plugin || pid == null || t.plugin.param(pid) == null) {
				this.port.postMessage({ type: 'paramError', index: m.index, id: m.id, via: 'paramQuery' });
				return;
			}
			this._postParamValue(m.index, pid, t.plugin);
		}
		if (m.type === 'setOn') {
			const d = this.devices[m.index];
			if (d) d.on = m.on;
		}
		// level metering for viz panels: {type:'meter', on, every} — posts {type:'levels'} every
		// `every` render blocks. Off by default; the page turns it on only while a viz is visible.
		if (m.type === 'meter') {
			this.meterEvery = m.on ? (m.every || 16) : 0;
			this.meterCount = 0;
		}
		// one device's own editor page (clap.gui webview api), relayed page <-> guest as binary frames.
		// index -1 = the source. Only one at a time, like the Synth.is plugin's overlay.
		if (m.type === 'guiOpen' || m.type === 'guiReceive' || m.type === 'guiClose') {
			const t = m.index === -1 ? this.source : this.devices[m.index];
			if (!t || !t.plugin) {
				this.port.postMessage({ type: 'gui', index: m.index, ok: false, detail: 'no such device' });
				return;
			}
			if (m.type === 'guiOpen') {
				if (this.guiDevice != null) this.closeGui();
				const info = t.plugin.guiOpenWebview();
				if (!info) {
					this.port.postMessage({ type: 'gui', index: m.index, ok: false, detail: 'guest has no clap.gui webview api / clap.webview' });
					return;
				}
				this.guiDevice = m.index;
				t.host.webviewSink = (bytes) => {
					const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
					this.port.postMessage({ type: 'guiFrame', index: m.index, data: ab }, [ab]);
				};
				t.plugin.onMainThread();
				this.port.postMessage({ type: 'gui', index: m.index, ok: true, uri: info.uri, width: info.width, height: info.height });
			} else if (m.type === 'guiReceive') {
				if (this.guiDevice === m.index) {
					t.plugin.guiReceive(new Uint8Array(m.data));
					t.plugin.onMainThread();
				}
			} else {
				if (this.guiDevice === m.index) this.closeGui();
				this.port.postMessage({ type: 'guiClosed', index: m.index });
			}
		}
	}

	closeGui() {
		const t = this.guiDevice === -1 ? this.source : this.devices[this.guiDevice];
		if (t?.plugin) {
			t.plugin.guiCloseWebview();
			if (t.host) t.host.webviewSink = null;
		}
		this.guiDevice = null;
	}

	// ── rack parameter modulation (Strudel .rp() + .lfo()/.env()) ────────────

	/** Push one param's current state to the page: { type:'paramValue', index, id, name, base, value, mods }.
	    Doubles as the reply to a page `paramQuery` and as a change notification (viz sliders). */
	_postParamValue(index, pid, plugin, now = currentTime) {
		const key = `${index}:${pid}`;
		const p = plugin?.param(pid);
		const mods = this._modsFor(key).filter((l) => now >= l.at && (l.off == null || now < l.off)).length;
		const value = this._modulated(key, now);
		this._lastParamPost.set(key, value);
		this.port.postMessage({
			type: 'paramValue', index, id: pid, name: p?.name ?? String(pid),
			base: this.paramBase.get(key) ?? null, value, mods,
		});
	}

	/** Values to push on a meter tick: every param with an active modulator (LFOs move every
	    block, so always send those) plus any param whose value changed since the last push. */
	_collectParamValues(now = currentTime) {
		const out = [];
		const consider = (index, plugin) => {
			for (const p of plugin.params) {
				const key = `${index}:${p.id}`;
				const mods = this._modsFor(key).filter((l) => now >= l.at && (l.off == null || now < l.off)).length;
				const value = this._modulated(key, now);
				if (mods > 0 || this._lastParamPost.get(key) !== value) {
					this._lastParamPost.set(key, value);
					out.push({ index, id: p.id, name: p.name, value, mods });
				}
			}
		};
		if (this.source?.plugin) consider(-1, this.source.plugin);
		for (const d of this.devices) if (d.on && d.plugin) consider(d.index, d.plugin);
		return out;
	}

	_modsFor(paramKey) {
		const out = [];
		for (const l of this.mods.values()) if (`${l.index}:${l.pid}` === paramKey) out.push(l);
		return out;
	}

	/** base + Σ active modulator outputs right now, clamped to the param's declared range. */
	_modulated(paramKey, now = currentTime) {
		const active = this._modsFor(paramKey)
			.filter((l) => now >= l.at && (l.off == null || now < l.off))
			.map((l) => ({ cfg: l.cfg, t: now - l.at }));
		return modulatedParamValue(this.paramBase.get(paramKey) ?? 0, this.paramMeta.get(paramKey) ?? null, active);
	}

	/** Queue one param event on the device's (or source's) pending list for the next block. */
	_injectParam(index, pid, value) {
		const t = index === -1 ? this.source : this.devices[index];
		if (!t || !t.plugin || t.on === false) return;
		const ev = { frame: 0, type: 'param', id: pid, value };
		if (index === -1) t.pending.push(ev);
		else t.pending = [...(t.pending ?? []), ev];
	}

	/** Append one param event per modulated param to the pending lists; called once per block.
	    Also prunes modulators whose `off` has passed and restores those params to base. */
	_applyMods(now = currentTime) {
		const expired = new Set(); // `${index}:${pid}` whose last modulator just ended
		for (const [k, l] of [...this.mods]) {
			if (l.off != null && now >= l.off) { this.mods.delete(k); expired.add(`${l.index}:${l.pid}`); }
		}
		const groups = new Map(); // `${index}:${pid}` -> [{ cfg, t }]
		for (const l of this.mods.values()) {
			if (now < l.at) continue;
			const key = `${l.index}:${l.pid}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push({ cfg: l.cfg, t: now - l.at });
		}
		for (const key of expired) if (!groups.has(key)) groups.set(key, []); // restore base
		for (const [key, entries] of groups) {
			const sep = key.indexOf(':');
			const index = Number(key.slice(0, sep));
			const pidStr = key.slice(sep + 1);
			const pid = isNaN(Number(pidStr)) ? pidStr : Number(pidStr);
			const v = modulatedParamValue(this.paramBase.get(key) ?? 0, this.paramMeta.get(key) ?? null, entries);
			this._injectParam(index, pid, v);
		}
	}

	process(inputs, outputs) {
		try {
			return this._process(inputs, outputs);
		} catch (e) {
			if (!this._errPosted) { this._errPosted = true; this.port.postMessage({ type: 'error', message: 'process: ' + String(e && e.stack || e).slice(0, 500) }); }
			return false;
		}
	}

	async hostFor(key, bundles) {
		let host = this.hosts.get(key);
		if (!host) {
			// the page sends module.wasm bytes per bundle key (it can gunzip; worklets cannot import())
			host = await WclapHost.load(new Uint8Array(bundles[key]));
			host.snapshot();
			this.hosts.set(key, host);
		}
		return host;
	}

	_process(inputs, outputs) {
		const input = inputs[0], output = outputs[0];
		if (!this.ready) return true;
		// Strudel-driven param modulators (.lfo()/.env()): one param event per modulated param
		// per block (128 frames is plenty for LFO/env-rate modulation; CLAP plugins smooth
		// param changes internally anyway)
		if (this.mods.size) this._applyMods();
		// meter scratch, allocated once per block: per-device peak/rms accumulated over the interval
		const meter = this.meterEvery > 0;
		const levels = meter ? this.devices.map(() => ({ peak: 0, sum: 0, n: 0 })) : null;
		const srcLevels = meter ? { peak: 0, sum: 0, n: 0 } : null;
		const acc = (accObj, buf) => {
			let peak = accObj.peak, sum = accObj.sum;
			for (let i = 0; i < buf.length; i++) {
				const a = buf[i] < 0 ? -buf[i] : buf[i];
				if (a > peak) peak = a;
				sum += a * a;
			}
			accObj.peak = peak; accObj.sum = sum; accObj.n += buf.length;
		};
		let l, r;
		if (this.source) {
			// source instrument renders from notes (no audio input); its output feeds the chain
			const s = this.source;
			const events = s.first ? [...s.events, ...s.pending] : s.pending;
			s.first = false;
			s.pending = [];
			const out = s.plugin.render(B, events);
			l = out[0];
			r = out[1] ?? out[0];
			if (srcLevels) { acc(srcLevels, l); if (r !== l) acc(srcLevels, r); }
		} else {
			if (!input || input.length === 0) return true;
			l = input[0];
			r = input[1] ?? input[0];
		}
		for (const d of this.devices) {
			if (!d.on) continue;
			const events = d.first ? d.events : (d.pending ?? []);
			d.first = false;
			d.pending = null;
			const out = d.plugin.render(B, events, { input: [l, r] });
			l = out[0];
			r = out[1] ?? out[0];
			if (levels) { const a = levels[d.index]; if (a) { acc(a, l); if (r !== l) acc(a, r); } }
			if (events === d.events) { // first block: params applied now, latency may have changed
				const lat = d.plugin.latency();
				if (lat !== d.latency) {
					d.latency = lat;
					this.port.postMessage({ type: 'latencyUpdate', index: d.index, latency: lat });
				}
			}
		}
		if (meter && ++this.meterCount >= this.meterEvery) {
			this.meterCount = 0;
			const rms = (a) => (a.n > 0 ? Math.sqrt(a.sum / a.n) : 0);
			this.port.postMessage({
				type: 'levels',
				source: srcLevels ? { peak: srcLevels.peak, rms: rms(srcLevels) } : null,
				devices: this.devices.map((d, i) => {
					const a = levels[i];
					return { index: d.index, on: !!d.on, peak: a ? a.peak : 0, rms: a ? rms(a) : 0 };
				}),
			});
			// live param values for the viz sliders: modulated params every tick, others on change
			const paramValues = this._collectParamValues();
			if (paramValues.length) this.port.postMessage({ type: 'paramValues', values: paramValues });
			if (levels) for (const a of levels) { a.peak = 0; a.sum = 0; a.n = 0; }
			if (srcLevels) { srcLevels.peak = 0; srcLevels.sum = 0; srcLevels.n = 0; }
		}
		if (this.guiDevice != null) {
			const t = this.guiDevice === -1 ? this.source : this.devices[this.guiDevice];
			if (t?.plugin?.guiCreated) t.plugin.onMainThread();
			if (t?.host?.callbackWanted) t.host.callbackWanted = false;
		}
		output[0].set(l);
		if (output[1]) output[1].set(r);
		return true;
	}
}

registerProcessor('wclap-rack', RackProcessor);
