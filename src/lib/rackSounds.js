/**
 * rackSounds.js — install the "wclap-rack" sound + .rack() pattern method into the
 * editor's Strudel instance (the one that plays), mirroring how faustInstruments.js
 * self-installs at import time (installFaustGlobal at the bottom of that module).
 *
 * Buffer code then reads:
 *
 *   note("c3 e3 g3").s("wclap-rack").rack("/racks/synth-fx-rack.wclap-rack.tar.gz")
 *
 * The rack bundle URL is fetched, sha256-verified against its MANIFEST, and rendered
 * in a per-hap AudioWorklet (see packages/strudel-rack). Registering twice (editor +
 * app instance for the bounce) follows the same rule as faustSounds — see
 * packages/strudel-rack/src/bindings.js.
 */

import { installRack } from '@kromosynth/strudel-rack';
import { whenStrudelScopeReady } from '@kromosynth/strudel-faust';

export async function installRackIntoStrudel() {
  try {
    await whenStrudelScopeReady();
    const name = installRack(); // resolves registerSound/getAudioContext/Pattern/reify from globalThis
    console.log(`[rackSounds] installed sound "${name}" + .rack()/.wclaprack()`);
    return name;
  } catch (err) {
    console.warn('[rackSounds] could not install (Strudel scope not ready?):', err);
    return null;
  }
}

// self-install at import, like installFaustGlobal()
installRackIntoStrudel();
