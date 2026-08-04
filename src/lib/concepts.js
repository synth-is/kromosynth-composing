/**
 * Onboarding / learning concept library, per live-coding environment.
 *
 * One entry can feed three surfaces:
 *   - the browsable Concepts palette      -> `example(names)` (a snippet from the kit)
 *   - select-and-transform quick actions  -> `apply(selected)` (wraps the selection)
 *   - "explain this"                       -> `match` (regex that detects the concept)
 *
 * We deliberately generate examples from the user's own kit sounds and write the
 * explanations in our own words — teaching the ideas the Strudel docs teach,
 * without reproducing their prose. `docsUrl` links out for the real thing.
 */

// Strudel concepts. `quick: true` marks the highest-value select-transforms that
// surface directly in the selection bar; the palette shows everything.
export const STRUDEL_CONCEPTS = [
  // ---- Rhythm ----
  {
    id: 'sequence', category: 'Rhythm', label: 'Sequence',
    explain: 'Play sounds one after another — they share the cycle evenly.',
    example: (n) => `s("${n.a} ${n.b} ${n.c}")`,
  },
  {
    id: 'repeat', category: 'Rhythm', label: 'Repeat', quick: true,
    explain: 'Play something several times per cycle (a*4 = four times).',
    example: (n) => `s("${n.a}*4")`,
    apply: (s) => `${s}*2`,
    match: /\*\s*\d/,
  },
  {
    id: 'euclid', category: 'Rhythm', label: 'Euclidean',
    explain: 'Spread N hits as evenly as possible across M steps — instant grooves.',
    example: (n) => `s("${n.a}(3,8)")`,
    match: /\(\s*\d+\s*,\s*\d+\s*\)/,
  },
  {
    id: 'rest', category: 'Rhythm', label: 'Rest',
    explain: 'Use ~ for a silent step, to carve out space.',
    example: (n) => `s("${n.a} ~ ${n.b} ~")`,
    match: /~/,
  },
  {
    id: 'ply', category: 'Rhythm', label: 'Subdivide (ply)', quick: true,
    explain: 'Repeat each event in place N times — like a quick roll.',
    apply: (s) => `${s}.ply(2)`,
    match: /\.ply\s*\(/,
  },

  // ---- Structure ----
  {
    id: 'alternate', category: 'Structure', label: 'Alternate', quick: true,
    explain: 'Play a different option on each cycle: <a b> gives a, then b, then a…',
    example: (n) => `s("<${n.a} ${n.b}>")`,
    apply: (s) => `<${s}>`,
    match: /<[^>]+>/,
  },
  {
    id: 'cat', category: 'Structure', label: 'One-per-cycle (cat)',
    explain: 'Play whole patterns one per cycle, in turn.',
    example: (n) => `cat(\n  s("${n.a}*4"),\n  s("${n.b} ${n.c}")\n)`,
    match: /\bcat\s*\(/,
  },

  // ---- Layering ----
  {
    id: 'stack', category: 'Layering', label: 'Layer (stack)', quick: true,
    explain: 'Play several patterns at once — the way you build a full groove.',
    example: (n) => `stack(\n  s("${n.a}*2"),\n  s("${n.b} ${n.c}")\n)`,
    apply: (s) => `stack(\n  ${s},\n  ${s}\n)`,
    match: /\bstack\s*\(/,
  },
  {
    id: 'jux', category: 'Layering', label: 'Stereo split (jux)', quick: true,
    explain: 'Apply a transform to only one stereo side — wide, dubby movement.',
    example: (n) => `s("${n.a}*4").jux(rev)`,
    apply: (s) => `${s}.jux(rev)`,
    match: /\.jux\s*\(/,
  },

  // ---- Melody ----
  {
    id: 'note', category: 'Melody', label: 'Pitches (note)',
    explain: 'Play named pitches instead of raw hits.',
    example: (n) => `note("c e g a").s("${n.a}")`,
    match: /\bnote\s*\(/,
  },
  {
    id: 'scale', category: 'Melody', label: 'Scale',
    explain: 'Turn plain numbers into a musical scale — 0 1 2 stay in key.',
    example: (n) => `n("0 2 4 6").scale("C:minor").s("${n.a}")`,
    match: /\.scale\s*\(/,
  },
  {
    id: 'transpose', category: 'Melody', label: 'Transpose over time',
    explain: 'Shift the pitches as the piece goes, for a changing melody.',
    example: (n) => `n("0 2 4".add("<0 3 5>")).scale("C:minor").s("${n.a}")`,
    match: /\.add\s*\(/,
  },

  // ---- Motion ----
  {
    id: 'fast', category: 'Motion', label: 'Faster', quick: true,
    explain: 'Speed the pattern up (2 = twice as fast).',
    example: (n) => `s("${n.a} ${n.b}").fast(2)`,
    apply: (s) => `${s}.fast(2)`,
    match: /\.fast\s*\(/,
  },
  {
    id: 'slow', category: 'Motion', label: 'Slower', quick: true,
    explain: 'Stretch the pattern out (2 = half speed).',
    example: (n) => `s("${n.a} ${n.b}").slow(2)`,
    apply: (s) => `${s}.slow(2)`,
    match: /\.slow\s*\(/,
  },
  {
    id: 'rev', category: 'Motion', label: 'Reverse', quick: true,
    explain: 'Play the pattern backwards.',
    example: (n) => `s("${n.a} ${n.b} ${n.c}").rev()`,
    apply: (s) => `${s}.rev()`,
    match: /\.rev\s*\(/,
  },
  {
    id: 'every', category: 'Motion', label: 'Every N cycles', quick: true,
    explain: 'Run a transform once every N cycles — variation without extra code.',
    example: (n) => `s("${n.a}*4").every(4, fast(2))`,
    apply: (s) => `${s}.every(4, rev)`,
    match: /\.every\s*\(/,
  },
  {
    id: 'swing', category: 'Motion', label: 'Swing', quick: true,
    explain: 'Nudge off-beats late for a swung, human feel.',
    apply: (s) => `${s}.swingBy(1/3, 4)`,
    match: /\.swing/,
  },

  // ---- Tone & space ----
  {
    id: 'gain', category: 'Tone & space', label: 'Volume', quick: true,
    explain: 'Set how loud it is (0–1).',
    example: (n) => `s("${n.a}*4").gain(.7)`,
    apply: (s) => `${s}.gain(.7)`,
    match: /\.gain\s*\(/,
  },
  {
    id: 'lpf', category: 'Tone & space', label: 'Darker (low-pass)', quick: true,
    explain: 'Roll off the highs for a darker, warmer tone.',
    example: (n) => `s("${n.a}*4").lpf(800)`,
    apply: (s) => `${s}.lpf(800)`,
    match: /\.(lpf|cutoff)\s*\(/,
  },
  {
    id: 'hpf', category: 'Tone & space', label: 'Thinner (high-pass)',
    explain: 'Cut the lows to thin a sound out or make room for a bass.',
    apply: (s) => `${s}.hpf(500)`,
    match: /\.hpf\s*\(/,
  },
  {
    id: 'room', category: 'Tone & space', label: 'Reverb', quick: true,
    explain: 'Add space around the sound.',
    example: (n) => `s("${n.a} ${n.b}").room(.4)`,
    apply: (s) => `${s}.room(.4)`,
    match: /\.room\s*\(/,
  },
  {
    id: 'delay', category: 'Tone & space', label: 'Echo', quick: true,
    explain: 'Add repeating echoes.',
    example: (n) => `s("${n.a} ${n.b}").delay(.4)`,
    apply: (s) => `${s}.delay(.4)`,
    match: /\.delay\s*\(/,
  },
  {
    id: 'adsr', category: 'Tone & space', label: 'Shape (envelope)',
    explain: 'Shape the fade-in/out of each note (attack / release).',
    apply: (s) => `${s}.attack(.01).release(.2)`,
    match: /\.(attack|release|decay|sustain)\s*\(/,
  },
  {
    id: 'pan', category: 'Tone & space', label: 'Pan',
    explain: 'Move the sound across the stereo field.',
    apply: (s) => `${s}.pan(sine)`,
    match: /\.pan\s*\(/,
  },

  // ---- Chance ----
  {
    id: 'degrade', category: 'Chance', label: 'Thin out (random)', quick: true,
    explain: 'Randomly drop some events, so a busy pattern breathes.',
    example: (n) => `s("${n.a}*8").degradeBy(.3)`,
    apply: (s) => `${s}.degradeBy(.3)`,
    match: /\.degrade/,
  },
  {
    id: 'sometimes', category: 'Chance', label: 'Sometimes', quick: true,
    explain: 'Apply a transform only some of the time, at random.',
    apply: (s) => `${s}.sometimesBy(.3, fast(2))`,
    match: /\.sometimes/,
  },
  {
    id: 'choose', category: 'Chance', label: 'Pick randomly',
    explain: 'Choose randomly between options each time.',
    example: (n) => `s(choose("${n.a}", "${n.b}", "${n.c}"))`,
    match: /\bchoose\s*\(/,
  },

  // ---- Sampling / chopping (great for the longer evolved textures) ----
  {
    id: 'chop', category: 'Sampling', label: 'Chop', quick: true,
    explain: 'Chop a sound into N pieces played in order — turn a long texture into a rhythm.',
    example: (n) => `s("${n.a}").chop(8)`,
    apply: (s) => `${s}.chop(8)`,
    match: /\.chop\s*\(/,
  },
  {
    id: 'slice', category: 'Sampling', label: 'Slice & reorder', quick: true,
    explain: 'Cut into N slices, then play them in any order you like.',
    example: (n) => `s("${n.a}").slice(8, "0 2 1 3 4 6 5 7")`,
    apply: (s) => `${s}.slice(8, "0 2 1 3")`,
    match: /\.slice\s*\(/,
  },
  {
    id: 'striate', category: 'Sampling', label: 'Striate (granular)', quick: true,
    explain: 'Interleave N slices across the cycle — a granular, shimmering read of the sound.',
    example: (n) => `s("${n.a}").striate(16)`,
    apply: (s) => `${s}.striate(16)`,
    match: /\.striate\s*\(/,
  },
  {
    id: 'loopAt', category: 'Sampling', label: 'Fit to cycles', quick: true,
    explain: 'Stretch a sample to fill N cycles, so a loop locks to the tempo.',
    example: (n) => `s("${n.a}").loopAt(2)`,
    apply: (s) => `${s}.loopAt(2)`,
    match: /\.loopAt\s*\(/,
  },
  {
    id: 'range', category: 'Sampling', label: 'Play a portion',
    explain: 'Play just part of the sample (0–1 of its length).',
    example: (n) => `s("${n.a}").begin(0.25).end(0.75)`,
    apply: (s) => `${s}.begin(0.25).end(0.75)`,
    match: /\.(begin|end)\s*\(/,
  },
  {
    id: 'chopshuffle', category: 'Sampling', label: 'Chop + reverse',
    explain: 'Chop, then reverse the order of the pieces for a glitchy re-read.',
    example: (n) => `s("${n.a}").chop(8).rev()`,
    apply: (s) => `${s}.chop(8).rev()`,
  },

  // ---- more Motion ----
  {
    id: 'off', category: 'Motion', label: 'Offset echo', quick: true,
    explain: 'Layer a time-shifted copy of the pattern — a canon or echo.',
    example: (n) => `s("${n.a}*4").off(1/8, x => x.speed(2))`,
    apply: (s) => `${s}.off(1/8, x => x.speed(2))`,
    match: /\.off\s*\(/,
  },
  {
    id: 'superimpose', category: 'Motion', label: 'Layer a variation',
    explain: 'Play the pattern plus a transformed copy of itself, together.',
    example: (n) => `s("${n.a}*4").superimpose(fast(2))`,
    apply: (s) => `${s}.superimpose(fast(2))`,
    match: /\.superimpose\s*\(/,
  },
  {
    id: 'chunk', category: 'Motion', label: 'Rotating transform',
    explain: 'Apply a transform to a different chunk of the pattern each cycle.',
    example: (n) => `s("${n.a}*4").chunk(4, fast(2))`,
    apply: (s) => `${s}.chunk(4, fast(2))`,
    match: /\.chunk\s*\(/,
  },
  {
    id: 'filtersweep', category: 'Motion', label: 'Filter sweep (LFO)', quick: true,
    explain: 'Sweep the low-pass filter with a slow LFO for wobble and movement.',
    example: (n) => `s("${n.a}*8").lpf(sine.range(300, 2000).slow(4))`,
    apply: (s) => `${s}.lpf(sine.range(300, 2000).slow(4))`,
  },

  // ---- more Tone & space ----
  {
    id: 'vowel', category: 'Tone & space', label: 'Vowel filter', quick: true,
    explain: 'A formant / vowel filter for a vocal, talking quality.',
    example: (n) => `s("${n.a}*4").vowel("<a e i o>")`,
    apply: (s) => `${s}.vowel("<a e i>")`,
    match: /\.vowel\s*\(/,
  },
  {
    id: 'crush', category: 'Tone & space', label: 'Bit-crush', quick: true,
    explain: 'Reduce bit depth for lo-fi, crunchy grit.',
    example: (n) => `s("${n.a}*4").crush(4)`,
    apply: (s) => `${s}.crush(4)`,
    match: /\.crush\s*\(/,
  },
  {
    id: 'shape', category: 'Tone & space', label: 'Distortion',
    explain: 'Waveshaping distortion — warmth or edge.',
    example: (n) => `s("${n.a}*4").shape(.4)`,
    apply: (s) => `${s}.shape(.4)`,
    match: /\.shape\s*\(/,
  },
  {
    id: 'coarse', category: 'Tone & space', label: 'Downsample',
    explain: 'Sample-rate reduction for a crunchy, aliased tone.',
    example: (n) => `s("${n.a}*4").coarse(4)`,
    apply: (s) => `${s}.coarse(4)`,
    match: /\.coarse\s*\(/,
  },

  // ---- Harmony (chords & arpeggios) ----
  {
    id: 'chord', category: 'Harmony', label: 'Chord',
    explain: 'Play several pitches at once, and move between chords per cycle.',
    example: (n) => `note("<c'maj a'min f'maj g'maj>").s("${n.a}")`,
    match: /'(maj|min|m7|maj7|dom7|7|sus2|sus4|dim|aug|add9)|\bchord\s*\(/,
  },
  {
    id: 'arp', category: 'Harmony', label: 'Arpeggiate',
    explain: 'Spread a chord out into an arpeggio.',
    example: (n) => `note("<c'maj a'min>").arp("<up down updown>").s("${n.a}")`,
    apply: (s) => `${s}.arp("up")`,
    match: /\.arp\s*\(/,
  },

  // ---- Polyrhythm / polymeter ----
  {
    id: 'polyrhythm', category: 'Rhythm', label: 'Polyrhythm',
    explain: 'Two different subdivisions filling the same cycle — e.g. 3 against 4.',
    example: (n) => `s("[${n.a}*3, ${n.b}*4]")`,
  },
  {
    id: 'polymeter', category: 'Rhythm', label: 'Polymeter',
    explain: 'Stack patterns of different lengths that step through and drift against each other.',
    example: (n) => `s("{${n.a} ${n.b}, ${n.c} ${n.a} ${n.b}}")`,
    match: /\{[^}]*\}/,
  },

  // ---- Structural gating ----
  {
    id: 'struct', category: 'Structure', label: 'Impose a rhythm (struct)', quick: true,
    explain: 'Give a sound a rhythm with a true/false pattern (1 = hit, 0 = rest).',
    example: (n) => `s("${n.a}").struct("1 0 1 1 0 1 0 0")`,
    apply: (s) => `${s}.struct("1 0 1 1")`,
    match: /\.struct\s*\(/,
  },
  {
    id: 'mask', category: 'Structure', label: 'Gate (mask)', quick: true,
    explain: 'Silence parts of a pattern with a true/false gate, keeping its own timing.',
    example: (n) => `s("${n.a}*8").mask("<1 1 0 1>")`,
    apply: (s) => `${s}.mask("1 1 0 1")`,
    match: /\.mask\s*\(/,
  },

  // ---- Modulation (LFOs & signals) ----
  {
    id: 'tremolo', category: 'Modulation', label: 'Tremolo (LFO)', quick: true,
    explain: 'Pulse the volume up and down with an LFO.',
    example: (n) => `s("${n.a}*8").gain(sine.range(0.4, 1).fast(2))`,
    apply: (s) => `${s}.gain(sine.range(0.4, 1).fast(2))`,
  },
  {
    id: 'autopan', category: 'Modulation', label: 'Auto-pan (LFO)', quick: true,
    explain: 'Sweep the sound across the stereo field with an LFO.',
    example: (n) => `s("${n.a}*4").pan(sine.slow(2))`,
    apply: (s) => `${s}.pan(sine.slow(2))`,
  },
  {
    id: 'drift', category: 'Modulation', label: 'Random drift (perlin)', quick: true,
    explain: 'Modulate a parameter with smooth randomness for organic movement.',
    example: (n) => `s("${n.a}*8").speed(perlin.range(0.9, 1.1))`,
    apply: (s) => `${s}.speed(perlin.range(0.9, 1.1))`,
    match: /\bperlin\b/,
  },

  // ---- Arrangement (build a piece over time) ----
  {
    id: 'stackparts', category: 'Arrangement', label: 'Play parts together',
    explain: 'Name a few parts and layer them so they sound at the same time (only the last expression plays — so make it one stack).',
    example: (n) => `let drums = s("${n.a}*4")\nlet bass = s("${n.b}(3,8)")\nstack(drums, bass)`,
  },
  {
    id: 'arrange', category: 'Arrangement', label: 'Arrange sections',
    explain: 'Play different parts for a number of cycles each — the start of a song.',
    example: (n) => `let a = s("${n.a}*4")\nlet b = s("${n.b}(3,8)").room(.3)\narrange([4, a], [4, b], [4, stack(a, b)])`,
    match: /\barrange\s*\(/,
  },

  // ---- Control / MIDI (play & control from hardware) ----
  {
    id: 'midi-keys', category: 'Control / MIDI', label: 'Play with a MIDI keyboard',
    explain: 'Trigger a sound by pressing keys on a MIDI keyboard. Swap in your device name (use Detect above).',
    example: (n) => `const kb = await midikeys('Your Keyboard')\nkb().s("${n.a}").lpf(1200).room(.3)`,
    match: /\bmidikeys\s*\(/,
  },
  {
    id: 'midi-knob', category: 'Control / MIDI', label: 'Map a knob to a parameter',
    explain: 'Twist a physical knob (CC 74 here) to sweep a parameter live. Set your device name and CC number.',
    example: (n) => `const cc = await midin('Your Controller')\ns("${n.a}*8").lpf(cc(74).range(200, 4000))`,
    match: /\bmidin\s*\(/,
  },
  {
    id: 'midi-out', category: 'Control / MIDI', label: 'Send notes to a synth / DAW',
    explain: 'Send the pattern out as MIDI notes to hardware or a DAW (leave the name blank for the first device).',
    example: (n) => `note("<c e g a>").midi('IAC Driver')`,
    match: /\.midi\s*\(/,
  },
  {
    id: 'midi-clock', category: 'Control / MIDI', label: 'Sync a DAW to Strudel',
    explain: 'Send MIDI clock + start/stop so your DAW or drum machine follows Strudel’s tempo.',
    example: (n) => `midicmd("clock*48,<start stop>/2").midi('IAC Driver')`,
    match: /\bmidicmd\s*\(/,
  },
];

const REGISTRY = { strudel: STRUDEL_CONCEPTS };

export function getConcepts(envId = 'strudel') {
  return REGISTRY[envId] || STRUDEL_CONCEPTS;
}

/** Kit sound names used to fill example snippets (with sensible placeholders). */
export function conceptNames(kit) {
  const names = (kit || []).map((k) => k.name).filter(Boolean);
  return {
    a: names[0] || 'sound1',
    b: names[1] || names[0] || 'sound2',
    c: names[2] || names[0] || 'sound3',
  };
}

/** Concepts grouped by category, preserving declaration order. */
export function conceptsByCategory(envId = 'strudel') {
  const out = [];
  const index = new Map();
  for (const c of getConcepts(envId)) {
    if (!index.has(c.category)) {
      const group = { category: c.category, items: [] };
      index.set(c.category, group);
      out.push(group);
    }
    index.get(c.category).items.push(c);
  }
  return out;
}

/** Transforms that wrap a selection. `onlyQuick` limits to the selection-bar set. */
export function transforms(envId = 'strudel', onlyQuick = false) {
  return getConcepts(envId).filter((c) => c.apply && (!onlyQuick || c.quick));
}

/** Concepts detected in a piece of code — powers "explain this". */
export function explainConcepts(text, envId = 'strudel') {
  if (!text) return [];
  return getConcepts(envId).filter((c) => c.match && c.match.test(text));
}

/**
 * Compact, copyright-clean reference for an LLM — DERIVED from the same concept
 * library that drives the palette (so maintaining the palette maintains the AI's
 * knowledge). It is deliberately version-matched to the bundled Strudel: a model
 * shouldn't be told about functions the shipped version lacks, since those would
 * just error. Refresh at dependency-bump time, not continuously (docs/AI_EDIT_PLAN.md §6).
 *
 * Keep STRUDEL_REFERENCE_VERSION in sync with @strudel/repl in package.json.
 */
export const STRUDEL_REFERENCE_VERSION = '1.3';

// Core syntax the palette has no single concept for — hand-written, brief.
const STRUDEL_PREAMBLE = `Strudel is a JavaScript live-coding language (TidalCycles in the browser). Essentials:
- Only the LAST top-level expression makes sound. Build ONE expression (use stack / arrange / cat), or prefix parallel parts with "$:".
- Sound comes from samples: s("name") plays a registered sample; the available names are listed under the prompt.
- Mini-notation lives inside the quotes: "a b c" = a sequence (one per step); "a*4" = repeat 4x; "~" = a rest; "<a b>" = one per cycle (alternate); "[a b]" = a group/subdivision; "a(3,8)" = a Euclidean rhythm; "{a b, c d e}" = polymeter.
- Chain transforms with dots: s("a*4").fast(2).lpf(800).room(.3).
- Pitch: note("c e g") or n("0 2 4").scale("C:minor"). Layer with stack(a, b); one pattern per cycle with cat(a, b); arrange sections over cycles with arrange([4, a], [4, b]).
- Signals modulate parameters: sine, saw, tri, perlin — e.g. .lpf(sine.range(300, 2000).slow(4)).`;

/**
 * A compact reference block for an LLM system prompt, built from the concept library.
 * @param {string} envId
 * @param {Array} kit  current kit entries (their names fill the examples)
 * @returns {string}
 */
export function buildReference(envId = 'strudel', kit = []) {
  const names = conceptNames(kit);
  const preamble = envId === 'strudel' ? STRUDEL_PREAMBLE : '';
  const version = envId === 'strudel' ? STRUDEL_REFERENCE_VERSION : '';
  const lines = [];
  for (const group of conceptsByCategory(envId)) {
    lines.push(`\n## ${group.category}`);
    for (const c of group.items) {
      const ex = c.example ? ` — e.g. \`${c.example(names).replace(/\n/g, ' ')}\`` : '';
      lines.push(`- ${c.label}: ${c.explain}${ex}`);
    }
  }
  return [
    preamble,
    version ? `\nThis targets Strudel ~${version}; only use functions available in that version.` : '',
    '\nAvailable techniques (label: what it does — example):',
    lines.join('\n'),
  ].filter(Boolean).join('\n');
}

/**
 * Compact, copyright-clean reference for an LLM — DERIVED from the same concept
 * library that drives the palette (so maintaining the palette maintains the AI's
 * knowledge). It is deliberately version-matched to the bundled Strudel: a model
 * shouldn't be told about functions the shipped version lacks, since those would
 * just error. Refresh at dependency-bump time, not continuously (docs/AI_EDIT_PLAN.md §6).
 *
 * Keep STRUDEL_REFERENCE_VERSION in sync with @strudel/repl in package.json.
 */
export const STRUDEL_REFERENCE_VERSION = '1.3';

// Core syntax the palette has no single concept for — hand-written, brief.
const STRUDEL_PREAMBLE = `Strudel is a JavaScript live-coding language (TidalCycles in the browser). Essentials:
- Only the LAST top-level expression makes sound. Build ONE expression (use stack / arrange / cat), or prefix parallel parts with "$:".
- Sound comes from samples: s("name") plays a registered sample; the available names are listed under the prompt.
- Mini-notation lives inside the quotes: "a b c" = a sequence (one per step); "a*4" = repeat 4x; "~" = a rest; "<a b>" = one per cycle (alternate); "[a b]" = a group/subdivision; "a(3,8)" = a Euclidean rhythm; "{a b, c d e}" = polymeter.
- Chain transforms with dots: s("a*4").fast(2).lpf(800).room(.3).
- Pitch: note("c e g") or n("0 2 4").scale("C:minor"). Layer with stack(a, b); one pattern per cycle with cat(a, b); arrange sections over cycles with arrange([4, a], [4, b]).
- Signals modulate parameters: sine, saw, tri, perlin — e.g. .lpf(sine.range(300, 2000).slow(4)).`;

/**
 * A compact reference block for an LLM system prompt, built from the concept library.
 * @param {string} envId
 * @param {Array} kit  current kit entries (their names fill the examples)
 * @returns {string}
 */
export function buildReference(envId = 'strudel', kit = []) {
  const names = conceptNames(kit);
  const preamble = envId === 'strudel' ? STRUDEL_PREAMBLE : '';
  const version = envId === 'strudel' ? STRUDEL_REFERENCE_VERSION : '';
  const lines = [];
  for (const group of conceptsByCategory(envId)) {
    lines.push(`\n## ${group.category}`);
    for (const c of group.items) {
      const ex = c.example ? ` — e.g. \`${c.example(names).replace(/\n/g, ' ')}\`` : '';
      lines.push(`- ${c.label}: ${c.explain}${ex}`);
    }
  }
  return [
    preamble,
    version ? `\nThis targets Strudel ~${version}; only use functions available in that version.` : '',
    '\nAvailable techniques (label: what it does — example):',
    lines.join('\n'),
  ].filter(Boolean).join('\n');
}
