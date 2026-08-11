/**
 * EN 12056-2 — gravity drainage inside buildings.
 *
 * We implement System I (single stack with partly filled branch discharge pipes), which is
 * the common European domestic arrangement, at 0.5 filling degree for branches.
 *
 * The numbers below are the standard's design tables. They are deliberately isolated here so
 * a different regional profile (e.g. IPC drainage fixture units) can be swapped in without
 * touching the solver.
 */

/** Frequency factor K — intermittent domestic use. */
export const K_DOMESTIC = 0.5

/**
 * Minimum branch diameter per discharge unit load, System I at 0.5 filling.
 *
 * Each entry is the largest DU load a nominal diameter may carry on a branch.
 */
const BRANCH_CAPACITY_DU: ReadonlyArray<{ dn: number; maxDu: number }> = [
  { dn: 40, maxDu: 0.5 },
  { dn: 50, maxDu: 1.5 },
  { dn: 70, maxDu: 3.0 },
  { dn: 100, maxDu: 6.0 },
  { dn: 125, maxDu: 12.0 },
  { dn: 150, maxDu: 20.0 },
]

/**
 * Stack capacity in l/s for a ventilated single stack with a swept-entry branch,
 * at 1/4 filling degree (EN 12056-2 table 12).
 */
const STACK_CAPACITY_LS: ReadonlyArray<{ dn: number; qmax: number }> = [
  { dn: 60, qmax: 0.5 },
  { dn: 70, qmax: 1.5 },
  { dn: 80, qmax: 2.0 },
  { dn: 90, qmax: 2.7 },
  { dn: 100, qmax: 4.0 },
  { dn: 125, qmax: 5.2 },
  { dn: 150, qmax: 9.3 },
]

/** Wastewater flow rate from a summed discharge-unit load: Qww = K·√ΣDU. */
export const flowFromDu = (sumDu: number, k: number = K_DOMESTIC): number =>
  k * Math.sqrt(Math.max(0, sumDu))

/**
 * Smallest branch diameter that carries the given DU load.
 *
 * `minDn` lets a fixture's own connection size act as a floor — a WC outlet is DN100
 * regardless of how little its DU figure would otherwise demand.
 */
export function branchDiameter(sumDu: number, minDn = 40): number {
  for (const row of BRANCH_CAPACITY_DU) {
    if (row.dn >= minDn && sumDu <= row.maxDu) return row.dn
  }
  return BRANCH_CAPACITY_DU[BRANCH_CAPACITY_DU.length - 1].dn
}

/** Smallest stack diameter that carries the given DU load. */
export function stackDiameter(sumDu: number, minDn = 100): number {
  const q = flowFromDu(sumDu)
  for (const row of STACK_CAPACITY_LS) {
    if (row.dn >= minDn && q <= row.qmax) return row.dn
  }
  return STACK_CAPACITY_LS[STACK_CAPACITY_LS.length - 1].dn
}

/**
 * Recommended fall for a branch of the given diameter, as a ratio.
 *
 * Practice is roughly 1:40 for small branches easing to 1:100 for DN100 and above; too
 * steep is a real fault, not just wasted headroom, because the water outruns the solids.
 */
export function slopeLimits(dn: number): { min: number; design: number; max: number } {
  if (dn <= 50) return { min: 0.0125, design: 0.025, max: 0.05 }
  if (dn <= 70) return { min: 0.01, design: 0.02, max: 0.05 }
  if (dn <= 100) return { min: 0.01, design: 0.015, max: 0.05 }
  return { min: 0.005, design: 0.01, max: 0.05 }
}

/**
 * Maximum unvented length from a trap to the stack, in mm.
 *
 * Beyond this the branch needs its own ventilation, which is out of scope for v1 — the
 * solver raises a warning instead of silently drawing something that would siphon.
 */
export function maxUnventedTrapDistance(dn: number): number {
  if (dn <= 40) return 3000
  if (dn <= 50) return 4000
  return 6000
}
