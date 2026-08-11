/**
 * Electrical rules — HD 60364 (adopted in Romania as I7) for circuit sizing and protection,
 * and the DIN 18015-3 installation zones for where a cable is allowed to run inside a wall.
 *
 * The zones matter to the router: a cable buried outside them is a real defect, because the
 * next person to drill a shelf into the wall has no way to predict where it is.
 */

import type {
  EarthingSystem,
  ElectricalCircuitKind,
  ElectricalSettings,
  InstallationMethod,
  McbCurve,
  Phase,
  SpdSpec,
  SurgeProtection,
} from '../types.ts'

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

/**
 * Core colours under HD 308 S2 — what the drawing and the panel view are labelled with.
 *
 * All five live here, not three: the neutral and the protective conductor are as much part of
 * the identification scheme as the lines are, and a copy of them kept in a view is a copy that
 * will eventually disagree. The black is a true black rather than the blue-grey it used to be,
 * because a blue-grey L2 beside a blue neutral is exactly the pair a fitter must never
 * hesitate over.
 */
export const PHASE_COLOUR: Record<Phase, string> = {
  L1: '#8d6e63',
  L2: '#212121',
  L3: '#9e9e9e',
}

export const NEUTRAL_COLOUR = '#1e6fd9'

/** Green-and-yellow, in that order — the protective conductor is the only bicolour core. */
export const PE_COLOURS: readonly [string, string] = ['#0f9d58', '#efd018']

