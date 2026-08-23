import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The sibling kromosynth package — the CPPN + DSP-graph render engine. Pulled in
// so sounds can be rendered in the BROWSER (client render mode) instead of always
// round-tripping to the render socket server. Both packages are AGPL-3.0-or-later,
// so bundling it adds no obligation this app doesn't already carry from Strudel.
//
// The four plugins below are ported from kromosynth-desktop's vite.config.js —
// they are what makes a Node-oriented package build for the browser. Keep them in
// sync with that file if it changes.
const KROMOSYNTH_DIR = path.resolve(__dirname, '../kromosynth');

// Serve @grame/faustwasm as an UNPROCESSED static asset at /vendor/faustwasm/index.js.
// Rollup must not bundle+minify it: faustwasm generates AudioWorklet processor code
// via `${ClassName.name}` + `${ClassName.toString()}`, and minification renames those
// classes to short identifiers that don't exist inside AudioWorkletGlobalScope
// ("ReferenceError: cA is not defined"). Serving the self-contained ~7.6 MB esm-bundle
// verbatim keeps it intact; faust-bridge.js imports it via the absolute /vendor/… URL.
const FAUSTWASM_BUNDLE = path.resolve(
  __dirname, 'node_modules/@grame/faustwasm/dist/esm-bundle/index.js'
);
const faustWasmPlugin = {
  name: 'serve-faustwasm',
  enforce: 'pre',
  // Resolve the absolute URL as an external module so Vite's import-analysis leaves
  // the dynamic import in faust-bridge.js alone. Its /* @vite-ignore */ hint is not
  // honoured, because the importer lives outside the Vite root (sibling kromosynth).
  resolveId(id) {
    if (id === '/vendor/faustwasm/index.js') return { id, external: true };
    return null;
  },
  configureServer(server) {
    server.middlewares.use('/vendor/faustwasm', (req, res, next) => {
      if (req.url !== '/index.js' && req.url !== '/') return next();
      try {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(FAUSTWASM_BUNDLE));
      } catch (e) {
        res.statusCode = 404;
        res.end(`faustwasm bundle not found: ${e.message}`);
      }
    });
  },
  async closeBundle() {
    const outDir = path.resolve(__dirname, 'dist/vendor/faustwasm');
    try {
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.copyFile(FAUSTWASM_BUNDLE, path.join(outDir, 'index.js'));
      const stat = await fsp.stat(FAUSTWASM_BUNDLE);
      console.log(`[serve-faustwasm] copied faustwasm bundle (${(stat.size / 1e6).toFixed(1)} MB) to dist/vendor/faustwasm/index.js`);
    } catch (e) {
      console.warn(`[serve-faustwasm] skip build-time copy: ${e.message}`);
    }
  },
};

// Serve kromosynth's Faust .dsp templates at /faust-templates/. In dev they're read
// on demand from the sibling package (single source of truth); at build time they're
// copied into dist/ so the deployed static site serves them at the same URLs.
const FAUST_TEMPLATES_DIR = path.join(KROMOSYNTH_DIR, 'faust-templates');
const faustTemplatesPlugin = {
  name: 'serve-faust-templates',
  configureServer(server) {
    server.middlewares.use('/faust-templates', (req, res, next) => {
      const fileName = (req.url || '').replace(/^\//, '').split('?')[0];
      if (!fileName.endsWith('.dsp')) return next();
      try {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(path.join(FAUST_TEMPLATES_DIR, fileName), 'utf-8'));
      } catch {
        res.statusCode = 404;
        res.end(`Faust template not found: ${fileName}`);
      }
    });
  },
  async closeBundle() {
    const outDir = path.resolve(__dirname, 'dist/faust-templates');
    try {
      await fsp.mkdir(outDir, { recursive: true });
      const entries = await fsp.readdir(FAUST_TEMPLATES_DIR);
      let copied = 0;
      for (const f of entries) {
        if (!f.endsWith('.dsp')) continue;
        await fsp.copyFile(path.join(FAUST_TEMPLATES_DIR, f), path.join(outDir, f));
        copied++;
      }
      console.log(`[serve-faust-templates] copied ${copied} .dsp file(s) to dist/faust-templates/`);
    } catch (e) {
      console.warn(`[serve-faust-templates] skip build-time copy: ${e.message}`);
    }
  },
};

