/**
 * lib/llm.js — "Ask AI to change the code" (provider-agnostic, bring-your-own-endpoint).
 *
 * Design & rationale: docs/AI_EDIT_PLAN.md. In short: the pedagogical surfaces
 * (Concepts palette, select-and-transform, Explain) lead the user to things they
 * wouldn't have thought to ask for; this LLM connection is for the things they're
 * ready to ask for in plain English. It rewrites the current selection (if any) or
 * the whole buffer, and the result lands as a reversible, attributable trajectory step.
 *
 * NEVER a shared / baked-in key or vendor. The user configures provider, base URL,
 * model and (optional) API key in a small settings modal; those live only in the
 * user's own localStorage and are sent only to the endpoint they configured.
 *
 * The model's knowledge of the language comes from OUR concept library, not the
 * vendor docs — buildReference() in lib/concepts.js emits a compact, version-matched
 * reference derived from the same data that drives the palette (so maintaining the
 * palette maintains the AI), with copyright-clean, kit-generated examples.
 *
 * ── Concerns worth knowing (all surfaced to the user in the settings modal too) ──
 *  • Mixed content: from the hosted app at https://composing.synth.is a browser
 *    BLOCKS requests to an http:// host (e.g. an LM Studio box at http://192.168.x.x
 *    :1234). `localhost` is exempt. Clean paths: run the model on the SAME machine
 *    (http://localhost:1234/v1), or put TLS in front of it. An http LAN address only
 *    works from the DEV app (which is itself http on localhost).
 *  • CORS: LM Studio must have its "CORS" and "Serve on Local Network" toggles ON for
 *    a browser to reach it; otherwise the request fails before it starts.
 *  • Anthropic from a browser needs the `anthropic-dangerous-direct-browser-access`
 *    header (Anthropic handles CORS for that path).
 *  • Keys are the user's own and stay in their browser. We only ever send them to the
 *    configured base URL.
 *
 * Kept deliberately light: plain `fetch`, one OpenAI-compatible path (covers LM
 * Studio / Ollama / llama.cpp / OpenAI / any compatible server) plus a small
 * Anthropic adapter. No streaming yet — adopt the Vercel AI SDK only if/when
 * live-streaming rewrites earn the dependency (see the plan).
 */

import { buildReference } from './concepts.js';

const STORAGE_KEY = 'synthis.composing.ai-endpoint';

export const PROVIDERS = [
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (LM Studio, Ollama, OpenAI…)',
    defaultBaseUrl: 'http://localhost:1234/v1',
    modelPlaceholder: 'e.g. qwen2.5-coder-7b-instruct',
    keyOptional: true,
    note: 'LM Studio: turn on "CORS" and "Serve on Local Network". From the hosted (https) app the server must be on localhost or behind https — a http:// LAN address is blocked by the browser (that path works from the dev app only).',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelPlaceholder: 'your Claude model id (e.g. claude-sonnet-…)',
    keyOptional: false,
    note: 'Your API key is stored only in this browser and sent directly to Anthropic (via the browser-direct-access header).',
  },
];

export function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

// A code rewrite is bounded work: cap it. Without a ceiling, local servers (LM
// Studio defaults to unlimited) will happily run a repetition loop for tens of
// thousands of tokens — which is exactly what happens when a follow-up request
// feeds the model its own previous output.
//
// Per environment, because the natural size of an answer differs by an order of
// magnitude: a Strudel edit is a one-liner, while a Csound answer is a whole
// orchestra AND we explicitly ask it to comment generously. `env.maxTokens`
// overrides; this is the floor for anything that doesn't set one.
const MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * How long to wait, derived from how much output we allowed.
 *
 * `max_tokens` is the real bound on runaway generation; this timeout is only the
 * backstop for servers that ignore it (the comment above), so it should be
 * generous rather than tight. Tuned as a flat 120 s it was fine for Strudel
 * one-liners — and then raising Csound's ceiling to 4096 tokens started aborting
 * requests that local models were still legitimately working on. A ceiling and a
 * deadline have to move together.
 *
 * ~8 tokens/second is a pessimistic floor for a model running on CPU.
 */
function timeoutFor(maxTokens) {
  return Math.min(600000, Math.max(DEFAULT_TIMEOUT_MS, 60000 + maxTokens * 120));
}

/** Abort signal that fires on the caller's signal OR after `ms`. */
function abortAfter(ms, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => ctrl.abort(outerSignal.reason), { once: true });
  }
  return { signal: ctrl.signal, cleanup: () => clearTimeout(timer) };
}

/** Load the user's saved endpoint config (or null). */
export function loadEndpoint() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg && cfg.provider ? cfg : null;
  } catch {
    return null;
  }
}

/** Persist the endpoint config to the user's own localStorage. */
export function saveEndpoint(cfg) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  return cfg;
}