export const PHASE_CORE_NAME: Record<Phase | 'N' | 'PE', string> = {
  L1: 'brown',
  L2: 'black',
  L3: 'grey',
  N: 'blue',
  PE: 'green-yellow',
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

/**
 * Circuit limits.
 *
 * The outlet and load ceilings are I7-2011's rather than the looser figures a European
 * general-purpose table would give: eight socket outlets and 3 kW on one single-phase socket
 * circuit, thirty lamp positions per phase on lighting. *Confidence on the two I7 numbers is
 * medium* — they are consistent across Romanian secondary sources but have not been read out
 * of the ordinance text itself; the European rules elsewhere in this module are first-hand.
 *
 * Lighting is held to twelve points rather than I7's thirty. Thirty 60 W lamps is 1.8 kW on
 * one 10 A breaker, which is legal and which nobody builds; twelve is the split an
 * electrician would actually make, and it is the conservative direction. Its load ceiling is
 * simply what the breaker can pass — 10 A × 230 V.
 */
export const CIRCUIT_RULES: Record<ElectricalCircuitKind, CircuitRule> = {
  lighting: {
    kind: 'lighting',
    label: 'Lighting',
    breakerAmps: 10,
    cableMm2: 1.5,
    rcdProtected: true,
    maxOutlets: 12,
    maxWatts: 2300,
    // The IEC Electrical Installation Guide takes lighting at unity: the diversity between
    // circuits is dealt with once, by ks, rather than twice.
    diversity: 1,
  },
  sockets: {
    kind: 'sockets',
    label: 'Socket outlets',
    breakerAmps: 16,
    cableMm2: 2.5,
    rcdProtected: true,
    maxOutlets: 8,
    maxWatts: 3000,
    // Sockets are the one category the guide still discounts individually — a circuit of ten
    // outlets is never asked for ten outlets' worth of load.
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
    // A water heater, a washing machine or a dishwasher is taken at its full rating.
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
    // A hob is never at full output on every ring at once; the guide's figure for a domestic
    // cooking appliance is 0.7.
    diversity: 0.7,
  },
}

/**
 * Circuit-count factor ks, IEC Electrical Installation Guide, for a domestic distribution
 * board. This — not a per-appliance fudge — is the mechanism that keeps a maximum demand
 * honest: the more final circuits a board has, the smaller the fraction of them that is ever
 * loaded at once.
 */
export function circuitCountFactor(circuits: number): number {
  if (circuits <= 1) return 1
  if (circuits <= 3) return 0.9
  if (circuits <= 5) return 0.8
  if (circuits <= 9) return 0.7
  return 0.6
}

/* -------------------------------------------------- current-carrying capacity */

/**
 * HD 60364-5-52 Table B.52.4 — copper, PVC insulation (70 °C), **two loaded conductors**,
 * ambient 30 °C, amps. The five reference methods are the ones a house is wired by:
 *
 *  - A1/A2 conductors in a conduit in a thermally insulated wall,
 *  - B1 conductors in a conduit on or **chased into** a wall, B2 a cable in the same conduit,
 *  - C a cable clipped direct to a surface.
 *
 * B1 is the default because it is what `FY în tub îngropat` is: singles pulled into a tube
 * buried in the plaster. Anything on this table is a *tabulated* capacity It — the capacity
 * the conductor actually has, Iz, is It derated for ambient, grouping and insulation.
 */
export const CABLE_SIZES = [1.5, 2.5, 4, 6, 10, 16, 25] as const

export const CURRENT_CAPACITY: Record<number, Record<InstallationMethod, number>> = {
  1.5: { A1: 14.5, A2: 14, B1: 17.5, B2: 16.5, C: 19.5 },
  2.5: { A1: 19.5, A2: 18.5, B1: 24, B2: 23, C: 27 },
  4: { A1: 26, A2: 25, B1: 32, B2: 30, C: 36 },
  6: { A1: 34, A2: 32, B1: 41, B2: 38, C: 46 },
  10: { A1: 46, A2: 43, B1: 57, B2: 52, C: 63 },
  16: { A1: 61, A2: 57, B1: 76, B2: 69, C: 85 },
  25: { A1: 80, A2: 75, B1: 101, B2: 90, C: 112 },
}

/**
 * Grouping factor Cg, HD 60364-5-52 Table B.52.17, for circuits bunched in one conduit or
 * chase in a single layer.
 *
 * This is the correction the router makes unavoidable. Cables are deliberately bundled — the
 * reuse discount pulls branches onto shared trunks, the wall zones are shared, the risers are
 * shared — and six 2.5 mm² circuits in one chase carry 24 × 0.57 = 13.7 A each, not 24. A
 * ladder that never looks at its neighbours cannot see that.
 */
export function groupingFactor(circuits: number): number {
  const table = [1, 1, 0.8, 0.7, 0.65, 0.6, 0.57, 0.54, 0.52]
  if (circuits <= 1) return 1
  return circuits < table.length ? table[circuits] : 0.5
}

/**
 * Ambient temperature correction Ca, HD 60364-5-52 Table B.52.14, PVC. Unity at the 30 °C the
 * tables are written for, which is the design condition indoors.
 */
export const AMBIENT_FACTOR = 1

/**
 * Thermal insulation correction Ci, HD 60364-5-52 §523.9. Unity: a chase in plaster is not a
 * cable buried in insulation, and the case where it would be is a warning, not a coefficient.
 */
export const INSULATION_FACTOR = 1

/** Iz = It · Ca · Cg · Ci — what the conductor can actually carry where it is installed. */
export function currentCapacity(
  cableMm2: number,
  method: InstallationMethod = 'B1',
  grouped = 1,
): number {
  const row = CURRENT_CAPACITY[cableMm2]
  if (!row) return 0
  return row[method] * AMBIENT_FACTOR * groupingFactor(grouped) * INSULATION_FACTOR
}

/**
 * Conventional conductor for a breaker rating: PVC-insulated copper singles in a buried
 * tube, as a Romanian board is stocked and wired.
 *
 * Kept as a floor rather than replaced by the table, and the larger of the two always wins.
 * The table alone would put a 16 A circuit on 1.5 mm² — 17.5 A tabulated is genuinely above
 * 16 A — and while that satisfies HD 60364-5-52 it is not what anyone builds a socket circuit
 * from, and it leaves nothing for the first neighbour that shares the chase.
 */
export function cableSizeForBreaker(
  amps: number,
  method: InstallationMethod = 'B1',
  grouped = 1,
): number {
  const conventional =
    amps <= 10 ? 1.5 : amps <= 16 ? 2.5 : amps <= 20 ? 4 : amps <= 32 ? 6 : amps <= 40 ? 10 : amps <= 50 ? 16 : 25
  return sizeForCapacity(amps, method, grouped, conventional)
}

/**
 * Smallest conductor whose derated capacity holds the protective device: Iz ≥ In, the first
 * of the two HD 60364-4-43 coordination conditions. Returns the largest size on the table
 * when nothing satisfies it, which is a case the caller has to warn about rather than hide.
 */
export function sizeForCapacity(
  amps: number,
  method: InstallationMethod = 'B1',
  grouped = 1,
  minimumMm2 = 0,
): number {
  for (const size of CABLE_SIZES) {
    if (size < minimumMm2) continue
    if (currentCapacity(size, method, grouped) >= amps) return size
  }
  return CABLE_SIZES[CABLE_SIZES.length - 1]
}

/**
 * The next standard breaker at or above a design current.
 *
 * EN 60898-1 preferred ratings as they are actually stocked in Romania. 13 A is a British
 * plug-fuse rating and is not made as a miniature circuit breaker here; 8 A is, and was
 * missing.
 */
export function breakerFor(amps: number): number {
  for (const rating of [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125]) {
    if (rating >= amps) return rating
  }
  return 125
}

/**
 * Trip curve.
 *
 * A curve B breaker trips on three to five times its rating and suits resistive and lighting
 * loads; curve C tolerates five to ten and is what a motor or a cooker's inrush needs without
 * nuisance tripping.
 *
 * **Curve C throughout, deliberately.** B for lighting and sockets is the German and British
 * convention; a Romanian board is conventionally all C, and mixing the two on one project
 * produces a schedule no local wholesaler can fill from stock. The reason B is preferred
 * elsewhere — a lower fault current is enough to disconnect in time — does not bite here,
 * because every final circuit is behind a 30 mA residual current device, which is the means
 * of fault protection on a TT installation and additional protection on a TN one either way.
 */
export const curveFor = (_kind: ElectricalCircuitKind): McbCurve => 'C'

/**
 * Rated short-circuit breaking capacity, EN 60898-1 (Icn): 4.5, 6 or 10 kA.
 *
 * 6 kA is the normal domestic choice in Romania — 4.5 kA is only defensible well down a rural
 * feeder, and 10 kA is for a board close to the transformer.
 */
export const BREAKING_CAPACITY = 6000

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
  /** Reference method and the number of circuits bunched with this one, for Iz ≥ In. */
  method: InstallationMethod = 'B1',
  grouped = 1,
  /** Conventional minimum for the kind of circuit — 2.5 mm² on sockets, whatever the sums say. */
  minimumMm2 = 0,
  /** Headroom already spent upstream, as a percentage — a sub-board's submain drop. */
  upstreamPercent = 0,
): number {
  // The same list the capacity table is written for, so a conductor can never be chosen that
  // there is no tabulated capacity to check it against. Where even the largest of them cannot
  // hold the drop, that is a warning for the caller to make — not a size to invent.
  const floor = Math.max(cableSizeForBreaker(breakerAmps, method, grouped), minimumMm2)
  for (const size of CABLE_SIZES) {
    if (size < floor) continue
    const drop = voltDrop(designCurrent, lengthMm, size, poles)
    if (voltDropPercent(drop, poles, voltage, lineVoltage) + upstreamPercent <= limit * 100) {
      return size
    }
  }
  return CABLE_SIZES[CABLE_SIZES.length - 1]
}

