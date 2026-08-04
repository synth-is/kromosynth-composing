# AI-assisted editing — design & plan

Status: **built (v1)** — 2026-08. The design below is what shipped; the decisions taken,
caveats, and files touched are recorded in "Build v1 — as shipped" at the end. This originally
captured the design agreed while building the pedagogical features.

The framing that drives everything: **the pedagogical features lead the user to things they
wouldn't have thought to ask for; the LLM connection is for the things they're ready to ask
for.** Discovery vs. execution — complementary, not either/or.

---

## 1. What it is (UX)

An **"Ask AI" input** near the editor: the user types a plain-English instruction ("add an
ADSR envelope", "make the bass hit the offbeat", "chop this and gate it", "transpose up a
fifth"). The model rewrites either:

- the **current selection** (if there is one), or
- the **whole buffer** (if not).

The result lands as a **trajectory step** (reversible, A/B-scrubbable) and plays — reusing the
existing `replaceSelection` / `setCode` + trajectory plumbing, so it's not a from-scratch
feature. Streaming (watching the rewrite appear) is a nice-to-have, not required.

## 2. Providers — bring-your-own-endpoint (provider-agnostic)

Never bake in a vendor or a shared key. A small settings modal (⚙): **provider, base URL,
model, API key**, stored in the user's own `localStorage`.

- **LM Studio (local / LAN):** OpenAI-compatible endpoint (`http://localhost:1234/v1`). Private
  and free — aligns with the platform's ethos. The user's chosen model (e.g. Qwen).
- **OpenAI-compatible (generic):** any base URL + key — also covers Ollama, llama.cpp, etc.
- **Anthropic / Claude:** the Anthropic API (a second small adapter).

### Library decision (settle at build time)

- **Plain `fetch`** — one function for OpenAI-compatible + a tiny Anthropic adapter, ~30 lines,
  zero new deps. Fits the "keep it light" ethos. Good default.
- **Vercel AI SDK** (`ai` + `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic`) — the standard
  library; unifies LM Studio + OpenAI + Anthropic behind one `generateText`/`streamText` and
  gives streaming for a modest dependency. Worth it mainly if we want live-streaming rewrites
  and clean provider switching. `createOpenAICompatible` points at LM Studio's base URL.
- **Skip** the LM Studio-specific SDK (Node-oriented; the OpenAI-compat REST endpoint is the
  browser-friendly, one-code-path route that also serves cloud).

Lean: start with plain `fetch`; adopt the AI SDK only if streaming earns the dependency.

## 3. Honest caveats (the fiddly bits)

- **Mixed content:** from `https://composing.synth.is` a browser will **block** an `http://`
  LAN box (`http://192.168.x.x:1234`) — `localhost` is trusted, a LAN IP over http is not. Clean
  paths: LM Studio on the **same machine** (`localhost`), or TLS in front of LM Studio. A LAN
  box over http only works from the **dev** app (http localhost).
- **CORS:** LM Studio needs its **CORS** and **"Serve on Local Network"** toggles on for a
  browser to reach it.
- **Anthropic in the browser** needs the `anthropic-dangerous-direct-browser-access` header.
- **Keys** live in the user's browser (BYO) — fine for a personal tool, never a shared baked-in
  key.

## 4. Giving the model current-Strudel knowledge — WITHOUT MCP

Base models (e.g. Qwen) don't know the latest Strudel. The right-sized fix here is **not** an
MCP server — it's **prompt-injecting a compact reference into the system prompt**.

### One source of truth: derive the reference from `concepts.js`

Add `buildReference(envId)` (in `lib/concepts.js` or `lib/environments.js`) that walks the
concept library and emits a compact block — for each concept: label, plain explanation, and one
example — plus a short **hand-written preamble** of core syntax the palette has no concepts for
(`$:`, mini-notation basics, "only the last expression plays", `stack`/`arrange` for
layering/arrangement, `await samples({...})` context if relevant).

Why derive it (don't maintain a separate reference):

- **No drift** — the palette the user sees and the context the model gets come from the same
  data. Maintaining the palette maintains the AI.
- **Copyright-clean by construction** — it's our descriptions and kit-generated examples, not
  the docs' prose.
- **Cheap** — a few hundred tokens, prepended to each edit request.

The system prompt also constrains the model: output **only** valid Strudel code (no prose, no
markdown fences), use the current kit's sample names (pass them), preserve intent. On response:
strip any accidental code fences, then apply.

## 5. Generalises to other environments (Csound-WASM, WebChucK)

This falls straight out of the `environments` abstraction. Each language already gets its own
environment object; **its concept library IS its LLM reference.** When Csound-WASM lands, it
brings a Csound concept list (curated from the opcode docs) and `buildReference('csound')` just
works — the Ask-AI feature reads the **active** environment's reference automatically (Strudel
prompt in Strudel, Csound prompt in Csound). No special-casing; the per-language artifact does
double duty (palette + prompt).

## 6. Staying up to date — anchor to the bundled version, not upstream HEAD

The key decision, and a deliberate one: the reference should describe **the version the app
actually bundles** (e.g. `@strudel/repl@1.3.0`), not the bleeding edge. A model that invents a
function the bundled version lacks would just produce an error — so **version-matched is the
correct target**, and chasing upstream would be wrong.

That bounds "keeping current" to an occasional, intentional event:

1. **Anchor to the bundled dependency version.** Refresh the reference when you **bump** the
   Strudel dependency, not continuously.
2. **Automate gap *detection*, keep descriptions *curated*.** At bump time, diff the concept
   list against the functions the bundled Strudel actually exposes — Strudel has a function
   registry (it powers autocomplete), so the available names are machine-readable. A small
   coverage check flags "exists in the new version, no concept for it yet," turning drift into a
   short checklist. Write the plain-English description by hand (quality + copyright).
3. **Maintenance loop:** bump `@strudel/repl` → run coverage check → curate a description for
   anything new → done. Because the reference is derived, that one edit updates **both** the
   palette and the AI prompt.

**Optional later bonus (not the foundation):** if you ever want the *local* model to always know
the very latest upstream Strudel without touching anything, that's the dynamic-retrieval /
docs-MCP route — configured in LM Studio's `mcp.json` (LM Studio is the MCP Host; the server
runs beside it or as a remote URL, never in the browser; it works via LM Studio's API but only
augments the local model). For a tool that generates code for a *specific bundled* Strudel,
treat this as a nice-to-have, not step one.

