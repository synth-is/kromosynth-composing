// wclap-sw.js — serves a wclap-rack bundle's editor page files (extracted in the page from the
// .wclap-rack.tar.gz) under /__wclap__/<prefix>/…, so a device's own web UI can run in an iframe
// with its relative resource/ paths intact. The page posts the files here via postMessage when a
// rack loads (see serveRackBundleUi in @kromosynth/strudel-rack).
const files = new Map(); // '/__wclap__/<prefix>/<path>' -> { mime, data }

self.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.type === 'wclapFiles') {
    // m.prefix already starts with __wclap__/ (see serveRackBundleUi)
    for (const [path, f] of Object.entries(m.files)) {
      files.set(`/${m.prefix}/${path}`, f);
    }
    e.source.postMessage({ type: 'wclapFilesAck', prefix: m.prefix, n: files.size });
  } else if (m && m.type === 'wclapCount') {
    e.source.postMessage({ type: 'wclapCount', n: files.size, keys: [...files.keys()].slice(0, 5) });
  }
});

const MIME_FALLBACK = { '.html': 'text/html; charset=utf-8' };

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith('/__wclap__/')) return;
  let f = files.get(url.pathname);
  if (!f && !url.pathname.endsWith('/')) f = files.get(url.pathname + '/index.html');
  if (!f && url.pathname.endsWith('/')) f = files.get(url.pathname + 'index.html');
  if (!f) {
    e.respondWith(new Response('wclap-sw: not found: ' + url.pathname, { status: 404 }));
    return;
  }
  e.respondWith(new Response(f.data, { headers: { 'content-type': f.mime || MIME_FALLBACK['.html'] } }));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
