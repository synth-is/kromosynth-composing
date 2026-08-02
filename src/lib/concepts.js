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
