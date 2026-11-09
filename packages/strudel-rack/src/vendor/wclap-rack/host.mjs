// Headless WCLAP host core. Environment-agnostic (no node: imports) so the same code runs in Node and in a browser
// page, which is how the cross-engine determinism comparison is made. Pass the bytes of module.wasm.
//
// Derived from matiasharju/webclap-plugins tests/smoke-test.mjs (MIT), generalised into a reusable host:
// 32-bit WCLAP (wasm32, shared imported memory), CLAP struct layouts as in clap 1.2.

const EVENT = { NOTE_ON: 0, NOTE_OFF: 1, NOTE_END: 2, NOTE_CHOKE: 3, PARAM_VALUE: 5, MIDI: 10 };
// AudioWorkletGlobalScope has no TextEncoder/TextDecoder: fall back to manual UTF-8 (as the open-webclap
// kit's test host does), so this core also runs inside an AudioWorklet.
const decodeUtf8 = (bytes) => {
	let text = '';
	for (let i = 0; i < bytes.length;) {
		const b = bytes[i++];
		let c = b;
		if (b >= 0xf0) c = (b & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | (bytes[i++] & 63);
		else if (b >= 0xe0) c = (b & 15) << 12 | (bytes[i++] & 63) << 6 | (bytes[i++] & 63);
		else if (b >= 0xc0) c = (b & 31) << 6 | (bytes[i++] & 63);
		text += String.fromCodePoint(c);
	}
	return text;
};
const encodeUtf8 = (text) => {
	const bytes = [];
	for (const ch of text) {
		const c = ch.codePointAt(0);
		if (c < 0x80) bytes.push(c);
		else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
		else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
		else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
	}
	return new Uint8Array(bytes);
};
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : { decode: decodeUtf8 };
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : { encode: encodeUtf8 };

// Read (min, max, shared) of the imported memory from the module's import section.
function memoryImportLimits(bytes) {
	let pos = 8;
	const u8 = () => bytes[pos++];
	const uleb = () => { let r = 0, s = 0, b; do { b = u8(); r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
	const name = () => { const n = uleb(); pos += n; };
	while (pos < bytes.length) {
		const id = u8(), size = uleb(), end = pos + size;
		if (id === 2) {
			for (let count = uleb(); count > 0; --count) {
				name(); name();
				const kind = u8();
				if (kind === 0) uleb();
				else if (kind === 1) { u8(); const f = u8(); uleb(); if (f & 1) uleb(); }
				else if (kind === 2) { const flags = u8(); const min = uleb(); const max = (flags & 1) ? uleb() : undefined; return { min, max, shared: !!(flags & 2) }; }
				else if (kind === 3) { u8(); u8(); }
			}
		}
		pos = end;
	}
	return null;
}

// Small seeded PRNG (mulberry32) for WASI random_get, so a plugin that seeds from OS entropy is repeatable.
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class WclapHost {
	/**
	 * @param {Uint8Array} wasmBytes module.wasm
	 * @param {{ randomSeed?: number, clock?: 'virtual'|'real', log?: (s:string)=>void }} [opts]
	 *   randomSeed: seeds WASI random_get (default 1); clock 'virtual' (default) makes WASI clocks a pure function of
	 *   the frames rendered so far, so a plugin that seeds from the time of day is repeatable.
	 */
	static async load(wasmBytes, opts = {}) {
		const h = new WclapHost();
		await h._init(wasmBytes, opts);
		return h;
	}

	async _init(wasmBytes, { randomSeed = 1, clock = 'virtual', log = () => {} } = {}) {
		this.stdout = '';
		this.log = log;
		this.virtualFrames = 0;
		this.virtualRate = 48000;
		this.clockMode = clock;
		this._randomSeed = randomSeed;
		this._rand = mulberry32(randomSeed);
		const rand = () => this._rand();
		const module = await WebAssembly.compile(wasmBytes);
		const limits = memoryImportLimits(wasmBytes);
		const hasMemImport = WebAssembly.Module.imports(module).some(i => i.kind === 'memory');
		if (hasMemImport) {
			const memory = new WebAssembly.Memory({ initial: limits.min, maximum: limits.max ?? 16384, shared: limits.shared });
			this.memory = memory;
		}
		const view = () => new DataView(this.memory.buffer);
		const u8 = () => new Uint8Array(this.memory.buffer);
		const self = this;
		const wasi = {
			fd_write(fd, iovs, iovsLen, nwrittenPtr) {
				let total = 0, text = '';
				for (let i = 0; i < iovsLen; ++i) {
					const ptr = view().getUint32(iovs + i * 8, true), len = view().getUint32(iovs + i * 8 + 4, true);
					text += textDecoder.decode(u8().slice(ptr, ptr + len));
					total += len;
				}
				self.stdout += text; self.log(text);
				view().setUint32(nwrittenPtr, total, true);
				return 0;
			},
			clock_time_get(id, precision, timePtr) {
				const ns = self.clockMode === 'real' ? BigInt(Math.round(performance.now() * 1e6))
					: BigInt(Math.round(self.virtualFrames / self.virtualRate * 1e9)) + 1_000_000_000n;
				view().setBigUint64(timePtr, ns, true);
				return 0;
			},
			clock_res_get(id, resPtr) { view().setBigUint64(resPtr, 1000n, true); return 0; },
			random_get(ptr, len) { const m = u8(); for (let i = 0; i < len; ++i) m[ptr + i] = (rand() * 256) | 0; return 0; },
			environ_sizes_get(countPtr, sizePtr) { view().setUint32(countPtr, 0, true); view().setUint32(sizePtr, 0, true); return 0; },
			args_sizes_get(countPtr, sizePtr) { view().setUint32(countPtr, 0, true); view().setUint32(sizePtr, 0, true); return 0; },
			fd_prestat_get() { return 8; }, // EBADF: no preopened directories
			proc_exit(code) { throw new Error(`proc_exit(${code})`); },
		};
		const imports = {};
		for (const imp of WebAssembly.Module.imports(module)) {
			imports[imp.module] ??= {};
			if (imp.kind === 'memory') imports[imp.module][imp.name] = this.memory;
			else if (imp.kind === 'function') {
				imports[imp.module][imp.name] = (imp.module === 'wasi_snapshot_preview1' && wasi[imp.name]) ||
					(imp.name === 'thread-spawn' ? () => -1 : () => 52); // ENOSYS for everything else
			}
		}
		this.instance = await WebAssembly.instantiate(module, imports);
		this.exports = this.instance.exports;
		if (!hasMemImport) this.memory = this.exports.memory;
		this.exports._initialize?.();
		this.table = this.exports.__indirect_function_table;
		this._buildHost();
		this._entry();
	}

	/** Rewind the host-side sources of nondeterminism (WASI random_get stream, virtual clock). Call before createPlugin()
	 *  when one host instance renders many patches: Surge seeds libc rand() from time() in its constructor and
	 *  std::random_device from random_get. */
	resetDeterminism(seed = this._randomSeed) { this._rand = mulberry32(seed); this.virtualFrames = 0; }

	/** Capture the whole WASM linear memory (and shadow stack pointer) as it is now. Call right after load, before any plugin exists.
	 *  Surge XT is not history-independent inside one instance: rendering other oscillator types first changes a later Sine
	 *  patch's output (synthis-aa4.46), so resetDeterminism() + a new plugin is not a sufficient reset. restore() rewinds
	 *  every byte of module state (heap, statics, tables of the plugin) to this moment. */
	snapshot() {
		this._snap = { bytes: new Uint8Array(this.memory.buffer).slice(), sp: this.exports.stackSave?.() };
		return this._snap.bytes.length;
	}

	/** Rewind the module to snapshot(): every earlier plugin instance becomes invalid; also rewinds the deterministic sources. */
	restore(seed = this._randomSeed) {
		const s = this._snap;
		if (!s) throw new Error('restore() before snapshot()');
		const mem = this.bytes();
		mem.set(s.bytes, 0);
		if (mem.length > s.bytes.length) mem.fill(0, s.bytes.length); // pages grown since the snapshot: zero, as when first grown
		if (s.sp !== undefined) this.exports.stackRestore(s.sp);
		this.resetDeterminism(seed);
	}

	// ---- memory helpers (re-read buffer each time: shared memory can grow) ----
	view() { return new DataView(this.memory.buffer); }
	bytes() { return new Uint8Array(this.memory.buffer); }
	u32(p) { return this.view().getUint32(p, true); }
	f64(p) { return this.view().getFloat64(p, true); }
	setU32(p, v) { this.view().setUint32(p, v >>> 0, true); }
	setI32(p, v) { this.view().setInt32(p, v, true); }
	setU16(p, v) { this.view().setUint16(p, v, true); }
	setI16(p, v) { this.view().setInt16(p, v, true); }
	setF64(p, v) { this.view().setFloat64(p, v, true); }
	malloc(size) { const p = this.exports.malloc(size); this.bytes().fill(0, p, p + size); return p; }
	free(p) { this.exports.free?.(p); }
	cString(p) { if (!p) return null; const b = this.bytes(); let e = p; while (b[e]) e++; return textDecoder.decode(b.slice(p, e)); }
	allocString(s) { const enc = textEncoder.encode(s + '\0'); const p = this.malloc(enc.length); this.bytes().set(enc, p); return p; }
	fn(index) { if (!index) throw new Error('null function pointer'); return this.table.get(index); }

	// Tables only hold typed wasm functions, so build a tiny module importing our JS functions and re-exporting them.
	// Signature: return type then args; I=i32 L=i64 F=f32 D=f64 v=void.
	_addHostFunctions(signatures, impls) {
		const typeCodes = { I: 0x7f, L: 0x7e, F: 0x7d, D: 0x7c };
		const uleb = (arr, v) => { do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; arr.push(b); } while (v); return arr; };
		const str = (arr, s) => { uleb(arr, s.length); for (const c of s) arr.push(c.charCodeAt(0)); };
		const names = Object.keys(signatures);
		const types = [], imports = [], exportsSection = [];
		names.forEach((name, i) => {
			const sig = signatures[name];
			types.push(0x60); uleb(types, sig.length - 1);
			for (const c of sig.slice(1)) types.push(typeCodes[c]);
			if (sig[0] === 'v') types.push(0); else types.push(1, typeCodes[sig[0]]);
			str(imports, 'h'); str(imports, name); imports.push(0); uleb(imports, i);
			str(exportsSection, name); exportsSection.push(0); uleb(exportsSection, i);
		});
		const section = (id, count, body) => { const content = uleb([], count).concat(body); return [id, ...uleb([], content.length), ...content]; };
		const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
			...section(1, names.length, types), ...section(2, names.length, imports), ...section(7, names.length, exportsSection)]);
		const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), { h: impls });
		const result = {};
		for (const name of names) {
			const index = this.table.grow(1);
			this.table.set(index, inst.exports[name]);
			result[name] = index;
		}
		return result;
	}

	_makeStruct(ptrs) { const p = this.malloc(ptrs.length * 4); ptrs.forEach((v, i) => this.setU32(p + i * 4, v)); return p; }

	_buildHost() {
		// Per-call context: the process() input events and the state stream buffers.
		this.inputEvents = [];
		this.outputEvents = [];
		this.stream = { out: [], inBuf: new Uint8Array(0), pos: 0 };
		const hf = this._addHostFunctions({
			getExtension: 'III', requestRestart: 'vI', requestProcess: 'vI', requestCallback: 'vI',
			paramsRescan: 'vII', paramsClear: 'vIII', paramsRequestFlush: 'vI',
			stateMarkDirty: 'vI',
			inSize: 'II', inGet: 'III', outTryPush: 'III',
			streamWrite: 'LIIL', streamRead: 'LIIL',
		}, {
			getExtension: (host, idPtr) => this.hostExtensions[this.cString(idPtr)] ?? 0,
			requestRestart() {}, requestProcess() {}, requestCallback() {},
			paramsRescan() {}, paramsClear() {}, paramsRequestFlush() {}, stateMarkDirty() {},
			inSize: () => this.inputEvents.length,
			inGet: (list, i) => this.inputEvents[i] ?? 0,
			outTryPush: (list, ev) => {
				const type = this.view().getUint16(ev + 10, true);
				this.outputEvents.push({ type, paramId: this.u32(ev + 16), value: type === EVENT.PARAM_VALUE ? this.f64(ev + 40) : undefined });
				return 1;
			},
			streamWrite: (stream, ptr, size) => {
				const n = Number(size);
				for (const b of this.bytes().subarray(ptr, ptr + n)) this.stream.out.push(b);
				return size;
			},
			streamRead: (stream, ptr, size) => {
				const n = Math.min(Number(size), this.stream.inBuf.length - this.stream.pos);
				this.bytes().set(this.stream.inBuf.subarray(this.stream.pos, this.stream.pos + n), ptr);
				this.stream.pos += n;
				return BigInt(n);
			},
		});
		this.hostFns = hf;
		this.hostExtensions = {
			'clap.params': this._makeStruct([hf.paramsRescan, hf.paramsClear, hf.paramsRequestFlush]),
			'clap.state': this._makeStruct([hf.stateMarkDirty]),
		};
		const host = this.malloc(48);
		this.setU32(host, 1); this.setU32(host + 4, 2); this.setU32(host + 8, 7);
		[this.allocString('wclap-host-node'), this.allocString('kromosynth'), this.allocString(''), this.allocString('0.1.0')]
			.forEach((p, i) => this.setU32(host + 16 + i * 4, p));
		[hf.getExtension, hf.requestRestart, hf.requestProcess, hf.requestCallback].forEach((p, i) => this.setU32(host + 32 + i * 4, p));
		this.host = host;
		this.inEvents = this._makeStruct([0, hf.inSize, hf.inGet]);
		this.outEvents = this._makeStruct([0, hf.outTryPush]);
		this.ostream = this._makeStruct([0, hf.streamWrite]);
		this.istream = this._makeStruct([0, hf.streamRead]);
	}

	_entry() {
		const entry = this.exports.clap_entry.value;
		const [eInit, , eGetFactory] = [this.u32(entry + 12), this.u32(entry + 16), this.u32(entry + 20)];
		if (!this.fn(eInit)(this.allocString('/'))) throw new Error('clap_entry.init failed');
		this.factory = this.fn(eGetFactory)(this.allocString('clap.plugin-factory'));
		if (!this.factory) throw new Error('no clap.plugin-factory');
		const count = this.fn(this.u32(this.factory))(this.factory);
		this.plugins = [];
		for (let i = 0; i < count; ++i) {
			const desc = this.fn(this.u32(this.factory + 4))(this.factory, i);
			const features = [];
			for (let f = this.u32(desc + 44); this.u32(f); f += 4) features.push(this.cString(this.u32(f)));
			this.plugins.push({ index: i, id: this.cString(this.u32(desc + 12)), name: this.cString(this.u32(desc + 16)), features });
		}
	}

	/** Create and initialise a plugin instance; call `.activate()` before processing. */
	createPlugin(id = this.plugins[0].id) {
		const ptr = this.fn(this.u32(this.factory + 8))(this.factory, this.host, this.allocString(id));
		if (!ptr) throw new Error(`could not create plugin ${id}`);
		const p = new WclapPlugin(this, ptr, id);
		if (!p.call(8)) throw new Error('plugin.init failed');
		p._loadExtensions();
		return p;
	}
}

