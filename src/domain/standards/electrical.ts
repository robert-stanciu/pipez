/**
 * Electrical rules — HD 60364 (adopted in Romania as I7) for circuit sizing, and the
 * DIN 18015-3 installation zones for where a cable is allowed to run inside a wall.
 *
 * The zones matter to the router: a cable buried outside them is a real defect, because the
 * next person to drill a shelf into the wall has no way to predict where it is.
 */

import type { ElectricalCircuitKind } from '../types.ts'

export const NOMINAL_VOLTAGE = 230

export interface CircuitRule {
  kind: ElectricalCircuitKind
  label: string
  breakerAmps: number
  cableMm2: number
  rcdProtected: boolean
  /** Maximum number of outlets on one circuit; Infinity for dedicated circuits. */
  maxOutlets: number
  /** Design load ceiling in watts before a second circuit is opened. */
  maxWatts: number
}

export const CIRCUIT_RULES: Record<ElectricalCircuitKind, CircuitRule> = {
  lighting: {
    kind: 'lighting',
    label: 'Lighting',
    breakerAmps: 10,
    cableMm2: 1.5,
    rcdProtected: true,
    maxOutlets: 12,
    maxWatts: 1800,
  },
  sockets: {
    kind: 'sockets',
    label: 'Socket outlets',
    breakerAmps: 16,
    cableMm2: 2.5,
    rcdProtected: true,
    maxOutlets: 10,
    maxWatts: 2900,
  },
  appliance: {
    kind: 'appliance',
    label: 'Dedicated appliance',
    breakerAmps: 16,
    cableMm2: 2.5,
    rcdProtected: true,
    maxOutlets: Infinity,
    maxWatts: 3500,
  },
  cooker: {
    kind: 'cooker',
    label: 'Cooker',
    breakerAmps: 32,
    cableMm2: 6,
    rcdProtected: true,
    maxOutlets: Infinity,
    maxWatts: 7000,
  },
}

/** Conductor cross-section for a breaker rating, PVC-insulated copper in a wall chase. */
export function cableSizeForBreaker(amps: number): number {
  if (amps <= 10) return 1.5
  if (amps <= 16) return 2.5
  if (amps <= 20) return 4
  if (amps <= 25) return 6
  if (amps <= 32) return 6
  if (amps <= 40) return 10
  return 16
}

export const currentFor = (watts: number, voltage = NOMINAL_VOLTAGE): number => watts / voltage

/**
 * Permitted horizontal installation zones, as a band of heights above the finished floor.
 * DIN 18015-3: a strip near the floor, one at switch height, and one below the ceiling.
 */
export interface InstallZone {
  /** Lower bound above the finished floor, mm. */
  from: number
  /** Upper bound above the finished floor, mm. */
  to: number
  label: string
}

export function horizontalZones(roomHeight: number): InstallZone[] {
  return [
    { from: 150, to: 450, label: 'lower zone' },
    { from: 1000, to: 1300, label: 'switch zone' },
    { from: roomHeight - 450, to: roomHeight - 150, label: 'upper zone' },
  ]
}

/**
 * Permitted vertical zones, as a distance band measured from a corner or a door reveal.
 * A vertical drop to an outlet must sit inside one of these.
 */
export const VERTICAL_ZONE = { from: 100, to: 300 } as const

/** True when a height above the floor falls inside a permitted horizontal band. */
export function inHorizontalZone(z: number, roomHeight: number): boolean {
  return horizontalZones(roomHeight).some((zone) => z >= zone.from && z <= zone.to)
}

/**
 * Bathroom protective zones (HD 60364-7-701) — nothing but the fixed appliance's own
 * supply belongs in zones 0 and 1, so the router treats them as no-go volumes.
 */
export const BATHROOM_ZONE_1_RADIUS = 600
export const BATHROOM_ZONE_1_HEIGHT = 2250
