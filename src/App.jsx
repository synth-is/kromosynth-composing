import React, { useCallback, useEffect, useRef, useState } from 'react';
import StrudelPad from './components/StrudelPad.jsx';
import * as api from './lib/api.js';
import { getEvoRunId, isDefaultSettings, DEFAULT_RENDER } from './lib/render.js';
import { makeSnapshot, appendSnapshot, snapshotLabel } from './lib/trajectory.js';
import { isAbletonHost, buildStemsSelection, sendToLive } from './lib/ableton.js';
import { bounceToWav, bytesToBase64 } from './lib/bounce.js';
import { renderToWavUrl } from './lib/renderClient.js';
import { getEnvironment } from './lib/environments.js';
import { conceptsByCategory, conceptNames, transforms as conceptTransforms, explainConcepts } from './lib/concepts.js';
import * as llm from './lib/llm.js';

const ABLETON = isAbletonHost();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Group sounds into month buckets (newest first; undated last) for a navigable list. */
function groupByMonth(sounds) {
  const map = new Map();
  for (const s of sounds) {
    let key = 'undated';
    let label = 'Undated';
    if (s.createdAt) {
      const d = new Date(s.createdAt);
      if (!isNaN(d.getTime())) {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        label = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      }
    }
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key).items.push(s);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (a.key === 'undated') return 1;
    if (b.key === 'undated') return -1;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
  return groups;
}

/** Group by sound type/role (always present; the most navigable default for picking). */
function groupByType(sounds) {
  const map = new Map();
  for (const s of sounds) {
    const key = String(s.soundType || s.class || 'other').toLowerCase();
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key).items.push(s);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => (b.items.length - a.items.length) || a.label.localeCompare(b.label));
  return groups;
}

function groupSounds(sounds, mode) {
  return mode === 'month' ? groupByMonth(sounds) : groupByType(sounds);
}