export class WclapPlugin {
	constructor(host, ptr, id) { this.h = host; this.ptr = ptr; this.id = id; this.active = false; this.stepFrames = 0; }
	call(offset, ...args) { return this.h.fn(this.h.u32(this.ptr + offset))(this.ptr, ...args); }
	ext(name) { return this.call(40, this.h.allocString(name)); }

	_loadExtensions() {
		const h = this.h;
		this.paramsExt = this.ext('clap.params');
		this.stateExt = this.ext('clap.state');
		this.latencyExt = this.ext('clap.latency');
		this.tailExt = this.ext('clap.tail');
		const ports = this.ext('clap.audio-ports');
		const portInfo = (isInput, i) => {
			const info = h.malloc(280);
			h.fn(h.u32(ports + 4))(this.ptr, i, isInput ? 1 : 0, info);
			const channels = h.u32(info + 264);
			h.free(info);
			return channels;
		};
		this.inputChannels = ports ? Array.from({ length: h.fn(h.u32(ports))(this.ptr, 1) }, (_, i) => portInfo(true, i)) : [];
		this.outputChannels = ports ? Array.from({ length: h.fn(h.u32(ports))(this.ptr, 0) }, (_, i) => portInfo(false, i)) : [2];
		this.params = [];
		this.paramById = new Map();
		if (this.paramsExt) {
			const count = h.fn(h.u32(this.paramsExt))(this.ptr);
			const info = h.malloc(1320);
			for (let i = 0; i < count; ++i) {
				h.fn(h.u32(this.paramsExt + 4))(this.ptr, i, info);
				const p = {
					id: h.u32(info), stepped: (h.u32(info + 4) & 1) !== 0, name: h.cString(info + 12), module: h.cString(info + 268),
					min: h.f64(info + 1296), max: h.f64(info + 1304), def: h.f64(info + 1312),
				};
				this.params.push(p); this.paramById.set(p.id, p);
			}
			h.free(info);
		}
	}