export function clearEndpoint() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** Enough config to make a call? (local servers may not need a key.) */
export function isConfigured(cfg) {
  if (!cfg || !cfg.provider || !cfg.model) return false;
  const meta = providerMeta(cfg.provider);
  return meta.keyOptional || !!cfg.apiKey;
}

/**
 * Strip anything that isn't code from a model response: the contents of the first
 * fenced block (```lang … ```) if present, else stray leading/trailing fences. The
 * system prompt asks for bare code, but small local models don't always comply, so
 * we're defensive.
 */
export function stripCodeFences(text) {
  if (!text) return '';
  let t = text.trim();
  const fenced = t.match(/```[^\n]*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  t = t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
  return t.trim();
}

/**
 * Roughly how much prompt we aim to send, in characters (~4 chars per token).
 *
 * Generous, because trimming the reference costs grounding in the most direct way
 * imaginable: the EXAMPLES are where the real opcode names live. Dropping them once
 * produced a model that invented `pvstft` while `pvsanal` sat in an example we had
 * withheld. At a 16k context there is no reason to economise — the full Csound
 * reference is ~12k characters and still leaves ample room to answer.
 *
 * The tiering in buildReference is a backstop for genuinely small contexts, not
 * routine behaviour. If it fires on a normal model, raise this rather than accept
 * the trim.
 *
 * Learned the hard way: do NOT tune this against a SUSPECTED context limit. Rounds
 * went into shrinking prompts for a 4k window that turned out to be 16k, while the
 * real cause was our own max_tokens ceiling.
 */
const PROMPT_BUDGET_CHARS = 20000;
const MIN_REFERENCE_CHARS = 1500;

function buildSystemPrompt({ env, kit, userChars = 0 }) {
  const envId = env?.id || 'strudel';
  // Adaptive: each edit makes the piece longer, so a fixed reference budget would
  // quietly squeeze the answer as you work — failing late, on a big composition,
  // which is when losing an edit hurts most.
  const maxChars = Math.max(MIN_REFERENCE_CHARS, PROMPT_BUDGET_CHARS - userChars - 600);
  const reference = buildReference(envId, kit, { maxChars });
  const names = (kit || []).map((k) => k.name).filter(Boolean);
  // How you name a kit sound is language-specific: s("name") in Strudel, a quoted
  // filesystem path in Csound. Hard-coding the Strudel form here sent every Csound
  // request an instruction to write code that cannot work — exactly the leak
  // docs/CSOUND_PLAN.md §5 warns about, in a different place than expected.
  // env.sampleToken is the single source of truth for this.
  const token = env?.sampleToken || ((n) => `"${n}"`);
  const sampleLine = names.length
    ? `The kit holds these sounds. Reference them EXACTLY as written here: ${names.map(token).join(', ')}.`
    : 'The kit is empty, so there are no sounds to reference yet. You can still write code that makes sound without them.';
  return [
    `You are a live-coding assistant embedded in a ${env?.label || 'Strudel'} editor.`,
    `You rewrite the user's code to carry out a plain-English instruction, and you output ONLY code — no prose, no explanation, no markdown fences.`,
    `Preserve the user's intent and keep as much of their existing code as possible; change only what the instruction asks for.`,
    sampleLine,
    '',
    reference,
  ].join('\n');
}

function buildUserPrompt({ instruction, code, selection }) {
  if (selection && selection.text) {
    return [
      `Instruction: ${instruction}`,
      '',
      'Rewrite ONLY the selected snippet below and return ONLY its replacement (no surrounding code):',
      '```',
      selection.text,
      '```',
      '',
      'For context only — the full buffer the snippet sits in. Do NOT return this; return just the replacement for the snippet above:',
      '```',
      code || '',
      '```',
    ].join('\n');
  }
  return [
    `Instruction: ${instruction}`,
    '',
    'Here is the current code. Return the COMPLETE rewritten program:',
    '```',
    code || '',
    '```',
  ].join('\n');
}

function reachHint(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
    if (pageHttps && u.protocol === 'http:') {
      // Mixed content. NOTE: Chrome treats http://localhost as a secure context and
      // allows it; Safari and Firefox do NOT — they block it like any other http
      // origin. So flag it whenever the page is https, localhost included.
      return isLocal
        ? ` Blocked as mixed content: this page is https and the endpoint is http://${u.hostname}. Chrome allows http://localhost, but Safari/Firefox block it. Use the app over http (the dev server) in those browsers, put https in front of the model server, or switch to Chrome.`
        : ` Blocked as mixed content: this page is https and the endpoint is http://${u.hostname}. Run the model on localhost (in Chrome) or put https in front of it.`;
    }
  } catch { /* ignore */ }
  return ' Is the server running with CORS enabled (and, for LM Studio, "Serve on Local Network")?';
}

/**
 * Every provider reports this differently, but they all report it — and a cut-off
 * answer is worth naming, because otherwise it arrives as a baffling syntax error
 * about an "unexpected end of file" that the model never wrote.
 */
