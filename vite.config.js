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
    // The app imports @strudel/webaudio directly (src/lib/bounce.js taps the
    // superdough master output to record a bounce). Force a SINGLE instance so it
    // shares the audio-controller singleton with @strudel/repl — otherwise the
    // bounce records silence. See docs/ABLETON_BRIDGE.md.
    dedupe: ['@strudel/webaudio', 'superdough', '@strudel/core'],
  },
  // @strudel/repl ships its own worklets/wasm; let Vite pre-bundle it normally.
  // If you hit an optimize-deps error, add it to optimizeDeps.exclude here.
});
