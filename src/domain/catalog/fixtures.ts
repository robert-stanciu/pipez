/**
 * Fixture catalogue.
 *
 * Each entry carries its physical size, where it mounts, the **ports** the router has to
 * reach, and its load figures. Port offsets are in fixture-local space:
 *   x — along the wall to the right, y — out from the wall face, z — up from the anchor.
 *
 * Discharge units (DU) are EN 12056-2 System I; loading units (LU) are EN 806-3.
 */

import type { FixtureDef, FixtureType } from '../types.ts'

const COLD = 15
const HOT = 15

export const FIXTURE_DEFS: Record<FixtureType, FixtureDef> = {
  basin: {
    type: 'basin',
    label: 'Wash basin',
    category: 'sanitary',
    mount: 'wall',
    size: { width: 600, depth: 450, height: 200 },
    defaultZ: 850,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -70, y: 60, z: -300 }, dn: COLD },
      { id: 'h', kind: 'hot', offset: { x: 70, y: 60, z: -300 }, dn: HOT },
      { id: 'w', kind: 'waste', offset: { x: 0, y: 120, z: -350 }, dn: 40 },
    ],
    loads: { drainageDu: 0.5, supplyLuCold: 1, supplyLuHot: 1 },
  },

  sink: {
    type: 'sink',
    label: 'Kitchen sink',
    category: 'kitchen',
    mount: 'wall',
    size: { width: 800, depth: 600, height: 900 },
    defaultZ: 900,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -70, y: 80, z: -400 }, dn: COLD },
      { id: 'h', kind: 'hot', offset: { x: 70, y: 80, z: -400 }, dn: HOT },
      { id: 'w', kind: 'waste', offset: { x: 0, y: 150, z: -450 }, dn: 50 },
    ],
    loads: { drainageDu: 0.8, supplyLuCold: 2, supplyLuHot: 2 },
  },

  shower: {
    type: 'shower',
    label: 'Shower',
    category: 'sanitary',
    mount: 'floor',
    size: { width: 900, depth: 900, height: 2100 },
    defaultZ: 0,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -70, y: 40, z: 1100 }, dn: COLD },
      { id: 'h', kind: 'hot', offset: { x: 70, y: 40, z: 1100 }, dn: HOT },
      { id: 'w', kind: 'waste', offset: { x: 0, y: 450, z: 30 }, dn: 50 },
    ],
    loads: { drainageDu: 0.6, supplyLuCold: 2, supplyLuHot: 2 },
  },

  bathtub: {
    type: 'bathtub',
    label: 'Bath tub',
    category: 'sanitary',
    mount: 'wall',
    size: { width: 1700, depth: 750, height: 600 },
    defaultZ: 0,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -70, y: 60, z: 700 }, dn: COLD },
      { id: 'h', kind: 'hot', offset: { x: 70, y: 60, z: 700 }, dn: HOT },
      { id: 'w', kind: 'waste', offset: { x: -700, y: 200, z: 60 }, dn: 50 },
    ],
    // EN 806-3 table 2 puts a bath tub at 4 LU per tapping, not 3 — it fills faster than
    // anything else in a domestic installation and that is what the riser has to be sized for.
    loads: { drainageDu: 0.8, supplyLuCold: 4, supplyLuHot: 4 },
  },

  wc: {
    type: 'wc',
    label: 'WC',
    category: 'sanitary',
    mount: 'wall',
    size: { width: 400, depth: 700, height: 800 },
    defaultZ: 0,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: 0, y: 60, z: 600 }, dn: COLD },
      // EN 12056-2 / DIN 1986 table 4: a WC with a 6.0 or 7.5 l cistern connects at DN 90, and
      // only a 9.0 l one needs DN 100. Romanian practice fits ø110 to everything regardless,
      // but the standard's figure is what the branch and stack minima are drawn from.
      { id: 'w', kind: 'waste', offset: { x: 0, y: 220, z: 180 }, dn: 90 },
    ],
    loads: { drainageDu: 2.0, supplyLuCold: 1 },
  },

  bidet: {
    type: 'bidet',
    label: 'Bidet',
    category: 'sanitary',
    mount: 'wall',
    size: { width: 400, depth: 600, height: 400 },
    defaultZ: 400,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -60, y: 60, z: -150 }, dn: COLD },
      { id: 'h', kind: 'hot', offset: { x: 60, y: 60, z: -150 }, dn: HOT },
      { id: 'w', kind: 'waste', offset: { x: 0, y: 150, z: -250 }, dn: 40 },
    ],
    loads: { drainageDu: 0.5, supplyLuCold: 1, supplyLuHot: 1 },
  },

  'washing-machine': {
    type: 'washing-machine',
    label: 'Washing machine',
    category: 'appliance',
    mount: 'floor',
    size: { width: 600, depth: 600, height: 850 },
    defaultZ: 0,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -150, y: 250, z: 750 }, dn: COLD },
      { id: 'w', kind: 'waste', offset: { x: 150, y: 250, z: 600 }, dn: 50 },
      { id: 'p', kind: 'power', offset: { x: 250, y: 250, z: 300 }, dn: 0 },
    ],
    loads: { drainageDu: 0.8, supplyLuCold: 3, watts: 2200, circuit: 'appliance' },
  },

  dishwasher: {
    type: 'dishwasher',
    label: 'Dishwasher',
    category: 'appliance',
    mount: 'floor',
    size: { width: 600, depth: 600, height: 850 },
    defaultZ: 0,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -150, y: 250, z: 500 }, dn: COLD },
      { id: 'w', kind: 'waste', offset: { x: 150, y: 250, z: 450 }, dn: 50 },
      { id: 'p', kind: 'power', offset: { x: 250, y: 250, z: 300 }, dn: 0 },
    ],
    loads: { drainageDu: 0.8, supplyLuCold: 2, watts: 2000, circuit: 'appliance' },
  },

  'tumble-dryer': {
    type: 'tumble-dryer',
    label: 'Tumble dryer',
    category: 'appliance',
    mount: 'floor',
    size: { width: 600, depth: 600, height: 850 },
    defaultZ: 0,
    ports: [
      // A condenser dryer pumps out its condensate, so it needs a waste connection but no supply.
      { id: 'w', kind: 'waste', offset: { x: 150, y: 250, z: 600 }, dn: 40 },
      { id: 'p', kind: 'power', offset: { x: 250, y: 250, z: 300 }, dn: 0 },
    ],
    // EN 12056-2 has no row for a condenser dryer, so 0.4 DU is an assumption of ours: half a
    // washing machine, which is roughly what the condensate pump discharges. Anything with a
    // standard behind it should not be guessed at like this.
    loads: { drainageDu: 0.4, watts: 2500, circuit: 'appliance' },
  },

  'water-heater': {
    type: 'water-heater',
    label: 'Water heater',
    category: 'appliance',
    mount: 'wall',
    size: { width: 450, depth: 450, height: 900 },
    defaultZ: 1400,
    ports: [
      { id: 'c', kind: 'cold', offset: { x: -100, y: 60, z: -450 }, dn: 22 },
      // The heater is the *source* of the hot network, not a consumer of it.
      { id: 'h', kind: 'hot', offset: { x: 100, y: 60, z: 450 }, dn: 22 },
      { id: 'p', kind: 'power', offset: { x: 0, y: 60, z: -500 }, dn: 0 },
    ],
    loads: { supplyLuCold: 3, watts: 2000, circuit: 'appliance' },
  },

  'floor-drain': {
    type: 'floor-drain',
    label: 'Floor drain',
    category: 'sanitary',
    mount: 'floor',
    size: { width: 150, depth: 150, height: 50 },
    defaultZ: 0,
    ports: [{ id: 'w', kind: 'waste', offset: { x: 0, y: 0, z: -20 }, dn: 50 }],
    loads: { drainageDu: 0.8 },
  },

  socket: {
    type: 'socket',
    label: 'Socket outlet',
    category: 'electrical',
    mount: 'wall',
    size: { width: 85, depth: 45, height: 85 },
    defaultZ: 300,
    ports: [{ id: 'p', kind: 'power', offset: { x: 0, y: 0, z: 0 }, dn: 0 }],
    loads: { watts: 300, circuit: 'sockets' },
  },

  'ceiling-light': {
    type: 'ceiling-light',
    label: 'Ceiling light',
    category: 'electrical',
    mount: 'ceiling',
    size: { width: 300, depth: 300, height: 120 },
    defaultZ: 0,
    ports: [{ id: 'p', kind: 'power', offset: { x: 0, y: 0, z: 0 }, dn: 0 }],
    loads: { watts: 60, circuit: 'lighting' },
  },

  cooker: {
    type: 'cooker',
    label: 'Cooker',
    category: 'kitchen',
    mount: 'floor',
    size: { width: 600, depth: 600, height: 900 },
    defaultZ: 0,
    ports: [{ id: 'p', kind: 'power', offset: { x: 0, y: 250, z: 300 }, dn: 0 }],
    loads: { watts: 7000, circuit: 'cooker' },
  },
}