	/** Activate and start processing. */
	activate({ sampleRate = 48000, blockSize = 512 } = {}) {
		const h = this.h;
		this.sampleRate = sampleRate; this.blockSize = blockSize;
		h.virtualRate = sampleRate;
		if (!this.call(16, sampleRate, 1, blockSize)) throw new Error('activate failed');
		if (!this.call(24)) throw new Error('start_processing failed');
		this.active = true;
		const nIn = this.inputChannels.length, nOut = this.outputChannels.length;
		this.bufs = {
			in: this.inputChannels.map(c => Array.from({ length: c }, () => h.malloc(blockSize * 4))),
			out: this.outputChannels.map(c => Array.from({ length: c }, () => h.malloc(blockSize * 4))),
		};
		const mkPorts = (lists) => {
			const arr = h.malloc(Math.max(1, lists.length) * 24);
			lists.forEach((chans, i) => {
				h.setU32(arr + i * 24, h._makeStruct(chans));
				h.setU32(arr + i * 24 + 8, chans.length);
			});
			return arr;
		};
		this.audioIn = nIn ? mkPorts(this.bufs.in) : 0;
		this.audioOut = mkPorts(this.bufs.out);
		this.proc = h.malloc(40);
		h.setU32(this.proc + 16, this.audioIn); h.setU32(this.proc + 20, this.audioOut);
		h.setU32(this.proc + 24, nIn); h.setU32(this.proc + 28, nOut);
		h.setU32(this.proc + 32, h.inEvents); h.setU32(this.proc + 36, h.outEvents);
		this.eventPool = Array.from({ length: 4096 }, () => h.malloc(48));
	}