export default function App() {
  const padRef = useRef(null);
  const auditionRef = useRef(null);
  const replayAfterRenderRef = useRef(false);
  // Lets an AI (or other labelled) edit stamp the next trajectory snapshot; consumed by handleEval.
  const pendingLabelRef = useRef(null);

  const [user, setUser] = useState(null);
  const [source, setSource] = useState('public'); // 'public' | 'garden'
  const [sounds, setSounds] = useState([]);
  const [loadingSounds, setLoadingSounds] = useState(false);
  const [soundsError, setSoundsError] = useState('');
  const [query, setQuery] = useState('');
  const [groupMode, setGroupMode] = useState('month'); // 'month' | 'type' — dates decoded from ULIDs
  const [encoder, setEncoder] = useState('clap');
  const [searchResults, setSearchResults] = useState(null); // null = browse; array = semantic results
  const [searching, setSearching] = useState(false);
  const [searchDesc, setSearchDesc] = useState(''); // what the current results are for (header)
  // kit entry: { name, soundId, evoRunId, previewUrl, url, duration, label, settings, rendering }
  const [kit, setKit] = useState([]);
  const [settingsFor, setSettingsFor] = useState(null);
  const [auditionId, setAuditionId] = useState(null);
  const [status, setStatus] = useState('');

  const [trajectory, setTrajectory] = useState([]);
  const [scrubIndex, setScrubIndex] = useState(null);

  const [showLogin, setShowLogin] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [showBounce, setShowBounce] = useState(false);
  const [currentSequence, setCurrentSequence] = useState(null); // { id, title, description, visibility, tags }
  const [saveInitialTitle, setSaveInitialTitle] = useState('');
  const [pendingOpenId, setPendingOpenId] = useState(null); // ?seq=<id> deep link
  const [padReady, setPadReady] = useState(false);
  const [showConcepts, setShowConcepts] = useState(false);
  const [selection, setSelection] = useState(null); // { from, to, text } | null (editor selection)
  const [explainItems, setExplainItems] = useState(null); // concept[] | null ("explain this")

  // Ask-AI (bring-your-own-endpoint) state — see lib/llm.js.
  const [aiEndpoint, setAiEndpoint] = useState(() => llm.loadEndpoint());
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState(null); // { kind:'info'|'error', text } | null

  const flash = useCallback((msg) => {
    setStatus(msg);
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setStatus(''), 3000);
  }, []);

  // On load: adopt an SSO token handed off from the main app (#token=…), else
  // restore any existing same-origin session. Also pick up a ?seq=<id> deep link.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const adopted = await api.adoptTokenFromHash();
      if (cancelled) return;
      setUser(adopted || api.restoreSession());
      try {
        // Keep ?seq in the URL so it stays shareable (composing.synth.is/?seq=<id>).
        const seq = new URLSearchParams(window.location.search).get('seq');
        if (seq) setPendingOpenId(seq);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Open a deep-linked composition once the editor is ready (setCode needs it).
  useEffect(() => {
    if (!padReady || !pendingOpenId) return;
    let cancelled = false;
    (async () => {
      try {
        const seq = await api.getSequence(pendingOpenId);
        if (!cancelled && seq) handleOpen(seq);
      } catch (e) {
        if (!cancelled) flash(`Couldn't open that composition: ${(e.message || '').slice(0, 80)}`);
      } finally {
        if (!cancelled) setPendingOpenId(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padReady, pendingOpenId]);

  // After a kit sound is re-rendered, re-apply it to the live session (if playing)
  // so changed render settings are heard without a manual re-Play.
  useEffect(() => {
    if (!replayAfterRenderRef.current) return;
    replayAfterRenderRef.current = false;
    padRef.current?.reevaluate?.();
  }, [kit]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingSounds(true);
      setSoundsError('');
      try {
        const list = source === 'garden'
          ? await api.fetchGardenSounds(user.id)
          : await api.fetchPublicSounds({ orderBy: 'recent', limit: 200 });
        if (!cancelled) setSounds(list);
      } catch (err) {
        if (!cancelled) { setSounds([]); setSoundsError(err.message || 'Failed to load sounds'); }
      } finally {
        if (!cancelled) setLoadingSounds(false);
      }
    }
    if (source === 'garden' && !user) return;
    if (source === 'search') return; // results come from runSearch, not this loader
    load();
    return () => { cancelled = true; };
  }, [source, user]);

  const chooseSource = (next) => {
    if (next === 'garden' && !user) { setShowLogin(true); return; }
    setSource(next);
  };

  // --- kit ---
  const getKitMap = useCallback(
    () => Object.fromEntries(kit.filter((k) => k.url).map((k) => [k.name, k.url])),
    [kit]
  );

  // Duplicates are allowed on purpose: the same genome can be added again to get a
  // second Strudel key rendered at different settings.
  const addToKit = (sound) => {
    const taken = new Set(kit.map((k) => k.name));
    const name = api.uniqueSampleName(sound, taken);
    const entry = {
      name,
      soundId: sound.id,
      evoRunId: getEvoRunId(sound),
      previewUrl: sound.previewUrl || null,
      url: sound.previewUrl || null,
      duration: sound.duration ?? null,
      label: sound.label,
      settings: null,
      rendering: false,
    };
    setKit((prev) => [...prev, entry]);
    flash(`Added as s("${name}")`);
    // Use the pre-rendered preview WAV when the sound has one (instant); only render
    // on demand when it doesn't. (Preview presence comes from audio_preview_url.)
    if (!entry.previewUrl) renderKitEntry(entry);
  };

  const removeFromKit = (name) => {
    setKit((prev) => prev.filter((k) => k.name !== name));
    if (settingsFor === name) setSettingsFor(null);
  };

  // Changing settings reverts the key to the preview render until it's re-rendered
  // (rendering is a network call, triggered explicitly via the panel's Render button).
  const updateKitSettings = (name, patch) => {
    setKit((prev) => prev.map((k) => {
      if (k.name !== name) return k;
      const merged = { ...DEFAULT_RENDER, ...(k.settings || {}), ...patch };
      const settings = isDefaultSettings(merged) ? null : merged;
      // Default reverts to the preview URL if the sound has one; custom (or no preview)
      // clears it until an on-demand render (Render button / auto on add).
      const url = (!settings && k.previewUrl) ? k.previewUrl : null;
      return { ...k, settings, url, rendering: false };
    }));
  };

  const renderKitEntry = useCallback(async (entry) => {
    if (!entry) return;
    const s = entry.settings || {};
    setKit((prev) => prev.map((k) => (k.name === entry.name ? { ...k, rendering: true } : k)));
    try {
      const duration = s.duration ?? entry.duration ?? 2;
      const url = await renderToWavUrl(entry.soundId, entry.evoRunId, {
        duration,
        noteDelta: s.noteDelta ?? 0,
        velocity: s.velocity ?? 1,
      });
      setKit((prev) => prev.map((k) => (k.name === entry.name ? { ...k, url, rendering: false } : k)));
      replayAfterRenderRef.current = true; // re-apply to the live session if it's playing
      flash(`Rendered ${entry.name}`);
    } catch (e) {
      setKit((prev) => prev.map((k) => (k.name === entry.name ? { ...k, rendering: false } : k)));
      flash(`Render failed: ${(e.message || '').slice(0, 90)}`);
    }
  }, [flash]);

  const copyToken = async (name) => {
    const token = `s("${name}")`;
    try { await navigator.clipboard.writeText(token); flash(`Copied ${token}`); }
    catch { flash(`Type: ${token}`); }
  };

  // --- audition (independent of Strudel; always the preview) ---
  const audition = async (sound) => {
    const a = auditionRef.current;
    if (!a) return;
    if (auditionId === sound.id) { a.pause(); setAuditionId(null); return; }

    const playUrl = (url) => { a.src = url; return a.play().then(() => setAuditionId(sound.id)); };
    const render = async () => {
      flash(`Rendering ${sound.label}…`);
      const url = await renderToWavUrl(sound.id, getEvoRunId(sound), { duration: sound.duration ?? 2, noteDelta: 0, velocity: 1 });
      return playUrl(url);
    };
    try {
      // Prefer the pre-rendered preview (instant); fall back to a render if it fails
      // or the sound has no preview.
      if (sound.previewUrl) await playUrl(sound.previewUrl).catch(() => render());
      else await render();
    } catch (e) {
      flash(`Could not play: ${(e.message || '').slice(0, 80)}`);
    }
  };

  // --- trajectory ---
  const handleEval = useCallback((code) => {
    const label = pendingLabelRef.current || '';
    pendingLabelRef.current = null;
    setTrajectory((prev) => appendSnapshot(prev, makeSnapshot(code, kit, label)));
    setScrubIndex(null);
  }, [kit]);

  const scrubTo = (idx) => {
    const snap = trajectory[idx];
    if (!snap) return;
    setScrubIndex(idx);
    padRef.current?.setCode(snap.code);
    // Blob URLs from a past session are gone; revert to preview (custom keys re-render on demand).
    setKit((snap.kit || []).map((k) => ({ ...k, settings: k.settings || null, url: k.previewUrl, rendering: false })));
  };

  const removeSnapshot = (idx) => {
    setTrajectory((prev) => prev.filter((_, i) => i !== idx));
    setScrubIndex((si) => {
      const newLen = trajectory.length - 1; // length before this removal
      if (newLen <= 0) return null;         // emptied → back to live
      if (si == null) return null;          // was live; new latest becomes current
      const n = idx < si ? si - 1 : si;     // shift left if a prior step was removed
      return Math.max(0, Math.min(n, newLen - 1));
    });
  };

  // --- save / open ---
  const requireAuth = () => { if (!user) { setShowLogin(true); return false; } return true; };

  // Don't persist ephemeral blob URLs or transient flags.
  const buildState = () => {
    const cleanKit = kit.map(({ url, rendering, ...rest }) => rest);
    return { environment: 'strudel', code: padRef.current?.getCode() || '', kit: cleanKit, trajectory };
  };

  const handleSave = async (meta) => { // create a NEW composition (from the Save dialog)
    if (!requireAuth()) return;
    try {
      const saved = await api.createSequence({ ...meta, state: buildState() });
      setCurrentSequence({
        id: saved.id,
        title: saved.title || meta.title || 'Untitled composition',
        description: saved.description ?? meta.description ?? '',
        visibility: saved.visibility ?? meta.visibility ?? 'private',
        tags: saved.tags ?? meta.tags ?? [],
      });
      setShowSave(false);
      flash(`Saved "${saved.title || meta.title}"`);
    } catch (err) {
      flash(err.message?.slice(0, 120) || 'Save failed');
    }
  };

  // Update the current composition in place (stable id). The backend now persists
  // unit_state_json, so this is a true PATCH of metadata + content.
  const saveInPlace = async () => {
    if (!currentSequence) return;
    try {
      const updated = await api.updateSequence(currentSequence.id, {
        title: currentSequence.title,
        description: currentSequence.description || '',
        visibility: currentSequence.visibility || 'private',
        tags: currentSequence.tags || [],
        state: buildState(),
      });
      setCurrentSequence({
        id: updated.id || currentSequence.id,
        title: updated.title ?? currentSequence.title,
        description: updated.description ?? currentSequence.description ?? '',
        visibility: updated.visibility ?? currentSequence.visibility ?? 'private',
        tags: updated.tags ?? currentSequence.tags ?? [],
      });
      flash(`Saved "${updated.title || currentSequence.title}"`);
    } catch (err) {
      flash(err.message?.slice(0, 120) || 'Save failed');
    }
  };

  const onSavePrimary = () => {
    if (!requireAuth()) return;
    if (currentSequence) saveInPlace();
    else { setSaveInitialTitle(''); setShowSave(true); }
  };

  const onSaveAs = () => {
    if (!requireAuth()) return;
    setSaveInitialTitle(currentSequence ? `${currentSequence.title} copy` : '');
    setShowSave(true);
  };

  const changeVisibility = async (visibility) => {
    if (!currentSequence) return;
    try {
      const updated = await api.updateSequenceMeta(currentSequence.id, { visibility });
      setCurrentSequence((cs) => ({ ...cs, visibility: updated?.visibility ?? visibility }));
      flash(visibility === 'public'
        ? 'Now public — anyone with the link can open it'
        : 'Now private — only you can open it');
    } catch (e) {
      flash(`Couldn't change visibility: ${(e.message || '').slice(0, 90)}`);
    }
  };

  const copyShareLink = async () => {
    if (!currentSequence) return;
    const url = `${window.location.origin}/?seq=${currentSequence.id}`;
    try {
      await navigator.clipboard.writeText(url);
      flash(currentSequence.visibility === 'private'
        ? "Link copied — but it's private, so only you can open it"
        : 'Shareable link copied');
    } catch { flash('Copy failed'); }
  };

  const handleOpen = (seq) => {
    const st = seq.unitState || {};
    setKit((Array.isArray(st.kit) ? st.kit : []).map((k) => ({ ...k, url: k.previewUrl, rendering: false })));
    setTrajectory(Array.isArray(st.trajectory) ? st.trajectory : []);
    setScrubIndex(null);
    padRef.current?.setCode(st.code || '');
    // Only make it the "current" (in-place-savable) composition if the signed-in
    // user owns it; otherwise it's a starting point and Save creates their own copy.
    const owned = user && seq.userId === user.id;
    setCurrentSequence(owned ? {
      id: seq.id,
      title: seq.title || 'Untitled',
      description: seq.description || '',
      visibility: seq.visibility || 'private',
      tags: seq.tags || [],
    } : null);
    setShowOpen(false);
    flash(owned ? `Opened "${seq.title}"` : `Opened "${seq.title}" — Save will create your copy`);
  };

  // --- Ableton ---
  const sendStems = () => {
    if (!kit.length) { flash('Add sounds to the kit first'); return; }
    const ok = sendToLive(buildStemsSelection(kit));
    if (!ok) flash('Not running inside Live — payload logged to console');
  };
  const runBounce = async (seconds) => {
    try {
      flash('Bouncing…');
      const { wav, durationSecs } = await bounceToWav({ padRef, seconds });
      const wavBase64 = bytesToBase64(wav);
      const ok = sendToLive({
        version: 1,
        items: [{ soundId: 'composition', name: 'Composition', duration: durationSecs, wavBase64 }],
      });
      // NB: landing this in Live needs the extension's wavBase64 short-circuit
      // (see docs/ABLETON_BRIDGE.md); stems export works without it.
      flash(ok ? 'Sent bounce to Live' : 'Not in Live — bounce logged to console');
    } catch (e) {
      flash(e.message?.slice(0, 140) || 'Bounce failed');
    }
  };

  const env = getEnvironment('strudel');
  const renderAll = () => {
    kit.forEach((k) => { if (!k.url && !k.rendering) renderKitEntry(k); });
  };
  const insertStarter = () => {
    padRef.current?.setCode(env.makeStarter(kit));
    renderAll();
    flash('Inserted a starter pattern');
  };
  const surpriseMe = () => {
    padRef.current?.setCode(env.makeRandom(kit));
    renderAll();
    flash('Surprise!');
  };
  const copyPattern = async (text) => {
    try { await navigator.clipboard.writeText(text); flash('Copied — paste into the editor'); }
    catch { flash('Copy failed'); }
  };

  // Learning surfaces (concept palette + select-and-transform + explain), all
  // backed by lib/concepts.js.
  const applyTransform = (concept) => {
    if (!selection || !concept.apply) return;
    const next = padRef.current?.replaceSelection(concept.apply(selection.text));
    setSelection(next || null);   // keep the new range selected so transforms can chain
    setExplainItems(null);
    padRef.current?.play();        // hear the result (and snapshot the trajectory)
    flash(concept.label);
  };
  const insertConcept = (concept) => {
    const code = concept.example ? concept.example(conceptNames(kit)) : '';
    if (!code) return;
    padRef.current?.setCode(code);
    setShowConcepts(false);
    renderAll();
    padRef.current?.play();
    flash(`Inserted: ${concept.label}`);
  };
  const explainSelection = () => {
    if (selection) setExplainItems(explainConcepts(selection.text));
  };

  // --- Ask AI (plain-English edits via the user's own endpoint) ---
  const saveAiEndpoint = (cfg) => {
    llm.saveEndpoint(cfg);
    setAiEndpoint(cfg);
    setShowAiSettings(false);
    flash('AI endpoint saved');
  };
  const clearAiEndpoint = () => {
    llm.clearEndpoint();
    setAiEndpoint(null);
    setShowAiSettings(false);
    flash('AI endpoint cleared');
  };
  // Keep messages readable: clip long model/runtime errors, but never clip our own
  // connection diagnostics (mixed content / CORS), whose value is in the detail.
  const briefErr = (s) => {
    const t = (s || '').toString().replace(/\s+/g, ' ').trim();
    if (/mixed content|CORS|Couldn't reach/i.test(t)) return t;
    return t.length > 110 ? t.slice(0, 110) + '…' : t;
  };

  // Ask the model, then validate the result against Strudel; on failure, one
  // repair pass (re-prompt with the error). Returns runnable code, or null (with
  // aiStatus set to explain). Steps are surfaced via aiStatus so they're visible.
  const generateValidated = async (instruction, code, selection) => {
    setAiStatus({ kind: 'info', text: 'Asking the model…' });
    let out = ((await llm.askEdit({ instruction, code, selection, kit, env, endpoint: aiEndpoint })).code || '').trim();
    if (!out) { setAiStatus({ kind: 'error', text: 'The model returned no code.' }); return null; }
    setAiStatus({ kind: 'info', text: 'Checking it runs…' });
    let check = await padRef.current?.validate?.(out);
    if (check && !check.ok) {
      setAiStatus({ kind: 'info', text: `Didn't run (${briefErr(check.error)}) — asking for a fix…` });
      const repair = `${instruction}\n\nYour previous attempt did not run. Error:\n${check.error}\nReturn corrected code that runs in this version of Strudel, using only functions that exist. Output only code.`;
      const fixed = ((await llm.askEdit({ instruction: repair, code, selection, kit, env, endpoint: aiEndpoint })).code || '').trim();
      if (fixed) { out = fixed; check = await padRef.current?.validate?.(out); }
    }
    if (check && !check.ok) {
      setAiStatus({ kind: 'error', text: `Still didn't run: ${briefErr(check.error)} — not applied. Try rephrasing.` });
      return null;
    }
    return out;
  };

  const askAi = async (instruction) => {
    const text = (instruction || '').trim();
    if (!text) return;
    if (!llm.isConfigured(aiEndpoint)) { setShowAiSettings(true); return; }
    const code = padRef.current?.getCode?.() ?? '';
    const sel = padRef.current?.getSelection?.() || null;
    setAiBusy(true);
    try {
      const out = await generateValidated(text, code, sel);
      if (!out) return; // aiStatus already explains
      const label = text.length > 60 ? text.slice(0, 60) + '…' : text;
      pendingLabelRef.current = `AI · ${aiEndpoint.model || aiEndpoint.provider}: ${label}`;
      if (sel) setSelection(padRef.current?.replaceSelection(out) || null);
      else { padRef.current?.setCode(out); setSelection(null); }
      padRef.current?.play(); // hear it, and snapshot the (labelled) trajectory step
      setAiStatus({ kind: 'info', text: 'Applied ✓' });
    } catch (e) {
      pendingLabelRef.current = null;
      setAiStatus({ kind: 'error', text: `AI failed: ${briefErr(e.message)}` });
    } finally {
      setAiBusy(false);
    }
  };

  // --- Fit a sound in: describe the kit sound, then ask the model to arrange it ---
  const fitSoundIn = async (entry) => {
    if (!entry) return;
    if (!llm.isConfigured(aiEndpoint)) { setShowAiSettings(true); return; }
    setAiBusy(true);
    flash(`Describing ${entry.name}…`);
    try {
      let desc = null;
      try {
        if (entry.soundId) desc = await api.describeSound(entry.soundId);
      } catch { /* description is best-effort — arrange by name alone if it fails */ }
      const tags = (desc?.tags || []).slice(0, 8);
      const labelBits = desc?.perceptual_labels ? Object.values(desc.perceptual_labels).filter(Boolean) : [];
      const sonic = [...new Set([...(desc?.sound_type ? [desc.sound_type] : []), ...labelBits, ...tags])].join(', ');
      const code = padRef.current?.getCode?.() ?? '';
      const instruction = sonic
        ? `Weave the existing kit sound s("${entry.name}") into this pattern so it fits musically. That sound is: ${sonic}. Keep what's already there and add this sound tastefully — as rhythm, a layer, or a complementary part.`
        : `Weave the existing kit sound s("${entry.name}") into this pattern so it fits musically. Keep what's already there and add it tastefully.`;
      flash(`Fitting ${entry.name} in…`);
      const { code: out } = await llm.askEdit({ instruction, code, selection: null, kit, env, endpoint: aiEndpoint });
      const clean = (out || '').trim();
      if (!clean) { flash('AI returned no code'); return; }
      pendingLabelRef.current = `AI · fit ${entry.name}`;
      padRef.current?.setCode(clean);
      setSelection(null);
      padRef.current?.play(); // hear it, and snapshot the (labelled) trajectory step
    } catch (e) {
      pendingLabelRef.current = null;
      flash(`Fit failed: ${(e.message || '').slice(0, 120)}`);
    } finally {
      setAiBusy(false);
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (q.length < 2) { flash('Type at least 2 characters'); return; }
    setSearchDesc(q);
    setSearching(true);
    try {
      const results = await api.semanticSearch(q, { encoder, topK: 48 });
      setSearchResults(results);
      if (!results.length) flash('No matches');
    } catch (e) {
      setSearchResults([]);
      flash(`Search failed: ${(e.message || '').slice(0, 90)}`);
    } finally {
      setSearching(false);
    }
  };

  const findSimilar = async (sound) => {
    setSource('search');
    setQuery('');
    setSearchDesc(`≈ ${sound.descriptors || sound.label}`);
    setSearching(true);
    try {
      const results = await api.similarToSound(sound.id, { encoder, topK: 48 });
      setSearchResults(results);
      if (!results.length) flash('No similar sounds found');
    } catch (e) {
      setSearchResults([]);
      flash(`Search failed: ${(e.message || '').slice(0, 90)}`);
    } finally {
      setSearching(false);
    }
  };

  const filtered = query.trim()
    ? sounds.filter((s) =>
        (s.label + ' ' + s.id + ' ' + (s.soundType || '') + ' ' + (s.descriptors || '')).toLowerCase().includes(query.toLowerCase()))
    : sounds;

  const openEntry = kit.find((k) => k.name === settingsFor) || null;

  return (
    <div className="app">
      <audio ref={auditionRef} onEnded={() => setAuditionId(null)} hidden />

      <header className="topbar">
        <div className="brand">Synth.is · <span className="brand-accent">Composing</span></div>
        <a className="btn ghost" href={api.SYNTHIS_APP_URL} title="Back to Synth.is">← Synth.is</a>
        <div className="spacer" />
        {ABLETON && (
          <>
            <button className="btn ghost" onClick={() => setShowBounce(true)} title="Bounce the composition to one clip">→ Live (bounce)</button>
            <button className="btn" onClick={sendStems} title="Send kit sounds as stems, with their render settings">→ Live (stems)</button>
            <span style={{ width: 10 }} />
          </>
        )}
        <button className="btn ghost" onClick={() => setShowOpen(true)} disabled={!user}>Open…</button>
        {currentSequence && (
          <span className="who current-seq" title="Current composition">{currentSequence.title}</span>
        )}
        {currentSequence && (
          <button
            className="btn ghost"
            onClick={() => changeVisibility(currentSequence.visibility === 'public' ? 'private' : 'public')}
            title={currentSequence.visibility === 'public'
              ? 'Public — anyone with the link can open it. Click to make private.'
              : 'Private — only you can open it. Click to make public.'}
          >
            {currentSequence.visibility === 'public' ? '🌐 Public' : '🔒 Private'}
          </button>
        )}
        {currentSequence && (
          <button className="btn ghost" onClick={copyShareLink} title="Copy a shareable link to this composition">🔗 Link</button>
        )}
        <button className="btn" onClick={onSavePrimary} title={currentSequence ? `Save changes to “${currentSequence.title}”` : 'Save composition'}>Save</button>
        {currentSequence && (
          <button className="btn ghost" onClick={onSaveAs} title="Save as a new composition">Save As…</button>
        )}
        {user ? (
          <div className="auth">
            <span className="who">{user.displayName || user.username}</span>
            <button className="btn ghost" onClick={() => { api.logout(); setUser(null); if (source === 'garden') setSource('public'); }}>Sign out</button>
          </div>
        ) : (
          <button className="btn ghost" onClick={() => setShowLogin(true)}>Sign in</button>
        )}
      </header>

      <main className="layout">
        <aside className="sidebar">
          <div className="source-toggle">
            <button className={source === 'public' ? 'seg active' : 'seg'} onClick={() => chooseSource('public')}>Community</button>
            <button className={source === 'garden' ? 'seg active' : 'seg'} onClick={() => chooseSource('garden')}>My garden</button>
            <button className={source === 'search' ? 'seg active' : 'seg'} onClick={() => chooseSource('search')}>Search</button>
          </div>
          {source === 'search' ? (
            <>
              <input
                className="search"
                placeholder="Describe a sound… (e.g. warm pad)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              />
              <div className="group-by">
                <span className="muted small">Model</span>
                <select value={encoder} onChange={(e) => setEncoder(e.target.value)}>
                  {api.SEARCH_ENCODERS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <span className="spacer" />
                <button className="btn tiny" onClick={runSearch} disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
              </div>
            </>
          ) : (
            <>
              <input className="search" placeholder="Filter sounds…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="group-by">
                <span className="muted small">Group by</span>
                <select value={groupMode} onChange={(e) => setGroupMode(e.target.value)}>
                  <option value="type">Type</option>
                  <option value="month">Month</option>
                </select>
              </div>
            </>
          )}
          <div className="sound-list">
            {source === 'search' ? (
              <>
                {searching && <div className="muted" style={{ padding: 10 }}>Searching…</div>}
                {searchResults === null && !searching && (
                  <div className="muted" style={{ padding: 10 }}>Describe a sound and press Search to find matches by meaning across the platform.</div>
                )}
                {searchResults && searchResults.length === 0 && !searching && <div className="muted" style={{ padding: 10 }}>No matches.</div>}
                {searchResults && searchResults.length > 0 && (
                  <div className="sound-group">
                    <div className="sound-group-head">Results{searchDesc ? ` · ${searchDesc}` : ''} <span className="muted">· {searchResults.length}</span></div>
                    {searchResults.map((s) => (
                      <SoundCard
                        key={s.id}
                        sound={s}
                        initialSpec={s.spec}
                        playing={auditionId === s.id}
                        onAudition={() => audition(s)}
                        onAdd={() => addToKit(s)}
                        onFindSimilar={() => findSimilar(s)}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {loadingSounds && <div className="muted">Loading…</div>}
                {soundsError && <div className="error">{soundsError}</div>}
                {!loadingSounds && !soundsError && filtered.length === 0 && <div className="muted">No sounds.</div>}
                {groupSounds(filtered, groupMode).map((g) => (
                  <div className="sound-group" key={g.key}>
                    <div className="sound-group-head">{g.label} <span className="muted">· {g.items.length}</span></div>
                    {g.items.map((s) => (
                      <SoundCard
                        key={s.id}
                        sound={s}
                        playing={auditionId === s.id}
                        onAudition={() => audition(s)}
                        onAdd={() => addToKit(s)}
                        onFindSimilar={() => findSimilar(s)}
                      />
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>

        <section className="workspace">
          <div className="kit">
            <div className="kit-head">
              <span>Kit ({kit.length})</span>
              <span className="muted small">click a name to copy · ⚙ for render settings</span>
            </div>
            <div className="kit-chips">
              {kit.length === 0 && <span className="muted">Add sounds to register them as Strudel samples.</span>}
              {kit.map((k) => {
                const custom = !isDefaultSettings(k.settings);
                const marker = k.rendering ? '⋯ ' : !k.url ? '○ ' : custom ? '● ' : '';
                return (
                  <span className="chip" key={k.name}>
                    <button className="chip-name" title='Copy s("name")' onClick={() => copyToken(k.name)}>
                      {marker}{k.name}
                    </button>
                    <button className="chip-x" title="Fit this sound into the pattern (AI)" disabled={aiBusy} onClick={() => fitSoundIn(k)}>✦</button>
                    <button className="chip-x" title="Render settings" onClick={() => setSettingsFor(settingsFor === k.name ? null : k.name)}>⚙</button>
                    <button className="chip-x" title="Remove" onClick={() => removeFromKit(k.name)}>×</button>
                  </span>
                );
              })}
            </div>

            {openEntry && (
              <SettingsPanel
                entry={openEntry}
                onChange={(patch) => updateKitSettings(openEntry.name, patch)}
                onReset={() => updateKitSettings(openEntry.name, DEFAULT_RENDER)}
                onRender={() => renderKitEntry(openEntry)}
                onClose={() => setSettingsFor(null)}
              />
            )}
          </div>

          {trajectory.length > 0 && (
            <TrajectoryBar
              trajectory={trajectory}
              scrubIndex={scrubIndex}
              onScrub={scrubTo}
              onRemove={removeSnapshot}
              onClear={() => { setTrajectory([]); setScrubIndex(null); }}
            />
          )}

          <HintsBar
            env={env}
            kit={kit}
            onInsertStarter={insertStarter}
            onSurprise={surpriseMe}
            onCopy={copyPattern}
            onBrowseConcepts={() => setShowConcepts(true)}
          />

          {selection && (
            <SelectionBar
              selection={selection}
              transforms={conceptTransforms('strudel', true)}
              explainItems={explainItems}
              onApply={applyTransform}
              onExplain={explainSelection}
              onClearExplain={() => setExplainItems(null)}
            />
          )}

          <AskAiBar
            configured={llm.isConfigured(aiEndpoint)}
            busy={aiBusy}
            hasSelection={!!selection}
            onAsk={askAi}
            onOpenSettings={() => setShowAiSettings(true)}
          />
          {aiStatus && (
            <div className="muted small" style={{ margin: '-4px 0 2px', color: aiStatus.kind === 'error' ? '#e06c6c' : undefined }}>
              {aiStatus.text}
            </div>
          )}

          <StrudelPad
            ref={padRef}
            getKitMap={getKitMap}
            onEval={handleEval}
            onReady={() => setPadReady(true)}
            onSelectionChange={(sel) => { setSelection(sel); if (!sel) setExplainItems(null); }}
          />
        </section>
      </main>

      {status && <div className="toast">{status}</div>}

      {showLogin && <LoginDialog onClose={() => setShowLogin(false)} onLoggedIn={(u) => { setUser(u); setShowLogin(false); }} />}
      {showSave && <SaveDialog initialTitle={saveInitialTitle} onClose={() => setShowSave(false)} onSave={handleSave} />}
      {showOpen && <OpenDialog onClose={() => setShowOpen(false)} onOpen={handleOpen} />}
      {showBounce && (
        <BounceDialog
          cps={padRef.current?.getCps?.()}
          onClose={() => setShowBounce(false)}
          onBounce={(secs) => { setShowBounce(false); runBounce(secs); }}
        />
      )}
      {showConcepts && (
        <ConceptsModal kit={kit} onInsert={insertConcept} onCopy={copyPattern} onClose={() => setShowConcepts(false)} />
      )}
      {showAiSettings && (
        <AiSettingsDialog
          initial={aiEndpoint}
          onClose={() => setShowAiSettings(false)}
          onSave={saveAiEndpoint}
          onClear={clearAiEndpoint}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
function SoundCard({ sound, playing, onAudition, onAdd, initialSpec, onFindSimilar }) {
  const ref = useRef(null);
  const [spec, setSpec] = useState(initialSpec ?? undefined); // undefined = not fetched, null = none, string = url

  useEffect(() => {
    if (initialSpec) return; // provided inline (e.g. search results)
    const el = ref.current;
    if (!el) return;
    let done = false;
    // Lazy-load the spectrogram only when the card nears the viewport (gentle on the API).
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !done) {
        done = true;
        io.disconnect();
        api.fetchSpectrogramUrl(sound.id).then(setSpec).catch(() => setSpec(null));
      }
    }, { rootMargin: '250px' });
    io.observe(el);
    return () => io.disconnect();
  }, [sound.id, initialSpec]);

  const dur = sound.duration ? `${Number(sound.duration).toFixed(1)}s` : null;
  const sub = [sound.soundType || sound.class, dur].filter(Boolean).join(' · ');
  const title = sound.descriptors || sound.label;

  return (
    <div className="sound-card" ref={ref} title={sound.id}>
      <button className="spec-wrap" onClick={onAudition} title="Audition">
        {spec
          ? <img className="spec-img" src={spec} alt="" loading="lazy" />
          : <div className={`spec-ph${spec === undefined ? ' loading' : ''}`} />}
        <span className="spec-play">{playing ? '❚❚' : '▶'}</span>
      </button>
      <div className="sound-card-row">
        <div className="sound-card-meta">
          <div className="sound-label">{title}</div>
          {sub && <div className="sound-sub">{sub}</div>}
        </div>
        {onFindSimilar && <button className="btn tiny ghost" title="Find similar sounds" onClick={onFindSimilar}>≈</button>}
        <button className="btn tiny" title="Add to kit" onClick={onAdd}>+ kit</button>
      </div>
    </div>
  );
}

function HintsBar({ env, kit, onInsertStarter, onSurprise, onCopy, onBrowseConcepts }) {
  const hints = env.hints(kit);
  return (
    <div className="hints">
      <div className="hints-head">
        <span className="muted small">
          Tip: only the <em>last</em> expression plays. <strong>Select part of your code</strong> to transform it, or open <strong>Concepts</strong> to browse what's possible.
        </span>
        <span className="spacer" />
        <a className="hints-doc" href={env.docsUrl} target="_blank" rel="noopener noreferrer">{env.label} guide ↗</a>
      </div>
      <div className="hints-actions">
        <button className="btn tiny" onClick={onInsertStarter}>Insert starter</button>
        <button className="btn tiny ghost" onClick={onSurprise}>Surprise me</button>
        <button className="btn tiny ghost" onClick={onBrowseConcepts}>Concepts ▤</button>
        <span className="hints-sep" />
        {hints.map((h) => (
          <button key={h.label} className="hint-chip" title={`Copy: ${h.code}`} onClick={() => onCopy(h.code)}>{h.label}</button>
        ))}
      </div>
    </div>
  );
}

function SelectionBar({ selection, transforms, explainItems, onApply, onExplain, onClearExplain }) {
  const snippet = (selection.text.length > 44 ? selection.text.slice(0, 44) + '…' : selection.text).replace(/\n/g, ' ');
  const grouped = [];
  const gi = new Map();
  for (const t of transforms) {
    if (!gi.has(t.category)) { const g = { category: t.category, items: [] }; gi.set(t.category, g); grouped.push(g); }
    gi.get(t.category).items.push(t);
  }
  return (
    <div className="selbar">
      <div className="selbar-head">
        <span className="muted small">selected:</span>
        <code className="selbar-snippet" title={selection.text}>{snippet}</code>
        <span className="spacer" />
        <button className="btn tiny" onClick={onExplain}>Explain this</button>
      </div>
      <div className="selbar-actions">
        {grouped.map((g) => (
          <div key={g.category} className="selbar-group">
            <span className="selbar-cat">{g.category}</span>
            {g.items.map((t) => (
              <button key={t.id} className="hint-chip" title={t.explain} onClick={() => onApply(t)}>{t.label}</button>
            ))}
          </div>
        ))}
      </div>
      {explainItems && (
        <div className="explain">
          <div className="explain-head">
            <span className="muted small">What this does</span>
            <span className="spacer" />
            <button className="btn tiny ghost" onClick={onClearExplain}>×</button>
          </div>
          {explainItems.length === 0
            ? <div className="muted small">No recognised features in the selection — try selecting a function like <code>.fast(2)</code>, or a pattern in quotes.</div>
            : <ul className="explain-list">{explainItems.map((c) => (<li key={c.id}><strong>{c.label}</strong> — {c.explain}</li>))}</ul>}
        </div>
      )}
    </div>
  );
}

function ConceptsModal({ kit, onInsert, onCopy, onClose }) {
  const names = conceptNames(kit);
  const groups = conceptsByCategory('strudel');
  const [midi, setMidi] = useState(null); // null | 'loading' | { supported, inputs, outputs }
  const loadMidi = async () => {
    setMidi('loading');
    try {
      if (!navigator.requestMIDIAccess) { setMidi({ supported: false }); return; }
      const access = await navigator.requestMIDIAccess();
      setMidi({
        supported: true,
        inputs: [...access.inputs.values()].map((d) => d.name).filter(Boolean),
        outputs: [...access.outputs.values()].map((d) => d.name).filter(Boolean),
      });
    } catch (e) { setMidi({ supported: false, error: e.message }); }
  };
  return (
    <Modal title="Concepts — what you can do" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Insert an example to try it with your kit, then tweak and play — or select code in the editor to transform it.
      </p>
      <div className="midi-devices">
        <div className="midi-devices-head">
          <span className="muted small">MIDI devices — for the Control / MIDI recipes</span>
          <span className="spacer" />
          <button className="btn tiny" onClick={loadMidi}>{midi === 'loading' ? 'Detecting…' : 'Detect'}</button>
        </div>
        {midi && midi !== 'loading' && !midi.supported && (
          <div className="muted small">Web MIDI isn’t available in this browser.</div>
        )}
        {midi && midi !== 'loading' && midi.supported && (
          (midi.inputs.length + midi.outputs.length) === 0
            ? <div className="muted small">No devices found — connect one and Detect again.</div>
            : <div className="midi-devices-list">
                {midi.inputs.map((nm) => (
                  <button key={'i' + nm} className="hint-chip" title="Copy — use in midin() / midikeys()" onClick={() => onCopy(nm)}>in · {nm}</button>
                ))}
                {midi.outputs.map((nm) => (
                  <button key={'o' + nm} className="hint-chip" title="Copy — use in .midi()" onClick={() => onCopy(nm)}>out · {nm}</button>
                ))}
              </div>
        )}
      </div>
      <div className="concepts-scroll">
        {groups.map((g) => (
          <div key={g.category} className="concept-group">
            <div className="concept-cat">{g.category}</div>
            {g.items.map((c) => {
              const ex = c.example ? c.example(names) : null;
              return (
                <div key={c.id} className="concept-card">
                  <div className="concept-card-top">
                    <span className="concept-label">{c.label}</span>
                    <span className="muted small">{c.explain}</span>
                  </div>
                  {ex ? (
                    <div className="concept-example">
                      <code className="concept-code">{ex}</code>
                      <div className="concept-btns">
                        <button className="btn tiny" onClick={() => onInsert(c)}>Insert</button>
                        <button className="btn tiny ghost" onClick={() => onCopy(ex)}>Copy</button>
                      </div>
                    </div>
                  ) : (
                    <div className="concept-example muted small">Select code in the editor, then apply this from the selection bar.</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function SettingsPanel({ entry, onChange, onReset, onRender, onClose }) {
  const s = entry.settings || {};
  const numOrNull = (v) => (v === '' ? null : Number(v));
  const custom = !isDefaultSettings(entry.settings);
  const rendered = custom && entry.url && entry.url !== entry.previewUrl;
  return (
    <div className="settings-panel">
      <div className="settings-title">
        Render settings — <code>{entry.name}</code>
      </div>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Custom settings render the genome on demand so they’re audible in Strudel. Add the
        same sound again for a second key at different settings. They also flow to “→ Live (stems)”.
      </div>
      <div className="settings-grid">
        <label className="field">Duration (s)
          <input type="number" step="0.5" min="0.1" placeholder="preview"
            value={s.duration ?? entry.duration ?? ''} onChange={(e) => onChange({ duration: numOrNull(e.target.value) })} />
        </label>
        <label className="field">Pitch (semitones)
          <input type="number" step="1" value={s.noteDelta ?? 0} onChange={(e) => onChange({ noteDelta: Number(e.target.value) })} />
        </label>
        <label className="field">Velocity (0–1)
          <input type="number" step="0.1" min="0" max="1" value={s.velocity ?? 1} onChange={(e) => onChange({ velocity: Number(e.target.value) })} />
        </label>
      </div>
      <div className="settings-actions">
        <span className="muted small">
          {entry.rendering ? 'rendering…' : entry.url ? 'rendered ✓' : 'not rendered — click Render'}
        </span>
        <span className="spacer" />
        <button className="btn tiny ghost" onClick={onReset}>Reset</button>
        <button className="btn tiny" onClick={onRender} disabled={entry.rendering}>Render</button>
        <button className="btn tiny ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function TrajectoryBar({ trajectory, scrubIndex, onScrub, onRemove, onClear }) {
  const maxIdx = trajectory.length - 1;
  const value = scrubIndex ?? maxIdx;
  const snap = trajectory[value];
  const first = trajectory[0];
  return (
    <div className="trajectory">
      <div className="trajectory-head">
        <span>Trajectory ({trajectory.length})</span>
        <span className="muted small">{snap ? snapshotLabel(snap, value, first) : ''}{scrubIndex != null ? ' · replaying' : ' · live'}</span>
        <span className="spacer" />
        <button className="btn tiny ghost" onClick={onClear}>Clear</button>
      </div>
      <div className="trajectory-steps">
        {trajectory.map((s, i) => (
          <span key={`${s.t}-${i}`} className={i === value ? 'traj-step active' : 'traj-step'}>
            <button className="traj-step-jump" title={snapshotLabel(s, i, first)} onClick={() => onScrub(i)}>{i + 1}</button>
            <button className="traj-step-x" title="Remove this step" onClick={() => onRemove(i)}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

function LoginDialog({ onClose, onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    const r = await api.login(email.trim(), password);
    setBusy(false);
    if (r.success) onLoggedIn(r.user); else setError(r.error || 'Login failed');
  };
  return (
    <Modal title="Sign in to Synth.is" onClose={onClose}>
      <p className="muted small">Only needed for your garden and to save compositions.</p>
      <label className="field">Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </label>
      <label className="field">Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </Modal>
  );
}

function SaveDialog({ onClose, onSave, initialTitle = '' }) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('private');
  return (
    <Modal title="Save composition" onClose={onClose}>
      <label className="field">Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Untitled composition" />
      </label>
      <label className="field">Description
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">Visibility
        <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          <option value="private">Private</option>
          <option value="public">Public</option>
        </select>
      </label>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onSave({ title, description, visibility, tags: [] })}>Save</button>
      </div>
    </Modal>
  );
}

function OpenDialog({ onClose, onOpen }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.listMySequences().then(setItems).catch((e) => { setError(e.message || 'Failed to load'); setItems([]); });
  }, []);
  return (
    <Modal title="Open composition" onClose={onClose}>
      {items === null && <div className="muted">Loading…</div>}
      {error && <div className="error">{error}</div>}
      {items && items.length === 0 && !error && <div className="muted">No saved compositions yet.</div>}
      <div className="open-list">
        {items?.map((s) => (
          <button className="open-row" key={s.id} onClick={() => onOpen(s)}>
            <span className="open-title">{s.title || 'Untitled'}</span>
            <span className="open-sub">{(s.soundIds?.length || 0)} sounds · {s.visibility}</span>
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function BounceDialog({ cps, onClose, onBounce }) {
  const hasCps = typeof cps === 'number' && cps > 0;
  const [cycles, setCycles] = useState(4);
  const [seconds, setSeconds] = useState(8);
  const secs = hasCps ? cycles / cps : seconds;
  return (
    <Modal title="Bounce composition to Live" onClose={onClose}>
      <p className="muted small">
        Records the live Strudel output in real time, then sends it to Live as one audio clip.
      </p>
      {hasCps ? (
        <>
          <label className="field">Length (cycles)
            <input type="number" min="1" step="1" value={cycles}
              onChange={(e) => setCycles(Math.max(1, Number(e.target.value) || 1))} autoFocus />
          </label>
          <div className="muted small" style={{ marginBottom: 12 }}>
            ≈ {secs.toFixed(2)} s at the current tempo (cps {cps.toFixed(3)}). A whole number of cycles loops cleanly in Live.
          </div>
        </>
      ) : (
        <label className="field">Length (seconds)
          <input type="number" min="1" step="1" value={seconds}
            onChange={(e) => setSeconds(Math.max(1, Number(e.target.value) || 1))} autoFocus />
        </label>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onBounce(secs)}>Bounce &amp; send</button>
      </div>
    </Modal>
  );
}

function AskAiBar({ configured, busy, hasSelection, onAsk, onOpenSettings }) {
  const [text, setText] = useState('');
  const submit = () => { const t = text.trim(); if (t) onAsk(t); };
  return (
    <div className="askai" style={{ margin: '8px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="search"
          style={{ flex: 1 }}
          placeholder={configured
            ? (hasSelection ? 'Ask AI to change the selection…' : 'Ask AI to change the code…')
            : 'Ask AI to change the code…  (⚙ set up an endpoint first)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={busy}
        />
        <button className="btn tiny" onClick={submit} disabled={busy || !text.trim()}>{busy ? 'Asking…' : 'Ask AI'}</button>
        <button className="btn tiny ghost" title="AI endpoint settings" onClick={onOpenSettings}>⚙</button>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {hasSelection ? 'Rewrites the selected code' : 'Rewrites the whole buffer'} · runs on your own endpoint (local or cloud) · lands as an undoable trajectory step.
      </div>
    </div>
  );
}

function AiSettingsDialog({ initial, onClose, onSave, onClear }) {
  const [provider, setProvider] = useState(initial?.provider || 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || '');
  const [model, setModel] = useState(initial?.model || '');
  const [apiKey, setApiKey] = useState(initial?.apiKey || '');
  const meta = llm.providerMeta(provider);
  const canSave = !!model.trim() && (meta.keyOptional || !!apiKey.trim());
  const changeProvider = (id) => { setProvider(id); setBaseUrl(''); };
  return (
    <Modal title="AI endpoint" onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Bring your own model. Everything here is stored only in this browser and sent only to the
        endpoint you set — there is no shared key.
      </p>
      <label className="field">Provider
        <select value={provider} onChange={(e) => changeProvider(e.target.value)}>
          {llm.PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className="field">Base URL
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta.defaultBaseUrl} />
      </label>
      <label className="field">Model
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={meta.modelPlaceholder} autoFocus />
      </label>
      <label className="field">API key {meta.keyOptional && <span className="muted small">(only needed if your server requires one)</span>}
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={meta.keyOptional ? 'blank unless your server requires a key' : 'sk-…'} />
      </label>
      {meta.note && <div className="muted small" style={{ marginTop: 4 }}>{meta.note}</div>}
      <div className="modal-actions">
        {initial && <button className="btn ghost" onClick={onClear} title="Remove the saved endpoint">Clear</button>}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!canSave} onClick={() => onSave({ provider, baseUrl: (baseUrl || meta.defaultBaseUrl).trim(), model: model.trim(), apiKey: apiKey.trim() })}>Save</button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
