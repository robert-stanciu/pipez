/**
 * EN 806-3 — the simplified sizing method for drinking-water installations inside buildings,
 * together with the pressure and velocity limits from EN 806-2 and EN 806-3 §4.3 / §4.4 that
 * the sizing tables are built on.
 *
 * Fixtures contribute loading units (LU); a run's size follows from the summed LU it carries.
 * One LU is a draw-off flow rate of 0,1 l/s (§5.4) — that conversion is the whole reason the
 * tables and the flow-rate curve can be used together, and getting it wrong triples the flow.
 *
 * Sizes are **outside diameters**, because that is how every one of these materials is sold
 * and drawn: 15 mm copper and ø20 PPR are both roughly a 13 mm bore. The bore is carried
 * alongside, because the bore is what the water sees — velocity, head loss and the standing
 * volume in a dead leg are all wrong by 20-40 % if the outside diameter is used instead.
 */

import type { SupplyMaterial } from '../types.ts'

/** One loading unit is a draw-off flow rate QA of 0,1 l/s — EN 806-3 §5.4. */
export const LITRES_PER_SECOND_PER_LU = 0.1

/** Draw-off flow rate QA for a single appliance of the given loading-unit rating, l/s. */
export const drawOffFlow = (lu: number): number => Math.max(0, lu) * LITRES_PER_SECOND_PER_LU

/**
 * Design flow rate QD from a summed loading-unit figure, l/s.
 *
 * EN 806-3 annex B, the dwelling curve: QD = 0,682·QT^0,45 − 0,14, where **QT is the summed
 * draw-off flow rate in l/s**, not the loading units themselves. The curve is only defined
 * from QT = 0,2 l/s upwards, and it dips below zero under that, so a very small load falls
 * back on its own undiversified draw-off flow — one tap open is one tap's worth of water.
 */
export function flowFromLu(sumLu: number): number {
  if (sumLu <= 0) return 0
  const totalFlow = drawOffFlow(sumLu)
  return Math.max(totalFlow < 0.2 ? totalFlow : 0, 0.682 * Math.pow(totalFlow, 0.45) - 0.14)
}

/* --------------------------------------------------------------- Table 2: draw-offs */

/**
 * Minimum flow rate Qmin at a draw-off point — EN 806-3 Table 2, keyed by the loading-unit
 * rating the catalogue already carries. Below this the appliance does not work: a shower
 * dribbles, a cistern takes all morning to refill.
 */
const MIN_FLOW_BY_LU: ReadonlyArray<{ lu: number; qMin: number }> = [
  // Washbasin, handbasin, bidet, WC cistern.
  { lu: 1, qMin: 0.1 },
  // Kitchen sink, washing machine, dishwasher, shower head.
  { lu: 2, qMin: 0.15 },
  // Urinal flush valve.
  { lu: 3, qMin: 0.15 },
  // Domestic bath.
  { lu: 4, qMin: 0.3 },
  // Garden or garage tap.
  { lu: 5, qMin: 0.4 },
  // Non-domestic kitchen sink DN20, non-domestic bath.
  { lu: 8, qMin: 0.8 },
  // Flush valve DN20.
  { lu: 15, qMin: 1.0 },
]

/** Minimum flow rate the appliance needs to function, l/s. */
export function minFlowRate(lu: number): number {
  for (const row of MIN_FLOW_BY_LU) if (lu <= row.lu) return row.qMin
  return MIN_FLOW_BY_LU[MIN_FLOW_BY_LU.length - 1].qMin
}

/* ------------------------------------------------------------ Table 3: pipe ladders */

/**
 * A load the size may carry, and the longest run of it the table allows at that load.
 *
 * The tables give several columns per size for the two smallest diameters of each material:
 * the first is the load the pipe carries as a distributing run at 2 m/s, and the rest are
 * short connection pipes to a single fitting, where §4.4 allows up to 4 m/s and the length
 * limit tightens as the velocity rises. A tier with no length is not length-limited.
 */
