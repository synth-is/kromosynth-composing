import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone Synth.is live-coding companion.
// Backend URLs come from VITE_* env vars (see .env.example); the app falls back
// to localhost service ports so it runs with zero config against a local stack.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5273, // distinct from kromosynth-desktop's default (5173)
  },
  resolve: {
    // NOTE: don't try to alias the bare `superdough` specifier to its unbundled
    // sources to unify it with the `superdough/superdoughoutput.mjs` deep import
    // that @strudel/webaudio uses -- the sources rely on a `?audioworklet` import
    // suffix provided by a custom Vite plugin in Strudel's monorepo, so they can't
    // be consumed directly ("No matching export ... for import default"). That's
    // why the package ships `dist`. The offline bounce instead stays entirely
    // within the dist instance; see src/lib/offlineRender.js.
    dedupe: [
      '@strudel/webaudio', 'superdough', '@strudel/core',
      // CodeMirror 6 breaks loudly if two copies of @codemirror/state or /view are
      // loaded ('Unrecognized extension value'), and @strudel/repl carries its own
      // CodeMirror for the Strudel pad while CsoundPad builds one directly. Both
      // pads live in the same bundle, so force one copy.
      '@codemirror/state', '@codemirror/view',
    ],
  },
  // @strudel/repl ships its own worklets/wasm; let Vite pre-bundle it normally.
  // If you hit an optimize-deps error, add it to optimizeDeps.exclude here.
});
