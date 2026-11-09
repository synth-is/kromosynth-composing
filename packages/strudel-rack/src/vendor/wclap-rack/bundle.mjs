// Bundle loading for the reference host: environment-agnostic (no static node: imports), so the same
// code runs in Node, a browser page and an AudioWorklet. A WCLAP bundle is a directory listing, a tar
// archive, a tar.gz archive or a bare module.wasm; only module.wasm (plus LICENSE/NOTICE when present)
// is kept.

// Uint8Array.toString() does not decode UTF-8 (it joins with commas); decode explicitly.
const utf8 = typeof TextDecoder !== 'undefined'
	? new TextDecoder()
	: { decode: (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return decodeURIComponent(escape(s)); } };

/** Untar an (uncompressed) tar buffer into { name -> Uint8Array }. */
export function untar(buffer) {
	const files = {};
	for (let offset = 0; offset + 512 <= buffer.length;) {
		const header = buffer.subarray(offset, offset + 512);
		const name = utf8.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
		if (!name) break;
		const size = parseInt(utf8.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
		const type = String.fromCharCode(header[156]);
		if (type === '0' || type === '\0') files[name.replace(/^\.\//, '')] = new Uint8Array(buffer.subarray(offset + 512, offset + 512 + size));
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

const isGzip = (raw) => raw[0] === 0x1f && raw[1] === 0x8b;
const isWasm = (raw) => raw[0] === 0x00 && raw[1] === 0x61 && raw[2] === 0x73 && raw[3] === 0x6d;

function normalize(files) {
	if (!files['module.wasm']) {
		// archives made by `tar czf x.wclap.tar.gz x.wclap/` nest everything under one directory: strip it
		const wasm = Object.keys(files).find((n) => /^[^/]+\/module\.wasm$/.test(n));
		if (wasm) {
			const prefix = wasm.slice(0, wasm.indexOf('/') + 1);
			files = Object.fromEntries(Object.entries(files).filter(([n]) => n.startsWith(prefix)).map(([n, v]) => [n.slice(prefix.length), v]));
		}
	}
	if (!files['module.wasm']) throw new Error('no module.wasm in bundle');
	return { files, wasm: files['module.wasm'] };
}

/** Parse bundle bytes that are a tar archive or a bare module.wasm (gunzip first in Node; see loadBundleBytesAsync). */
export function loadBundleBytes(raw) {
	if (isWasm(raw)) return normalize({ 'module.wasm': new Uint8Array(raw) });
	return normalize(untar(raw));
}

/** Async untar of a tar or tar.gz archive; handles gzip in the browser (DecompressionStream) and in Node (zlib). No module.wasm requirement — for rack bundle archives too. */
export async function untarArchiveAsync(raw) {
	if (isGzip(raw)) {
		if (typeof DecompressionStream !== 'undefined') {
			const ds = new DecompressionStream('gzip');
			const stream = new Blob([raw]).stream().pipeThrough(ds);
			raw = new Uint8Array(await new Response(stream).arrayBuffer());
		} else {
			const zlib = await import('node:zlib');
			raw = new Uint8Array(zlib.gunzipSync(Buffer.from(raw)));
		}
	}
	return untar(raw);
}

/** Async bundle loading (tar.gz / tar / bare wasm); requires module.wasm. */
export async function loadBundleBytesAsync(raw) {
	return normalize(await untarArchiveAsync(raw));
}
