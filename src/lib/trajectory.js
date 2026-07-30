/**
 * Composition-as-trajectory.
 *
 * An append-only log of code snapshots, one per evaluation. Conceptually the
 * same idea as a sound's lineage/phylogeny, one level up: the evolution of the
 * *composition*. Deliberately snapshots + a scrubber only — no CRDTs / OT.
 *
 * The whole trajectory is stored inside a sequence's opaque `unitState`, so it
 * saves and reloads with the composition and needs no schema change.
 */

/** Snapshot the current code + a self-contained kit (so a replay can re-register samples). */
export function makeSnapshot(code, kit, label = '') {
  return {
    t: Date.now(),
    code,
    kit: (kit || []).map((k) => ({
      name: k.name,
      soundId: k.soundId,
      evoRunId: k.evoRunId || null,
      previewUrl: k.previewUrl,
      duration: k.duration ?? null,
      settings: k.settings || null,
    })),
    label,
  };
}

/** Append, but skip no-op re-evals (same code as the last snapshot). */
export function appendSnapshot(trajectory, snap) {
  const last = trajectory[trajectory.length - 1];
  if (last && last.code === snap.code) return trajectory;
  return [...trajectory, snap];
}

export function trajectorySpanMs(trajectory) {
  if (!trajectory || trajectory.length < 2) return 0;
  return trajectory[trajectory.length - 1].t - trajectory[0].t;
}

/** Human label for a snapshot in the scrubber. */
export function snapshotLabel(snap, index, first) {
  if (snap.label) return snap.label;
  const rel = first ? Math.round((snap.t - first.t) / 1000) : 0;
  return `#${index + 1} · +${rel}s`;
}