	/** Stop, deactivate (drops voices); a fresh activate() then restarts from the plugin's initial processing state. */
	deactivate() {
		if (!this.active) return;
		this.call(28); this.call(20); this.active = false;
	}
	reset() { this.call(32); }

	/** Deactivate, destroy the plugin and free the buffers allocated for it. The host can then createPlugin() again. */
	destroy() {
		const h = this.h;
		this.deactivate();
		this.call(12);
		if (this.bufs) {
			for (const port of [...this.bufs.in, ...this.bufs.out]) for (const c of port) h.free(c);
			for (const e of this.eventPool) h.free(e);
			h.free(this.proc); h.free(this.audioIn); h.free(this.audioOut);
			this.bufs = null;
		}
	}

	param(idOrName) {
		if (typeof idOrName === 'number') return this.paramById.get(idOrName);
		return this.params.find(p => p.name === idOrName || `${p.module}/${p.name}` === idOrName);
	}
	getParam(idOrName) {
		const p = this.param(idOrName); const h = this.h;
		const out = h.malloc(8);
		h.fn(h.u32(this.paramsExt + 8))(this.ptr, p.id, out);
		const v = h.f64(out); h.free(out); return v;
	}
	paramText(idOrName, value) {
		const p = this.param(idOrName); const h = this.h;
		const t = h.malloc(128);
		h.fn(h.u32(this.paramsExt + 12))(this.ptr, p.id, value, t, 128);
		const s = h.cString(t); h.free(t); return s;
	}

