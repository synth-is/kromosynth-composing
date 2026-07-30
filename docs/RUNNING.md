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

## Notes

- Community browsing, composing, and playback need **no sign-in**. Sign-in (auth
  service) is only for your garden and for saving compositions.
- This is a separate origin from synth.is, so its login session is independent —
  sign in within the app. Requires the live auth/recommend CORS to allow this origin.
- Per-sound render settings (duration/pitch/velocity) are honoured by the Ableton
  **stems** export (the extension renders each stem with them) and are saved with the
  composition. **In-app Strudel playback currently previews the default render**: the
  evoruns `/evorenders` endpoint only serves CLI-pre-rendered files (MIDI params,
  corpus sounds), so on-demand in-app rendering is a planned follow-up (render the
  genome via the preview WebSocket or in-browser → WAV → object URL). CORS on the
  evoruns/recommend services is open (`cors({ origin: true })`), so it is not the blocker.
- Inside Ableton Live, launch via the extension's **“compose with Synth.is”**
  context-menu entries (kromosynth-live), not this dev server directly. The bounce
  export additionally needs the extension's provided-audio path — see
  `docs/ABLETON_BRIDGE.md`.
