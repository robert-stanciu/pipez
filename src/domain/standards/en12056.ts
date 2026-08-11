/**
 * EN 12056-2 — gravity drainage inside buildings.
 *
 * We implement System I (single stack with partly filled branch discharge pipes), which is
 * the common European domestic arrangement. Branches are sized at a 0.5 filling degree and
 * stacks at f = 0.33, which is what the standard's stack table is drawn up for; the collector
 * below the stack is sized at 0.5 filling and checked against a 0.7 limit.
 *
 * The numbers below are the standard's design tables, as reproduced in DIN 1986-100 and in
 * Geberit's *Waste Water Hydraulics*. They are deliberately isolated here so a different
 * regional profile (e.g. IPC drainage fixture units) can be swapped in without touching the
 * solver.
 */

/** Frequency factor K — intermittent domestic use. */
export const K_DOMESTIC = 0.5

/**
 * Depth of water a trap must hold to keep the drain out of the room.
 *
 * EN 12056-2 puts the floor at 50 mm. This is the *seal*, not the size of the fitting: the
 * body a trap needs under an appliance outlet is a different and much larger figure, and it
 * lives with the appliance in the fixture catalogue.
 */
export const TRAP_SEAL_DEPTH = 50

interface BranchRow {
  dn: number
  maxDu: number
  /** WCs this diameter may carry. A WC is the one appliance a branch is not sized for by DU. */
  maxWc: number
}

/**
 * Largest DU load each nominal diameter may carry on a non-ventilated collector branch.
 *
 * EN 12056-2 / DIN 1986-100, System I, K = 0.5, un-ventilated collector branch. The WC column
 * is a separate limit rather than a consequence of the load: a WC discharges a slug of water
 * and solids that a DN 70 branch cannot clear whatever else is on it, and DN 90 clears at most
 * two.
 *
 * DN 125 and DN 150 are absent on purpose. They are collector sizes, and a collector is sized
 * from its gradient rather than from its DU load — see `collectorDiameter`.
 */
const BRANCH_CAPACITY_DU: ReadonlyArray<BranchRow> = [
  { dn: 40, maxDu: 0.5, maxWc: 0 },
  { dn: 50, maxDu: 1.0, maxWc: 0 },
  { dn: 70, maxDu: 9.0, maxWc: 0 },
  { dn: 90, maxDu: 13.0, maxWc: 2 },
  { dn: 100, maxDu: 16.0, maxWc: Infinity },
]

/**
 * Stack capacity in l/s: a stack with a stack vent, **swept-entry** branch fittings.
 *
 * EN 12056-2 / DIN 1986-100, System I at f = 0.33. The swept-entry column is the one that
 * applies here because `sweepJunctions()` really does draw swept-entry branch fittings — every
 * branch is swung round to enter the run it feeds at 45°. A square entry would halve these
 * figures, and quoting them against geometry that is not built that way is how a stack ends up
 * a size too small.
 *
 * DN 60 and DN 80 are not European product sizes and have no row in the standard.
 */
const STACK_CAPACITY_LS: ReadonlyArray<{ dn: number; qmax: number }> = [
  { dn: 70, qmax: 2.0 },
  { dn: 90, qmax: 3.5 },
  { dn: 100, qmax: 5.2 },
  { dn: 125, qmax: 7.6 },
  { dn: 150, qmax: 12.4 },
  { dn: 200, qmax: 21.0 },
]

/**
 * Smallest stack that may carry a WC, whatever the flow works out at.
 *
 * DIN 1986-100 fixes it at DN 90; Romanian practice runs ø110 throughout, which satisfies it
 * comfortably, but the floor is what the standard actually requires.
 */
export const MIN_WC_STACK_DN = 90

/** Smallest collector, from the stack foot to where the drainage leaves the building. */
export const COLLECTOR_MIN_DN = 100

/** The gradients the collector table is tabulated at, as ratios. */
const COLLECTOR_SLOPES: readonly number[] = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05]

/**
 * Collector capacity in l/s at each tabulated gradient, at 50 % filling.
 *
 * EN 12056-2 / DIN 1986-100, collector and underground drain (Sammel- und Grundleitung), one
 * row per nominal width, columns in the order of `COLLECTOR_SLOPES`. A collector is not sized
 * from discharge units at all — the gradient decides what it carries, which is why this is a
 * different table from the branch one and why the run below a stack has to be recognised as a
 * collector rather than sized as a long branch.
 */