	saveState() {
		const h = this.h;
		h.stream.out = [];
		if (!h.fn(h.u32(this.stateExt))(this.ptr, h.ostream)) throw new Error('state.save failed');
		return Uint8Array.from(h.stream.out);
	}
	loadState(bytes) {
		const h = this.h;
		h.stream.inBuf = bytes; h.stream.pos = 0;
		if (!h.fn(h.u32(this.stateExt + 4))(this.ptr, h.istream)) throw new Error('state.load failed');
	}

	_paramEvent(e, { id, value, time = 0 }) {
		const h = this.h;
		h.setU32(e, 48); h.setU32(e + 4, time); h.setU16(e + 8, 0); h.setU16(e + 10, EVENT.PARAM_VALUE);
		h.setU32(e + 16, id); h.setI32(e + 24, -1); h.setI16(e + 28, -1); h.setI16(e + 30, -1); h.setI16(e + 32, -1);
		h.setF64(e + 40, value);
	}
	_noteEvent(e, type, { key, velocity = 1, time = 0, channel = 0, noteId = -1 }) {
		const h = this.h;
		h.setU32(e, 40); h.setU32(e + 4, time); h.setU16(e + 8, 0); h.setU16(e + 10, type);
		h.setI32(e + 16, noteId); h.setI16(e + 20, 0); h.setI16(e + 22, channel); h.setI16(e + 24, key);
		h.setF64(e + 32, velocity);
	}