/* ------------------------------------------------------------------- earthing */

/** Where the defaults live for settings a project file may predate. */
export const DEFAULT_EARTHING: EarthingSystem = 'TN-C-S'
export const DEFAULT_INSTALLATION_METHOD: InstallationMethod = 'B1'
export const DEFAULT_SURGE_PROTECTION: SurgeProtection = 'type-2'
export const DEFAULT_MODULES_PER_ROW = 12

export const earthingOf = (settings: ElectricalSettings): EarthingSystem =>
  settings.earthing ?? DEFAULT_EARTHING
export const methodOf = (settings: ElectricalSettings): InstallationMethod =>
  settings.installationMethod ?? DEFAULT_INSTALLATION_METHOD
export const surgeProtectionOf = (settings: ElectricalSettings): SurgeProtection =>
  settings.surgeProtection ?? DEFAULT_SURGE_PROTECTION
export const modulesPerRowOf = (settings: ElectricalSettings): number =>
  settings.modulesPerRow ?? DEFAULT_MODULES_PER_ROW

/**
 * Protective conductor cross-section, HD 60364-5-54 Table 54.2, for a PE of the same
 * material as the line conductor:
 *
 *   S ≤ 16 → S,  16 < S ≤ 35 → 16 mm²,  S > 35 → S/2.
 *
 * The table is an alternative to calculating the adiabatic equation, and is what a domestic
 * schedule is written from.
 */
export function peSize(lineMm2: number): number {
  if (lineMm2 <= 16) return lineMm2
  if (lineMm2 <= 35) return 16
  return lineMm2 / 2
}