const COLLECTOR_CAPACITY_LS: ReadonlyArray<{ dn: number; qmax: readonly number[] }> = [
  { dn: 70, qmax: [0.6, 0.9, 1.2, 1.4, 1.5, 1.7, 1.9, 2.2] },
  { dn: 100, qmax: [1.8, 2.5, 3.1, 3.5, 4.0, 4.4, 5.0, 5.6] },
  { dn: 125, qmax: [3.4, 4.1, 5.0, 5.7, 6.4, 7.1, 8.2, 9.1] },
  { dn: 150, qmax: [5.3, 7.7, 9.4, 10.9, 12.2, 13.3, 15.4, 17.2] },
]

/** Filling a collector may not exceed: EN 12056-2 caps h/di at 0.7. */
export const MAX_COLLECTOR_FILLING = 0.7

/**
 * Velocity band for a sewage pipe, m/s.
 *
 * EN 12056-2 sets no maximum *gradient* — a steep pipe is not a fault, and the folk rule that
 * water outruns the solids has no place in the standard. What it does set is a velocity band:
 * below the minimum a run stops scouring itself, above the maximum the flow starts to damage
 * the pipe and the fittings. The minimum is deemed satisfied by laying to at least the minimum
 * gradient, so only the ceiling is worth checking against the drawn geometry.
 */
export const VELOCITY_LIMITS = { min: 0.7, max: 2.5 }

/** Wastewater flow rate from a summed discharge-unit load: Qww = K·√ΣDU. */
export const flowFromDu = (sumDu: number, k: number = K_DOMESTIC): number =>
  k * Math.sqrt(Math.max(0, sumDu))

/**
 * Smallest branch diameter that carries the given DU load and number of WCs.
 *
 * `minDn` lets a fixture's own connection size act as a floor — a WC outlet is DN90 regardless
 * of how little its DU figure would otherwise demand.
 */
export function branchDiameter(sumDu: number, minDn = 40, wcCount = 0): number {
  for (const row of BRANCH_CAPACITY_DU) {
    if (row.dn >= minDn && sumDu <= row.maxDu && wcCount <= row.maxWc) return row.dn
  }
  return BRANCH_CAPACITY_DU[BRANCH_CAPACITY_DU.length - 1].dn
}

/** Smallest stack diameter that carries the given DU load. */
export function stackDiameter(sumDu: number, minDn = 70, wcCount = 0): number {
  const q = flowFromDu(sumDu)
  const floor = Math.max(minDn, wcCount > 0 ? MIN_WC_STACK_DN : 0)
  for (const row of STACK_CAPACITY_LS) {
    if (row.dn >= floor && q <= row.qmax) return row.dn
  }
  return STACK_CAPACITY_LS[STACK_CAPACITY_LS.length - 1].dn
}

/**
 * Smallest collector that carries the given DU load at the gradient it is actually laid to.
 *
 * The gradient is read down to the nearest tabulated column rather than interpolated up: a run
 * laid at 1.8 % is credited with what the standard allows at 1.5 %, so rounding never buys
 * capacity the table does not grant.
 */
export function collectorDiameter(sumDu: number, slope: number, minDn = COLLECTOR_MIN_DN): number {
  const q = flowFromDu(sumDu)
  let column = 0
  for (let i = 0; i < COLLECTOR_SLOPES.length; i++) {
    if (slope >= COLLECTOR_SLOPES[i] - 1e-9) column = i
  }
  const floor = Math.max(minDn, COLLECTOR_MIN_DN)
  for (const row of COLLECTOR_CAPACITY_LS) {
    if (row.dn >= floor && q <= row.qmax[column]) return row.dn
  }
  return COLLECTOR_CAPACITY_LS[COLLECTOR_CAPACITY_LS.length - 1].dn
}

/**
 * Fall limits for a run of the given diameter, as ratios.
 *
 * EN 12056-2 / DIN 1986-100 give two different rules, and which one applies is a question
 * about what the pipe *is*, not how wide it is: a branch falls at least 1 % un-ventilated and
 * 0.5 % ventilated whatever its diameter, while a collector or underground drain falls at
 * least 1 : DN — which for anything up to DN 200 is a *steeper* requirement than the flat
 * 0.5 % that small-bore practice reaches for, not a gentler one.
 *
 * `collector` defaults to reading the diameter as a proxy for the role, which is right often
 * enough for a caller that only has a size to hand; the router knows better and says so.
 *
 * `max` is not a standards figure: EN sets no maximum gradient at all. It is the project's own
 * preference for how steep pipework may be laid, and the real ceiling is the velocity band in
 * `VELOCITY_LIMITS`.
 */