interface LoadTier {
  maxLu: number
  /** Longest permitted run at this load, mm. */
  maxLength?: number
}

export interface SupplySize {
  /** Outside diameter da, mm — the number the pipe is ordered and drawn by. */
  od: number
  /** Wall thickness s, mm. */
  wall: number
  /** Internal diameter di, mm — the bore the water actually flows through. */
  bore: number
  tiers: ReadonlyArray<LoadTier>
}

/** EN 806-3:2006 Table 3.2 — copper. */
const COPPER: ReadonlyArray<SupplySize> = [
  { od: 12, wall: 1.0, bore: 10.0, tiers: [{ maxLu: 1, maxLength: 20_000 }, { maxLu: 2, maxLength: 7_000 }, { maxLu: 3, maxLength: 5_000 }] },
  { od: 15, wall: 1.0, bore: 13.0, tiers: [{ maxLu: 3, maxLength: 15_000 }, { maxLu: 4, maxLength: 9_000 }, { maxLu: 6, maxLength: 7_000 }] },
  { od: 18, wall: 1.0, bore: 16.0, tiers: [{ maxLu: 10 }] },
  { od: 22, wall: 1.0, bore: 20.0, tiers: [{ maxLu: 20 }] },
  { od: 28, wall: 1.5, bore: 25.0, tiers: [{ maxLu: 50 }] },
  { od: 35, wall: 1.5, bore: 32.0, tiers: [{ maxLu: 165 }] },
  { od: 42, wall: 1.5, bore: 39.0, tiers: [{ maxLu: 430 }] },
  { od: 54, wall: 2.0, bore: 50.0, tiers: [{ maxLu: 1_050 }] },
  { od: 76.1, wall: 2.0, bore: 72.1, tiers: [{ maxLu: 2_100 }] },
]

/** EN 806-3:2006 Table 3.4 — PE-X. */
const PEX: ReadonlyArray<SupplySize> = [
  { od: 12, wall: 1.7, bore: 8.4, tiers: [{ maxLu: 1, maxLength: 13_000 }, { maxLu: 2, maxLength: 4_000 }] },
  { od: 16, wall: 2.2, bore: 11.6, tiers: [{ maxLu: 3, maxLength: 9_000 }, { maxLu: 4, maxLength: 5_000 }, { maxLu: 5, maxLength: 4_000 }] },
  { od: 20, wall: 2.8, bore: 14.4, tiers: [{ maxLu: 8 }] },
  { od: 25, wall: 3.5, bore: 18.0, tiers: [{ maxLu: 16 }] },
  { od: 32, wall: 4.4, bore: 23.2, tiers: [{ maxLu: 35 }] },
  { od: 40, wall: 5.5, bore: 29.0, tiers: [{ maxLu: 100 }] },
  { od: 50, wall: 6.9, bore: 36.2, tiers: [{ maxLu: 350 }] },
  { od: 63, wall: 8.6, bore: 45.6, tiers: [{ maxLu: 700 }] },
]

/**
 * Polypropylene (PP-R) to EN ISO 15874, the PN20 / SDR6 ladder — what a Romanian house is
 * actually plumbed in, hot and cold alike.
 *
 * EN 806-3 has no PP-R table of its own, so each size takes the capacity of the PE-X row
 * whose bore it just clears. That is sound because the simplified table is a velocity table
 * underneath: two pipes of the same bore carry the same flow at the same speed, whatever the
 * wall around them is made of. It also errs the right way — every PP-R size here has a
 * slightly wider bore than the PE-X row it borrows from.
 */
