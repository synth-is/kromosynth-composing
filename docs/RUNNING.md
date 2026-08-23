# Running kromosynth-composing

Standalone live-coding companion for Synth.is (Strudel first): browse evolved
sounds, load them as samples, and save compositions to your Synth.is account.
It runs on its own origin and talks to the Synth.is backends only over HTTP.

## Prerequisites

- Node ≥ 20 and npm.

## Install

    git clone <repo-url> kromosynth-composing
    cd kromosynth-composing
    npm install

## Run

Two modes, chosen by which backends you point at:

    npm run dev      # talk to a LOCAL Synth.is stack (localhost ports)
    npm start        # talk to the LIVE services (recommend/auth/evoruns.synth.is)

Both serve the app locally at http://localhost:5273.

- **`npm run dev`** uses the baked-in localhost defaults (recommend
  `localhost:3004`, auth `127.0.0.1:3002`, evoruns `localhost:3010`). Use this when
  you're running the services yourself. If your recommend runs on a different port
  (the repo has both `3004` and `3060` around), set `VITE_RECOMMEND_SERVICE_URL`.
- **`npm start`** loads `.env.production-local` (committed) and points at the live
  services, while the app itself still runs on your machine. Nothing else to run;
  sign in with your normal Synth.is account. This mirrors the `.env.production-local`
  convention used by the other services in this project.

Personal overrides go in `.env.local` (git-ignored). Precedence: `.env.production-local`
(under `npm start`) > `.env.local` > `.env`.

### Env vars

| Variable | Purpose | Local default |
| --- | --- | --- |
| `VITE_RECOMMEND_SERVICE_URL` | sound listings, preview WAVs, `/api/user/sequences` | `http://localhost:3004` |
| `VITE_AUTH_SERVICE_URL` | `/api/auth/login` (garden + saving only) | `http://127.0.0.1:3002` |
| `VITE_EVORUNS_SERVICE_URL` | parameterised renders (`/evorenders/...`) for custom settings | `http://localhost:3010` |

## Build / preview

    npm run build    # builds against the live services (.env.production-local)
    npm run preview  # serve the production build locally

> `npm run build` writes to `dist/`, which is the directory **nginx serves for
> composing.synth.is** (see `kromosynth-services/nginx/nginx.conf`). Building is
> therefore a deploy — Cloudflare may keep serving the previous `index.html` for a
> while, but the new build is live as soon as that cache turns over.
>
> `npm run preview` on a port other than 5273 will fail every API call: the live CORS
> allowlist covers `localhost:5273`, not `localhost:4173`.

## Render modes

Custom per-sound settings (duration / pitch / velocity) render the genome on demand.
The ⚙ control in the header chooses **where** that happens; the choice is remembered
(`localStorage['composing.renderMode']`).

| Mode | What it does |
| --- | --- |
| **Auto** (default) | Uses the server — see the caveat below. |
| **This browser** | Renders locally with kromosynth + WebGPU. ~0.3 s for a few seconds of audio, and nothing queues. Falls back to the server if the render fails, or if the browser has no WebGPU (CPU CPPN activation is too slow to be worth it). |
| **Server** | Renders on `render.synth.is`. One shared process, so renders queue behind everything else on that machine — under load this can take tens of seconds or drop the connection. |

**Why Auto isn't client-side yet.** The two engines don't agree. Browser rendering runs
kromosynth's Web Audio graph; the server runs its own worklet-offline implementation
over `node-web-audio-api`. Measured on kit genomes at 1.7 s, one pair matched closely
(correlation 0.98) and another diverged badly (best correlation 0.57 at an 8 ms offset,
client 4.8× louder in RMS). This is the known browser-vs-backend graph-engine axis that
the web app's `RenderParityTest` exists to probe — it predates this app.

It matters here because a kit **mixes the two**: keys at default settings play the
pre-rendered preview WAV, which is server-made. Rendering custom keys in the browser by
default would put two engines in one composition. Once the engines are reconciled (or
previews are client-rendered too), flip `resolveRenderMode()` in `src/lib/renderMode.js`
so Auto prefers the client.

**Declick.** Browser-rendered audio is DC-trimmed, edge-faded (128 in / 512 out) and
clip-protected in `src/lib/wav.js` before WAV encoding, matching what the render server
already applies to its own output. Clip protection is not optional: removing the DC
offset pushes the opposite peak past full scale (measured 1.17 on a real genome), which
the PCM16 encoder would otherwise clamp into distortion.

Auditioning plays through Web Audio with short attack/release ramps
(`src/lib/audition.js`) rather than an `<audio>` element, whose `pause()` and `src`
reassignment cut the waveform dead — a click on every stop and every switch.

## Notes

- Community browsing, composing, and playback need **no sign-in**. Sign-in (auth
  service) is only for your garden and for saving compositions.
- This is a separate origin from synth.is, so its login session is independent —
  sign in within the app. Requires the live auth/recommend CORS to allow this origin.
- Per-sound render settings (duration/pitch/velocity) are honoured by the Ableton
  **stems** export (the extension renders each stem with them), are saved with the
  composition, and are audible in Strudel — a custom setting renders the genome on
  demand to a WAV blob URL.
- **Where those renders run** is set by the ⚙ control in the header:
  **Auto** (default) · **This browser** · **Server**. See "Render modes" below.
- Inside Ableton Live, launch via the extension's **“compose with Synth.is”**
  context-menu entries (kromosynth-live), not this dev server directly. The bounce
  export additionally needs the extension's provided-audio path — see
  `docs/ABLETON_BRIDGE.md`.
