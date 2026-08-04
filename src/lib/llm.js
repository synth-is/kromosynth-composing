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

function buildSystemPrompt({ env, kit }) {
  const envId = env?.id || 'strudel';
  const reference = buildReference(envId, kit);
  const names = (kit || []).map((k) => k.name).filter(Boolean);
  const sampleLine = names.length
    ? `The kit currently holds these sample names (use them verbatim inside s("…")): ${names.join(', ')}.`
    : 'The kit is currently empty; you may still write patterns, but s("name") calls stay silent until the user adds sounds.';
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
    if (pageHttps && u.protocol === 'http:' && !isLocal) {
      return ` The page is https but the endpoint is http://${u.hostname} — browsers block that (mixed content). Run the model on localhost or put https in front of it.`;
    }
  } catch { /* ignore */ }
  return ' Is the server running with CORS enabled (and, for LM Studio, "Serve on Local Network")?';
}

async function callOpenAICompatible({ baseUrl, apiKey, model, system, user }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.4,
        stream: false,
      }),
    });
  } catch {
    throw new Error(`Couldn't reach the model at ${baseUrl}.` + reachHint(baseUrl));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Model error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Unexpected response shape from the model.');
  return content;
}

async function callAnthropic({ baseUrl, apiKey, model, system, user }) {
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required to call the Anthropic API directly from a browser.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch {
    throw new Error(`Couldn't reach Anthropic.` + reachHint(url));
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
  return text;
}

/**
 * Ask the configured model to rewrite the code.
 * @returns {Promise<{ code: string }>} the rewritten code (fences stripped).
 */
export async function askEdit({ instruction, code, selection, kit, env, endpoint }) {
  if (!isConfigured(endpoint)) throw new Error('No AI endpoint configured.');
  const system = buildSystemPrompt({ env, kit });
  const user = buildUserPrompt({ instruction, code, selection });
  const args = {
    baseUrl: endpoint.baseUrl || providerMeta(endpoint.provider).defaultBaseUrl,
    apiKey: endpoint.apiKey || '',
    model: endpoint.model,
    system,
    user,
  };
  const raw = endpoint.provider === 'anthropic'
    ? await callAnthropic(args)
    : await callOpenAICompatible(args);
  return { code: stripCodeFences(raw) };
}