	/**
	 * Render offline. `events` are { frame, type:'noteOn'|'noteOff'|'param', key, velocity, channel, id, value } with
	 * absolute `frame` offsets from the start of this call; unsorted is fine. Returns one Float32Array per output
	 * channel of the first output port.
	 *
	 * `opts.input`: an array of Float32Array channels (each at least `frames` long) fed to input port 0, copied in
	 * block by block. One channel into a multi-channel port is duplicated; a single-channel port averages all input
	 * channels; the remaining input ports stay zero-filled. Without `input`, every input port is zero-filled (the
	 * previous behaviour, unchanged).
	 */
	render(frames, events = [], { input } = {}) {
		const h = this.h; const B = this.blockSize;
		const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.frame - b.e.frame || a.i - b.i).map(x => x.e);
		const out = this.outputChannels[0] ? Array.from({ length: this.outputChannels[0] }, () => new Float32Array(frames)) : [];
		let ei = 0;
		for (let start = 0; start < frames; start += B) {
			const n = Math.min(B, frames - start);
			h.inputEvents = []; h.outputEvents = [];
			let used = 0;
			while (ei < sorted.length && sorted[ei].frame < start + n) {
				const ev = sorted[ei++]; const ptr = this.eventPool[used++];
				const time = Math.max(0, ev.frame - start);
				if (ev.type === 'noteOn') this._noteEvent(ptr, EVENT.NOTE_ON, { ...ev, time });
				else if (ev.type === 'noteOff') this._noteEvent(ptr, EVENT.NOTE_OFF, { ...ev, time });
				else if (ev.type === 'param') this._paramEvent(ptr, { id: this.param(ev.id).id, value: ev.value, time });
				else throw new Error(`unknown event type ${ev.type}`);
				h.inputEvents.push(ptr);
			}
			for (const port of this.bufs.in) for (const c of port) h.bytes().fill(0, c, c + B * 4);
			if (input !== undefined) {
				const chans = Array.isArray(input) ? input : [input];
				const port = this.bufs.in[0];
				if (!port) throw new Error('render: input given, but the plugin has no audio input port');
				const f32in = new Float32Array(h.memory.buffer);
				for (let c = 0; c < port.length; c++) {
					const dst = port[c] / 4;
					if (chans.length === 1) f32in.set(chans[0].subarray(start, start + n), dst);
					else if (port.length === 1) {
						for (let i = 0; i < n; i++) {
							let sum = 0;
							for (const ch of chans) sum += ch[start + i];
							f32in[dst + i] = sum / chans.length;
						}
					} else f32in.set(chans[Math.min(c, chans.length - 1)].subarray(start, start + n), dst);
				}
			}
			h.setU32(this.proc + 8, n);
			const status = this.call(36, this.proc);
			if (status === 0) throw new Error('process returned CLAP_PROCESS_ERROR');
			h.virtualFrames += n;
			const f32 = new Float32Array(h.memory.buffer);
			this.bufs.out[0]?.forEach((ptr, ch) => out[ch].set(f32.subarray(ptr / 4, ptr / 4 + n), start));
		}
		return out;
	}

	/** clap.latency: the plugin's reported latency in frames. 0 when the extension is absent; UINT32_MAX -> Infinity. */
	latency() {
		if (!this.latencyExt) return 0;
		const v = this.h.fn(this.h.u32(this.latencyExt))(this.ptr) >>> 0;
		return v === 0xffffffff ? Infinity : v;
	}

	/** clap.tail: the plugin's reported tail in frames. 0 when the extension is absent; UINT32_MAX -> Infinity. */
	tail() {
		if (!this.tailExt) return 0;
		const v = this.h.fn(this.h.u32(this.tailExt))(this.ptr) >>> 0;
		return v === 0xffffffff ? Infinity : v;
	}

	/**
	 * Render an audio effect over an input signal. `input` is an array of Float32Array channels of equal length L
	 * (fed to input port 0; see render()). `preRoll` frames of silence are prepended and `events` (frame offsets in
	 * input coordinates) are shifted by it; afterwards preRoll + latency() frames are dropped, so output sample i
	 * lines up with input sample i. Returns one Float32Array of length L per output channel of the first output port.
	 */
	renderEffect({ input, preRoll = 4096, events = [] } = {}) {
		const chans = Array.isArray(input) ? input : [input];
		if (chans.length === 0 || chans[0] === undefined) throw new Error('renderEffect: no input');
		const len = chans[0].length;
		const full = chans.map((c) => {
			const f = new Float32Array(preRoll + len);
			f.set(c, preRoll);
			return f;
		});
		const shifted = events.map((e) => ({ ...e, frame: e.frame + preRoll }));
		const rendered = this.render(preRoll + len, shifted, { input: full });
		const lat = this.latency();
		const drop = preRoll + (Number.isFinite(lat) ? lat : 0);
		return rendered.map((ch) => {
			const out = new Float32Array(len);
			out.set(ch.subarray(drop, drop + len));
			return out;
		});
	}

	/**
	 * One note: noteOn at frame 0, noteOff at `noteFrames`, rendered for `noteFrames + tailFrames`.
	 * `key` is a MIDI note number (60 = C4), `velocity` 0..1.
	 */
	renderNote({ key, velocity = 0.8, noteFrames, tailFrames = 0, channel = 0, params = [] }) {
		return this.render(noteFrames + tailFrames, [
			...params.map(p => ({ frame: 0, type: 'param', ...p })),
			{ frame: 0, type: 'noteOn', key, velocity, channel, noteId: 1 },
			{ frame: noteFrames, type: 'noteOff', key, velocity: 0, channel, noteId: 1 },
		]);
	}

	/** Several pitches of the same patch in one instance, rendered one after another (voice tails don't overlap). */
	renderPitches(keys, opts) {
		return keys.map(key => this.renderNote({ ...opts, key }));
	}
}

/** Bit-exact fingerprint (two 32-bit FNV-1a lanes over the raw float bits of every channel). */
export function fingerprint(channels) {
	let a = 0x811c9dc5, b = 0x9747b28c;
	for (const ch of channels) {
		const u = new Uint32Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.byteLength));
		for (let i = 0; i < u.length; ++i) { a = Math.imul(a ^ u[i], 0x01000193); b = Math.imul(b ^ u[i] ^ (b >>> 15), 0x85ebca6b); }
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