## 7. Placement — keep the workspace calm

One text field ("Ask AI to change the code…") plus a small ⚙ for endpoint config. No new panel.
If no endpoint is configured, the field just opens settings.

---

## Build checklist (when we start)

- [x] `buildReference(envId, kit)` in `lib/concepts.js` (derived reference + preamble + `STRUDEL_REFERENCE_VERSION`).
- [x] `lib/llm.js`: `askEdit({ instruction, code, selection, kit, env, endpoint })` →
      returns rewritten code. Plain `fetch`: OpenAI-compatible path + Anthropic adapter.
- [x] Endpoint settings modal (provider / baseURL / model / key → localStorage).
- [x] "Ask AI" input by the editor; apply via `replaceSelection`/`setCode` + trajectory + play;
      strip code fences from the response.
- [ ] Coverage check script (concept list vs. bundled Strudel's function registry) for bump-time
      maintenance. **Deferred** — see "Still open" below.
- [x] Decide plain-fetch vs Vercel AI SDK based on whether streaming is wanted. **→ plain `fetch`, no streaming in v1.**

---

## Build v1 — as shipped (2026-08)

Built against the pedagogical stack above; reuses its trajectory / selection plumbing. Files:

- **`src/lib/concepts.js`** — added `buildReference(envId, kit)`, `STRUDEL_REFERENCE_VERSION`, and a short hand-written `STRUDEL_PREAMBLE`. The reference is derived from the same `STRUDEL_CONCEPTS` array that drives the palette, so maintaining the palette maintains the AI prompt (§4). Version-anchored to the bundled `@strudel/repl` (§6): keep `STRUDEL_REFERENCE_VERSION` in sync when bumping.
- **`src/lib/llm.js`** (new) — `askEdit({ instruction, code, selection, kit, env, endpoint })`. Plain `fetch`, two adapters (OpenAI-compatible covering LM Studio / Ollama / llama.cpp / OpenAI, plus Anthropic). Also `loadEndpoint` / `saveEndpoint` / `clearEndpoint` / `isConfigured`, `stripCodeFences`, and the derived-reference system prompt. Selection → rewrite-just-the-snippet; no selection → rewrite-whole-buffer.
- **`src/App.jsx`** — an `AskAiBar` beside the editor and an `AiSettingsDialog` (reusing the existing `Modal`); `askAi()` applies the result via `replaceSelection` / `setCode` and plays.

### Decisions taken
- **Library: plain `fetch`, no Vercel AI SDK** (resolves the open question). **No streaming** in v1 — revisit the SDK only if live-streaming rewrites are wanted later.
- **Provenance in the trajectory label (transparency).** Each AI edit stamps its trajectory snapshot with `AI · <model/provider>: <instruction>`, via a `pendingLabelRef` consumed by `handleEval`. Every AI-made step is therefore visibly attributable and undoable — motivation below.
- **BYO endpoint, no shared key.** Provider / base URL / model / key live only in the user's `localStorage` and are sent only to the configured endpoint. Surfaced in the settings modal.

### Known caveats (also surfaced in the settings modal and in `llm.js`)
- **Mixed content.** From the hosted app (`https://composing.synth.is`) the browser blocks an `http://` LAN box; `localhost` is exempt. So an http LAN address works only from the dev app — for production, run the model on `localhost` or put TLS in front of it. `llm.js` detects this case and returns a pointed error.
- **CORS.** LM Studio needs its "CORS" and "Serve on Local Network" toggles on.
- **Anthropic in the browser** uses the `anthropic-dangerous-direct-browser-access` header.

### Still open
- [ ] **Coverage-check script** (concept list vs. the bundled Strudel function registry) for bump-time maintenance (§6, step 2). Deferred: it depends on the exact registry export in the installed `@strudel` version — worth pinning against `node_modules` before writing so it doesn't rot.

### Why provenance — external grounding
The transparency emphasis is not incidental. Garcia & Reiss, *An investigation of AI integration in sound designer workflows and experiences* (AES 2026 Int. Conf. on Audio for VR/AR & Immersive Games, Paris; arXiv:2605.27174 — https://arxiv.org/abs/2605.27174) find that practitioners prefer **assistive, human-in-the-loop** tools that keep the practitioner's curatorial authority over end-to-end generation, and treat **data provenance / the "black box" problem as a *governing* condition** for adoption rather than a nicety. This feature is deliberately shaped to that grain: an assistive rewrite the user asks for explicitly, applied as a reversible, attributable step, on the user's own (local-first) endpoint with no shared key.