export const FIXTURE_LIST: FixtureDef[] = Object.values(FIXTURE_DEFS)

export const fixtureDef = (type: FixtureType): FixtureDef => FIXTURE_DEFS[type]

/**
 * Height the trap **body** occupies below an appliance outlet, in millimetres.
 *
 * This is not the water seal. EN 12056-2 asks for 50 mm of seal, and that figure lives with
 * the standard; what the geometry has to make room for is the fitting itself, and a bottle trap
 * under a basin is four times its own seal deep. Sizing the clearance from the seal is how a
 * drawing ends up with a branch nobody could physically connect the appliance to.
 *
 * A WC is zero because its trap is cast into the pan: its outlet spigot *is* the trap outlet,
 * and there is nothing to fit underneath it. Fixtures with no waste connection are zero for
 * the same reason — there is no trap.
 */
const TRAP_HEIGHT: Record<FixtureType, number> = {
  // Bottle trap, the usual fitting under a pedestal or wall-hung basin.
  basin: 200,
  bidet: 200,
  // Tubular trap in a cabinet, which sits a little tighter than a bottle one.
  sink: 180,
  'washing-machine': 180,
  dishwasher: 180,
  'tumble-dryer': 180,
  // Flat shower traps are made shallow on purpose — there is only the tray upstand to hide in.
  shower: 90,
  bathtub: 120,
  'floor-drain': 100,
  // Integral trap, or no waste connection at all.
  wc: 0,
  'water-heater': 0,
  socket: 0,
  'ceiling-light': 0,
  cooker: 0,
}

export const trapHeight = (type: FixtureType): number => TRAP_HEIGHT[type]

export const CATEGORY_LABEL: Record<FixtureDef['category'], string> = {
  sanitary: 'Sanitary',
  kitchen: 'Kitchen',
  appliance: 'Appliances',
  electrical: 'Electrical',
}