/**
 * Main protective bonding conductor, HD 60364-5-54 §544.1: half the cross-section of the
 * installation's protective conductor, never below 6 mm², and no benefit above 25 mm².
 *
 * On TN-C-S this is the conductor that makes the arrangement safe at all — the incoming water
 * and gas services and the structural steel have to be tied to the main earthing terminal, or
 * a broken PEN puts the supply neutral's voltage on every pipe in the house.
 */
export function mainBondingSize(peMm2: number): number {
  return Math.min(25, Math.max(6, peMm2 / 2))
}

/**
 * Whether an earth electrode has to be installed rather than relied on from the supply.
 *
 * TT has no protective earth from the distributor at all: the installation makes its own, and
 * the loop impedance through two electrodes in series is far too high for any breaker to
 * clear a fault, which is why the 30 mA device is not merely additional protection there but
 * the whole of it.
 */
export const needsEarthElectrode = (earthing: EarthingSystem): boolean => earthing === 'TT'

/* ------------------------------------------------------------ surge protection */

/**
 * The surge protective device at the origin.
 *
 * IEC/HD 60364-4-44 §443 (2018) requires surge protection unless a documented risk assessment
 * says otherwise, and HD 60364-5-534 gives the installation rules. A detached house on an
 * overhead or mixed supply — the normal Romanian case — takes a Type 2 arrester at the main
 * board: one module per line plus one for the neutral, connected on the supply side of the
 * residual current devices so that a discharge to earth does not trip the house out.
 *
 * Up ≤ 1.5 kV is the protection level category II equipment needs. The backup overcurrent
 * device is only required where the incomer is larger than the arrester's own withstand,
 * taken here as 63 A after HD 60364-5-534 §534.4.1.
 */
export function spdFor(
  kind: SurgeProtection,
  supply: 'single-phase' | 'three-phase',
  mainBreakerAmps: number,
): SpdSpec | null {
  if (kind === 'none') return null
  return {
    kind,
    modules: supply === 'three-phase' ? 4 : 2,
    upKv: 1.5,
    inKa: 20,
    backupBreakerAmps: mainBreakerAmps > 63 ? 63 : null,
  }
}

/** The marking on its front: `T2` for a Type 2 arrester. */
export const spdMarking = (kind: SurgeProtection): string =>
  kind === 'type-1' ? 'T1' : kind === 'type-1+2' ? 'T1+2' : 'T2'

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

/** The band a horizontal run should sit in, and the height in the middle of it. */
export function horizontalZone(roomHeight: number, route: 'ceiling' | 'floor'): InstallZone {
  const zones = horizontalZones(roomHeight)
  return route === 'floor' ? zones[0] : zones[zones.length - 1]
}

export const zoneMidpoint = (zone: InstallZone): number => (zone.from + zone.to) / 2

/**
 * Permitted vertical zones, as a distance band measured from a corner or a door reveal.
 * A vertical run that is not simply dropping to the outlet it serves must sit inside one.
 */
export const VERTICAL_ZONE = { from: 100, to: 300 } as const

/** Where in that band a vertical run is actually set out — the middle of it. */
export const VERTICAL_ZONE_OFFSET = (VERTICAL_ZONE.from + VERTICAL_ZONE.to) / 2

/** True when a height above the floor falls inside a permitted horizontal band. */
export function inHorizontalZone(z: number, roomHeight: number): boolean {
  return horizontalZones(roomHeight).some((zone) => z >= zone.from && z <= zone.to)
}

/**
 * Bathroom protective zones, HD 60364-7-701:2007.
 *
 * Zone 0 is the inside of the bath or the shower basin; zone 1 reaches out to a vertical
 * surface **1200 mm** from the fixed water outlet for a shower without a basin, up to 2250 mm
 * above the floor, and zone 2 extends a further 600 mm beyond it. Nothing but the fixed
 * appliance's own supply belongs in 0 or 1, so the router treats them as no-go volumes.
 *
 * The 600 mm often quoted is the 1984 edition's figure, measured from the *edge of the bath*
 * rather than from the outlet, and was superseded — using it puts an accessory a metre from a
 * shower head inside what the drawing calls a safe zone.
 */
export const BATHROOM_ZONE_1_RADIUS = 1200
export const BATHROOM_ZONE_2_EXTENT = 600
export const BATHROOM_ZONE_1_HEIGHT = 2250