export function slopeLimits(
  dn: number,
  ventilated = false,
  collector = dn > 56,
): { min: number; design: number; max: number } {
  if (collector) return { min: Math.max(1 / dn, 0.005), design: Math.max(1 / dn, 0.01), max: 0.05 }
  return { min: ventilated ? 0.005 : 0.01, design: 0.02, max: 0.05 }
}

export interface UnventedBranchLimits {
  /** Trap to stack, mm. */
  maxLength: number
  /** Appliance connection down to the branch invert at the stack, mm. */
  maxDrop: number
  /**
   * Total change of direction, in degrees.
   *
   * The standard counts three right angles, and adds that where the turns are shallower than
   * 90° their angles must sum to no more than 270° — the same budget, spent in smaller coins.
   */
  maxTurn: number
  minSlope: number
}

/**
 * Application limits for a branch with no ventilation of its own.
 *
 * EN 12056-2 / DIN 1986-100 give these as a small table of *diameter-independent* figures —
 * length, drop, direction changes and gradient — rather than as a length per diameter. The one
 * place the diameter enters is that a collector branch of DN 70 and above is allowed 10 m
 * where everything else is allowed 4 m.
 *
 * Beyond these a branch needs its own ventilation, which is out of scope for v1: the solver
 * raises a warning rather than silently drawing something that would siphon a trap.
 */
export function unventedBranchLimits(dn: number, isCollector: boolean): UnventedBranchLimits {
  return {
    maxLength: isCollector && dn >= 70 ? 10_000 : 4000,
    maxDrop: 1000,
    maxTurn: 270,
    minSlope: 0.01,
  }
}

/**
 * Roughness coefficient for a part-full drain, Gauckler–Manning–Strickler, m^(1/3)/s.
 *
 * DIN sizes drains with Prandtl–Colebrook, which needs iterating on the friction factor as
 * well as on the filling. Strickler with kSt = 75 reproduces the standard's own collector table
 * to within a few percent across DN 70 to DN 150, so it is what the velocity and filling checks
 * are computed with — the tables above remain the authority on capacity.
 */
const MANNING_KST = 75

/**
 * The central angle at which a circular pipe carries the most it ever will (h/di ≈ 0.94).
 *
 * Discharge is not monotonic all the way to full bore — the last sliver of water adds more
 * wetted perimeter than area — so the solve for the filling degree is bracketed here rather
 * than at 2π.
 */
const THETA_MAX_FLOW = 2 * Math.acos(1 - 2 * 0.938)

/**
 * How fast, and how full, a drain of this size runs at this flow and gradient.
 *
 * Both figures come out of the same solve: find the filling degree at which the pipe passes
 * the flow, and the velocity follows from the wetted area. A surcharged pipe is reported as
 * full rather than as an impossible filling.
 */
export function partFullFlow(
  flowLs: number,
  dn: number,
  slope: number,
): { velocity: number; filling: number } {
  const d = dn / 1000
  const q = Math.max(0, flowLs) / 1000
  if (q <= 0 || d <= 0 || slope <= 0) return { velocity: 0, filling: 0 }

  /** Wetted area and the discharge it passes, for a wetted arc of `theta` radians. */
  const at = (theta: number) => {
    const area = ((d * d) / 8) * (theta - Math.sin(theta))
    const radius = (d / 4) * (1 - Math.sin(theta) / theta)
    return { area, flow: area * MANNING_KST * Math.pow(radius, 2 / 3) * Math.sqrt(slope) }
  }

  const peak = at(THETA_MAX_FLOW)
  if (q >= peak.flow) return { velocity: q / peak.area, filling: 1 }

  let low = 1e-6
  let high = THETA_MAX_FLOW
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    if (at(mid).flow < q) low = mid
    else high = mid
  }
  const theta = (low + high) / 2
  return { velocity: q / at(theta).area, filling: (1 - Math.cos(theta / 2)) / 2 }
}