const TRUNCATED = ({ promptChars, maxTokens, answerChars, reasoningChars }) => {
  const head = `The model\u2019s answer was cut off. Prompt ~${Math.round(promptChars / 4)} tokens, `
    + `output allowance ${maxTokens}.`;
  // An EMPTY answer with a full allowance is a different failure from a long one:
  // the model spent the whole budget thinking and never started writing. Same
  // finish_reason, opposite fix.
  if (!answerChars && reasoningChars) {
    return `${head} It used the entire allowance on internal reasoning (~${Math.round(reasoningChars / 4)} tokens) `
      + 'and never began the answer. Raise the output limit, or use a model that doesn\u2019t think before answering.';
  }
  if (!answerChars) {
    return `${head} It returned nothing at all — check the model and server settings.`;
  }
  return `${head} It simply wrote more than the ceiling, usually long comment blocks.`;
};

async function callOpenAICompatible({ baseUrl, apiKey, model, system, user, maxTokens, signal, timeoutMs }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const { signal: sig, cleanup } = abortAfter(timeoutMs || DEFAULT_TIMEOUT_MS, signal);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      signal: sig,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.4,
        // Hard ceiling: see MAX_TOKENS. Servers that ignore max_tokens may still
        // run long, but the abort signal above bounds the wait either way.
        max_tokens: maxTokens || MAX_TOKENS,
        stream: false,
      }),
    });
  } catch (err) {
    if (sig.aborted) {
      const secs = Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000);
      throw new Error(
        `The model didn't finish within ${secs}s. It may still be generating — local models are slow at this length. Try a shorter instruction, or select just the part you want changed.`,
      );
    }
    throw new Error(`Couldn't reach the model at ${baseUrl}.` + reachHint(baseUrl));
  } finally {
    cleanup();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Model error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const content = msg.content;
  // Reasoning models return their chain of thought in a separate field, and it is
  // charged against the SAME token allowance as the answer. Ignoring it made an
  // empty reply look like a context problem when it was a budget problem.
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  if (typeof content !== 'string') throw new Error('Unexpected response shape from the model.');
  // WHY an answer ended is the one fact that separates "the model wrote too much"
  // from "the model had nowhere to write" from "the model never started".
  console.log(`[ai] finish_reason=${choice?.finish_reason} · answer ~${content.length} chars`
    + ` · reasoning ~${reasoning.length} chars`);
  if (choice?.finish_reason === 'length') {
    throw new Error(TRUNCATED({
      promptChars: system.length + user.length,
      maxTokens,
      answerChars: content.length,
      reasoningChars: reasoning.length,
    }));
  }
  return content;
}

async function callAnthropic({ baseUrl, apiKey, model, system, user, maxTokens, signal, timeoutMs }) {
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  const { signal: sig, cleanup } = abortAfter(timeoutMs || DEFAULT_TIMEOUT_MS, signal);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: sig,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required to call the Anthropic API directly from a browser.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (err) {
    if (sig.aborted) {
      const secs = Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000);
      throw new Error(`Anthropic didn't finish within ${secs}s.`);
    }
    throw new Error(`Couldn't reach Anthropic.` + reachHint(url));
  } finally {
    cleanup();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = Array.isArray(data?.content)
    ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    : '';
  if (!text) throw new Error('Empty response from Anthropic.');
  if (data?.stop_reason === 'max_tokens') {
    throw new Error(TRUNCATED({
      promptChars: system.length + user.length,
      maxTokens,
      answerChars: text.length,
      reasoningChars: 0,
    }));
  }
  return text;
}

/**
 * Ask the configured model to rewrite the code.
 * @returns {Promise<{ code: string }>} the rewritten code (fences stripped).
 */
export async function askEdit({ instruction, code, selection, kit, env, endpoint, signal, timeoutMs }) {
  if (!isConfigured(endpoint)) throw new Error('No AI endpoint configured.');
  const user = buildUserPrompt({ instruction, code, selection });
  const system = buildSystemPrompt({ env, kit, userChars: user.length });
  const maxTokens = env?.maxTokens || MAX_TOKENS;
  // Prompt size is the thing that quietly grows as the concept library grows, and
  // it is invisible until a small model runs out of room mid-answer. Cheap to see.
  console.log(`[ai] prompt: system ~${system.length} chars, user ~${user.length} chars,`
    + ` max_tokens ${maxTokens}`);
  const args = {
    baseUrl: endpoint.baseUrl || providerMeta(endpoint.provider).defaultBaseUrl,
    apiKey: endpoint.apiKey || '',
    model: endpoint.model,
    system,
    user,
    maxTokens,
    signal,
    timeoutMs: timeoutMs || timeoutFor(maxTokens),
  };
  const raw = endpoint.provider === 'anthropic'
    ? await callAnthropic(args)
    : await callOpenAICompatible(args);
  return { code: stripCodeFences(raw) };
}