const PPR: ReadonlyArray<SupplySize> = [
  // 13,2 bore, against PE-X 16 × 2,2 at 11,6.
  { od: 20, wall: 3.4, bore: 13.2, tiers: [{ maxLu: 3, maxLength: 9_000 }] },
  // 16,6 against PE-X 20 × 2,8 at 14,4.
  { od: 25, wall: 4.2, bore: 16.6, tiers: [{ maxLu: 8 }] },
  { od: 32, wall: 5.4, bore: 21.2, tiers: [{ maxLu: 16 }] },
  { od: 40, wall: 6.7, bore: 26.6, tiers: [{ maxLu: 35 }] },
  { od: 50, wall: 8.3, bore: 33.4, tiers: [{ maxLu: 100 }] },
  { od: 63, wall: 10.5, bore: 42.0, tiers: [{ maxLu: 350 }] },
]

/**
 * Multilayer composite — PE-X/Al/PE-X press pipe, the other thing a Romanian house is plumbed
 * in, usually buried in the screed and run in a manifold. Capacities are matched to the PE-X
 * table by bore, exactly as the PP-R ladder above.
 */
const PEX_AL_PEX: ReadonlyArray<SupplySize> = [
  { od: 16, wall: 2.0, bore: 12.0, tiers: [{ maxLu: 3, maxLength: 9_000 }] },
  { od: 20, wall: 2.0, bore: 16.0, tiers: [{ maxLu: 8 }] },
  { od: 25, wall: 2.5, bore: 20.0, tiers: [{ maxLu: 16 }] },
  { od: 32, wall: 3.0, bore: 26.0, tiers: [{ maxLu: 35 }] },
]

const LADDERS: Record<SupplyMaterial, ReadonlyArray<SupplySize>> = {
  copper: COPPER,
  'PE-X': PEX,
  PPR,
  'PEX-AL-PEX': PEX_AL_PEX,
}

export const supplySizes = (material: SupplyMaterial): ReadonlyArray<SupplySize> =>
  LADDERS[material]

const sizeOf = (material: SupplyMaterial, od: number): SupplySize => {
  const ladder = LADDERS[material]
  return ladder.find((row) => row.od === od) ?? ladder[ladder.length - 1]
}

/** Internal bore of a size in the given material, mm. */
export const boreOf = (material: SupplyMaterial, od: number): number => sizeOf(material, od).bore

/**
 * Smallest size that serves the given LU load, never below `minOd`.
 *
 * Only the first tier of each row is used to size a run. That is the column paired with the
 * table's longest permitted length and with the 2 m/s distributing-pipe velocity; the later
 * columns buy more load by running faster over a shorter distance, which is a decision about
 * one particular connection, not something to apply to a whole network sight unseen.
 */
export function supplyDiameter(sumLu: number, minOd = 0, material: SupplyMaterial = 'copper'): number {
  const ladder = LADDERS[material]
  for (const row of ladder) {
    if (row.od >= minOd && sumLu <= row.tiers[0].maxLu) return row.od
  }
  return ladder[ladder.length - 1].od
}

/**
 * The size in `material` that replaces a fixture's nominal connection.
 *
 * The catalogue quotes connections as copper outside diameters, so they are translated
 * through the bore rather than by the number on the outside: a 15 mm tap tail is a 13 mm
 * bore, which is ø20 in PP-R and ø20 in composite, not the ø16 the digits would suggest.
 */
export function connectionSize(material: SupplyMaterial, dn: number): number {
  const asCopper = COPPER.find((row) => row.od >= dn) ?? COPPER[COPPER.length - 1]
  const ladder = LADDERS[material]
  return (ladder.find((row) => row.bore >= asCopper.bore) ?? ladder[ladder.length - 1]).od
}

/**
 * Longest run of this size the table allows at this load, mm, or Infinity where the table
 * sets no limit. Only the two smallest sizes of each material are length-limited — beyond
 * them the pressure loss over any sane domestic run is not what governs.
 */
export function maxRunLength(material: SupplyMaterial, od: number, lu: number): number {
  const size = sizeOf(material, od)
  const tier = size.tiers.find((t) => lu <= t.maxLu) ?? size.tiers[size.tiers.length - 1]
  return tier.maxLength ?? Infinity
}

