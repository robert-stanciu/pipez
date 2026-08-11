/**
 * Electrical rules — HD 60364 (adopted in Romania as I7) for circuit sizing and protection,
 * and the DIN 18015-3 installation zones for where a cable is allowed to run inside a wall.
 *
 * The zones matter to the router: a cable buried outside them is a real defect, because the
 * next person to drill a shelf into the wall has no way to predict where it is.
 */

import type { ElectricalCircuitKind, Phase } from '../types.ts'

/**
 * Line-to-neutral and line-to-line voltages.
 *
 * A three-phase supply gives 400 V between any two lines and 230 V from a line to neutral.
 * The older designation for the same system is 380/220 V; the numbers here are the current
 * nominal ones, and both are editable in the project settings.
 */
export const NOMINAL_VOLTAGE = 230
export const NOMINAL_LINE_VOLTAGE = 400

export const PHASES: Phase[] = ['L1', 'L2', 'L3']

/** Core colours under HD 308 S2 — what the drawing and the panel view are labelled with. */
export const PHASE_COLOUR: Record<Phase, string> = {
  L1: '#8d6e63',
  L2: '#37474f',
  L3: '#9e9e9e',
}

export const PHASE_CORE_NAME: Record<Phase, string> = {
  L1: 'brown',
  L2: 'black',
  L3: 'grey',
}

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
  /**
   * Fraction of the connected load that can be expected at the same time as everything
   * else — the diversity allowance. Lighting is never all on; a water heater's thermostat
   * does not care what the rest of the house is doing.
   */
  diversity: number
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
    diversity: 0.66,
  },
  sockets: {
    kind: 'sockets',
    label: 'Socket outlets',
    breakerAmps: 16,
    cableMm2: 2.5,
    rcdProtected: true,
    maxOutlets: 10,
    maxWatts: 2900,
    diversity: 0.5,
  },
  appliance: {
    kind: 'appliance',
    label: 'Dedicated appliance',
    breakerAmps: 16,
    cableMm2: 2.5,
    rcdProtected: true,
    maxOutlets: Infinity,
    maxWatts: 3500,
    diversity: 1,
  },
  cooker: {
    kind: 'cooker',
    label: 'Cooker',
    breakerAmps: 32,
    cableMm2: 6,
    rcdProtected: true,
    maxOutlets: Infinity,
    maxWatts: 11_000,
    // A hob is never at full output on every ring at once.
    diversity: 0.6,
  },
}

/** Conductor cross-section for a breaker rating, PVC-insulated copper in a wall chase. */
export function cableSizeForBreaker(amps: number): number {
  if (amps <= 10) return 1.5
  if (amps <= 16) return 2.5
  if (amps <= 20) return 4
  if (amps <= 32) return 6
  if (amps <= 40) return 10
  if (amps <= 50) return 16
  return 25
}

/** The next standard breaker at or above a design current. */
export function breakerFor(amps: number): number {
  for (const rating of [6, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100]) {
    if (rating >= amps) return rating
  }
  return 125
}

/**
 * Design current.
 *
 * A three-phase load is shared over three lines, so each line carries the power divided by
 * √3 × the line voltage — appreciably less than the same kilowatts on one phase, which is the
 * main reason for running a cooker or a heat pump three-phase at all.
 */
export function currentFor(
  watts: number,
  poles: 1 | 3 = 1,
  voltage = NOMINAL_VOLTAGE,
  lineVoltage = NOMINAL_LINE_VOLTAGE,
): number {
  // Balanced three-phase at unity power factor: I = P / (√3 · U_line).
  return poles === 3 ? watts / (Math.sqrt(3) * lineVoltage) : watts / voltage
}

/* ------------------------------------------------------------------ volt drop */

/**
 * Resistivity of copper at working temperature, Ω·mm²/m.
 *
 * The tables assume the conductor is hot, not at 20 °C — using the cold figure understates
 * the drop by about a quarter, which is exactly the margin the limit exists to protect.
 */
export const COPPER_RESISTIVITY = 0.0225

/** Permitted drop from the origin of the installation, as a fraction of nominal. */
export const VOLT_DROP_LIMIT: Record<'lighting' | 'other', number> = {
  lighting: 0.03,
  other: 0.05,
}

/**
 * Volt drop along a run, in volts.
 *
 * Single-phase current goes out along the line and back along the neutral, so the loop is
 * twice the route length. A balanced three-phase load has no return through the neutral, and
 * the line-to-line geometry gives √3 instead of 2.
 */
export function voltDrop(
  current: number,
  lengthMm: number,
  cableMm2: number,
  poles: 1 | 3,
): number {
  if (cableMm2 <= 0) return 0
  const metres = lengthMm / 1000
  const factor = poles === 3 ? Math.sqrt(3) : 2
  return (factor * COPPER_RESISTIVITY * metres * current) / cableMm2
}

export const voltDropPercent = (
  drop: number,
  poles: 1 | 3,
  voltage = NOMINAL_VOLTAGE,
  lineVoltage = NOMINAL_LINE_VOLTAGE,
): number => (drop / (poles === 3 ? lineVoltage : voltage)) * 100

/**
 * Smallest cable that keeps the drop inside the limit, never below what the breaker needs.
 *
 * Sizing on the breaker alone is only half the job: a 2.5 mm² circuit protected at 16 A is
 * perfectly safe and still unusable at forty metres, because the far end sags below what the
 * appliance will start on.
 */
export function cableForRun(
  breakerAmps: number,
  designCurrent: number,
  lengthMm: number,
  poles: 1 | 3,
  limit: number,
  voltage = NOMINAL_VOLTAGE,
  lineVoltage = NOMINAL_LINE_VOLTAGE,
): number {
  const sizes = [1.5, 2.5, 4, 6, 10, 16, 25, 35]
  const floor = cableSizeForBreaker(breakerAmps)
  for (const size of sizes) {
    if (size < floor) continue
    const drop = voltDrop(designCurrent, lengthMm, size, poles)
    if (voltDropPercent(drop, poles, voltage, lineVoltage) <= limit * 100) return size
  }
  return sizes[sizes.length - 1]
}

/* --------------------------------------------------------- installation zones */

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
