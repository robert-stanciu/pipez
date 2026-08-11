/**
 * EN 806-3 — the simplified sizing method for drinking-water installations inside buildings.
 *
 * Fixtures contribute loading units (LU); a run's diameter follows from the summed LU it
 * carries. Copper/stainless nominal diameters are used; the DN figures double as the
 * ordering key for PEX or multilayer equivalents.
 */

/** Peak demand from a summed loading-unit figure (EN 806-3 annex, l/s). */
export const flowFromLu = (sumLu: number): number =>
  sumLu <= 0 ? 0 : 0.682 * Math.pow(sumLu, 0.45) - 0.14

/**
 * Largest LU load each nominal diameter may serve on a branch or distributing run.
 * Derived from the EN 806-3 simplified table for copper, ≤ 2 m/s velocity.
 */
const SUPPLY_CAPACITY_LU: ReadonlyArray<{ dn: number; maxLu: number }> = [
  { dn: 12, maxLu: 1 },
  { dn: 15, maxLu: 3 },
  { dn: 18, maxLu: 8 },
  { dn: 22, maxLu: 20 },
  { dn: 28, maxLu: 55 },
  { dn: 35, maxLu: 120 },
  { dn: 42, maxLu: 250 },
]

/** Smallest supply diameter that serves the given LU load, never below `minDn`. */
export function supplyDiameter(sumLu: number, minDn = 12): number {
  for (const row of SUPPLY_CAPACITY_LU) {
    if (row.dn >= minDn && sumLu <= row.maxLu) return row.dn
  }
  return SUPPLY_CAPACITY_LU[SUPPLY_CAPACITY_LU.length - 1].dn
}

/**
 * Maximum length of an un-circulated hot draw-off leg, in mm.
 *
 * EN 806-2 caps the dead leg so the wait for hot water — and the Legionella risk in the
 * stagnant volume — stays bounded. Exceeding it means the design needs a circulation loop.
 */
export const MAX_HOT_DEAD_LEG = 12_000

/** Velocity check helper: flow (l/s) through a bore (mm) as m/s. */
export function velocity(flowLs: number, dn: number): number {
  const bore = dn / 1000
  const areaM2 = Math.PI * (bore / 2) ** 2
  return areaM2 <= 0 ? 0 : flowLs / 1000 / areaM2
}