/** How the size reads on a drawing and on the order: `Ø20 PPR`, not `DN15`. */
export const supplyPipeLabel = (material: SupplyMaterial, od: number): string =>
  `Ø${od} ${material}`

/* ------------------------------------------------------ velocity, pressure, dead legs */

/**
 * Velocity ceilings the Table 3 figures are based on — EN 806-3 §4.4.
 *
 * A header, rising or floor service pipe is limited to 2 m/s; a connection pipe to a single
 * fitting may go to 4 m/s, because nothing downstream of it can be disturbed by the noise or
 * the water hammer it makes.
 */
export const MAX_VELOCITY_DISTRIBUTION = 2.0
export const MAX_VELOCITY_CONNECTION = 4.0

/** Flow (l/s) through a bore (mm) as m/s. */
export function velocity(flowLs: number, bore: number): number {
  const areaM2 = Math.PI * (bore / 2000) ** 2
  return areaM2 <= 0 ? 0 : flowLs / 1000 / areaM2
}

/** Flow pressure required at every draw-off point — EN 806-2 and EN 806-3 §4.3, kPa. */
export const MIN_FLOW_PRESSURE_KPA = 100

/** Static pressure ceiling at a draw-off point — EN 806-3 §4.3, kPa. */
export const MAX_STATIC_PRESSURE_KPA = 500

const WATER_DENSITY = 1000
const GRAVITY = 9.81

/**
 * Kinematic viscosity of water, m²/s. Hot water is thinner, so a hot run of the same bore
 * and flow loses noticeably less pressure than its cold twin.
 */
export const KINEMATIC_VISCOSITY = { cold: 1.31e-6, hot: 0.47e-6 }

/**
 * Allowance for fittings, valves and the branch entries a straight length does not include.
 *
 * EN 806-3's own tables absorb the fittings into their length limits rather than counting
 * them; the pressure pass has to put something back, and a third on top of the measured run
 * is the usual domestic equivalent-length allowance.
 */
export const FITTING_ALLOWANCE = 1.3

/** Pressure lost to raising water by `riseMm`, kPa. Negative where the run falls. */
export const staticHeadKpa = (riseMm: number): number =>
  (WATER_DENSITY * GRAVITY * (riseMm / 1000)) / 1000

/**
 * Friction loss along a run, kPa — Darcy-Weisbach with a Blasius friction factor.
 *
 * Blasius fits smooth-walled pipe over the whole domestic range, which is what all four of
 * these materials are; a roughness term would be noise beside the fitting allowance.
 */
export function pressureLossKpa(
  flowLs: number,
  bore: number,
  lengthMm: number,
  kinematicViscosity: number,
): number {
  if (flowLs <= 0 || bore <= 0 || lengthMm <= 0) return 0
  const d = bore / 1000
  const v = velocity(flowLs, bore)
  const reynolds = (v * d) / kinematicViscosity
  if (reynolds <= 0) return 0
  const f = reynolds < 2300 ? 64 / reynolds : 0.316 / Math.pow(reynolds, 0.25)
  return (f * ((lengthMm / 1000) / d) * ((WATER_DENSITY * v * v) / 2)) / 1000
}

/**
 * Largest water content of an un-circulated hot draw-off leg, litres.
 *
 * EN 806-2, DVGW W 551 and the Romanian NP 133 lineage all bound the *volume* standing in the
 * leg rather than its length: three litres is both how long you wait for hot water at the tap
 * and how much water sits in the Legionella growth range between draw-offs. A flat length
 * limit gets this wrong in both directions — three litres is about 22 m of 15 × 1,0 copper
 * but only 9,5 m of 22 × 1,0. Exceeding it means the design needs a circulation loop.
 */
export const MAX_HOT_DEAD_LEG_LITRES = 3

/** Water content of a run, litres. */
export const pipeVolumeLitres = (bore: number, lengthMm: number): number =>
  (Math.PI * (bore / 2) ** 2 * lengthMm) / 1_000_000