// Keep the Node-only Dawn binding (`webgpu` npm package) out of the browser bundle.
// kromosynth's webgpu-backend.js guards it behind import(/* @vite-ignore */ 'webgpu'),
// but — same story as faustwasm — the hint isn't honoured for an importer outside the
// Vite root, so Rollup resolves it from kromosynth/node_modules and dies on its
// node:path / createRequire imports. Marking it external leaves the dynamic import
// verbatim; that branch only runs when navigator.gpu is absent AND the webgpu backend
// was explicitly selected, i.e. never in a browser render.
const webgpuNodeBindingPlugin = {
  name: 'externalize-webgpu-node-binding',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'webgpu') return { id, external: true };
    return null;
  },
};

// Standalone Synth.is live-coding companion.
// Backend URLs come from VITE_* env vars (see .env.example); the app falls back
// to localhost service ports so it runs with zero config against a local stack.
export default defineConfig({
  plugins: [react(), faustWasmPlugin, faustTemplatesPlugin, webgpuNodeBindingPlugin],
  assetsInclude: ['**/*.wasm'],
  define: {
    // kromosynth's dependency graph reaches for `global` in a few places.
    global: 'globalThis',
  },
  server: {
    host: true,
    port: 5273, // distinct from kromosynth-desktop's default (5173)
    fs: {
      // The sibling kromosynth package (aliased below) lives outside the Vite root.
      allow: ['..', KROMOSYNTH_DIR],
    },
  },
  build: {
    rollupOptions: {
      // Served as an unprocessed static asset — see faustWasmPlugin above.
      external: ['/vendor/faustwasm/index.js'],
    },
  },
  resolve: {
    alias: {
      kromosynth: KROMOSYNTH_DIR,
      // ESM build, to avoid CommonJS interop issues. NOTE: patches/ carries
      // virtual-audio-graph+1.6.1.patch (adds `numberOfInputs` to
      // constructorParamsKeys) — kromosynth's render graphs build channelMerger
      // nodes with it, so rendering is wrong without the patch.
      'virtual-audio-graph': path.resolve(__dirname, 'node_modules/virtual-audio-graph/esm/index.js'),
      // Node-only modules reachable from kromosynth's dep graph.
      '@mapbox/node-pre-gyp': false,
      'mock-aws-s3': false,
      'aws-sdk': false,
      nock: false,
    },
    // NOTE: don't try to alias the bare `superdough` specifier to its unbundled
    // sources to unify it with the `superdough/superdoughoutput.mjs` deep import
    // that @strudel/webaudio uses -- the sources rely on a `?audioworklet` import
    // suffix provided by a custom Vite plugin in Strudel's monorepo, so they can't
    // be consumed directly ("No matching export ... for import default"). That's
    // why the package ships `dist`. The offline bounce instead stays entirely
    // within the dist instance; see src/lib/offlineRender.js.
    dedupe: ['@strudel/webaudio', 'superdough', '@strudel/core'],
  },
  // @strudel/repl ships its own worklets/wasm; let Vite pre-bundle it normally.
  // If you hit an optimize-deps error, add it to optimizeDeps.exclude here.
  optimizeDeps: {
    exclude: [
      '@mapbox/node-pre-gyp',
      '@tensorflow/tfjs-node-gpu',
      'node-web-audio-api',
      // 7.6 MB self-contained ESM with .wasm/.data inlined as base64 — pre-bundling
      // would re-process it through esbuild and break the inlined binary assets.
      '@grame/faustwasm',
    ],
    include: ['virtual-audio-graph'],
  },
});
