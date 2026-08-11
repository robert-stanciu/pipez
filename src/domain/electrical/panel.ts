/**
 * The consumer unit.
 *
 * Once circuits exist, three questions remain that the routing does not answer: which line
 * each one hangs off, which residual current device protects it, and where it sits on the
 * rail. This module answers all three, and totals the result into a maximum demand that can
 * be checked against the incomer.
 */

import {
  cableSizeForBreaker,
  circuitCountFactor,
  CIRCUIT_RULES,
  mainBondingSize,
  methodOf,
  modulesPerRowOf,
  peSize,
  PHASES,
  breakerFor,
  earthingOf,
  spdFor,
  surgeProtectionOf,
} from '../standards/electrical.ts'
import type {
  Circuit,
  ElectricalSettings,
  Id,
  PanelDesign,
  PanelWay,
  Phase,
  RcdGroup,
  RcdType,
} from '../types.ts'

/**
 * Standard enclosure sizes, in 17.5 mm DIN modules, as whole rows.
 *
 * A board is sold by the row, so every size here is a whole number of them — including the
 * 60-module five-row box, which is very much made and which the ladder used to skip straight
 * over on its way from 48 to 72.
 */
const ENCLOSURE_SIZES_12 = [12, 24, 36, 48, 60, 72]
const ENCLOSURE_SIZES_18 = [18, 36, 54, 72]

const enclosureSizes = (perRow: number): number[] =>
  perRow === 18 ? ENCLOSURE_SIZES_18 : ENCLOSURE_SIZES_12

/**
 * Spread between the busiest and quietest line before it is worth mentioning, in amps.
 *
 * An absolute figure, not a percentage: on a small installation two circuits of a few amps
 * each can sit 100% apart and mean nothing, while the same percentage across a heavy supply
 * is tens of amps down the neutral.
 */
export const IMBALANCE_THRESHOLD = 10

/** Residual current devices for socket and wet-area circuits: 30 mA, additional protection. */
const RCD_SENSITIVITY = 30

/**
 * Spread the single-phase circuits across the lines.
 *
 * Longest-processing-time first: take the heaviest circuit still unplaced and give it to the
 * quietest line. It is a greedy heuristic rather than an optimum, but for the couple of dozen
 * circuits a building has it lands within a few percent of balanced, and being balanced is
 * what keeps current out of the neutral and the line voltages even.
 *
 * Three-phase circuits are not assigned — they sit across all three by definition, and
 * contribute a third of their load to each.
 */
export function balancePhases(circuits: Circuit[], supply: ElectricalSettings['supply']): void {
  const load: Record<Phase, number> = { L1: 0, L2: 0, L3: 0 }

  if (supply === 'single-phase') {
    for (const circuit of circuits) {
      circuit.poles = 1
      circuit.phases = ['L1']
    }
    return
  }

  for (const circuit of circuits) {
    if (circuit.poles !== 3) continue
    circuit.phases = [...PHASES]
    for (const phase of PHASES) load[phase] += circuit.diversifiedCurrent
  }

  const singles = circuits
    .filter((circuit) => circuit.poles === 1)
    // Ties broken by name so the same project always produces the same board.
    .sort((l, r) => r.diversifiedCurrent - l.diversifiedCurrent || l.name.localeCompare(r.name))

  for (const circuit of singles) {
    const quietest = PHASES.reduce((best, phase) => (load[phase] < load[best] ? phase : best), 'L1' as Phase)
    circuit.phases = [quietest]
    load[quietest] += circuit.diversifiedCurrent
  }
}

/**
 * Put circuits behind residual current devices.
 *
 * Everything that needs one is grouped, but never all on a single device: a fault on one
 * socket should not take the lights out with it, so lighting and power are dealt round
 * alternate devices rather than filling one before starting the next.
 *
 * `electronicLoads` names the circuits with a variable-speed appliance on them. Since the
 * 2018 amendment to HD 60364-5-53 a Type AC device — one that can only see a sinusoidal
 * residual current — is no longer acceptable anywhere, and an inverter-driven motor produces
 * a composite residual waveform that even a Type A can miss. Type A is therefore the floor
 * and Type F is what a group with an inverter drive behind it gets.
 */
export function groupRcds(
  circuits: Circuit[],
  perDevice: number,
  supply: ElectricalSettings['supply'],
  electronicLoads: ReadonlySet<Id> = new Set(),
): RcdGroup[] {
  const protectedCircuits = circuits.filter((circuit) => circuit.rcdProtected)
  if (protectedCircuits.length === 0) return []

  /**
   * On a three-phase board the devices are four-pole.
   *
   * A two-pole device switches one line and the neutral, so everything behind it has to be on
   * that same line — which would tie the residual current grouping to the phase balancing and
   * let one constrain the other. Four-pole devices are what a three-phase board is built from
   * for exactly this reason: any circuit can sit behind any device.
   */
  const poles: 2 | 4 = supply === 'three-phase' ? 4 : 2

  const deviceCount = Math.max(1, Math.ceil(protectedCircuits.length / Math.max(1, perDevice)))
  const groups: RcdGroup[] = Array.from({ length: deviceCount }, (_, index) => ({
    index,
    sensitivity: RCD_SENSITIVITY,
    type: 'A' as RcdType,
    poles,
    circuitIds: [],
    modules: poles,
  }))

  // Lighting first, then the rest, dealt round — so consecutive circuits of the same kind
  // land on different devices.
  const dealt = [
    ...protectedCircuits.filter((c) => c.kind === 'lighting'),
    ...protectedCircuits.filter((c) => c.kind !== 'lighting'),
  ]
  dealt.forEach((circuit, index) => {
    const group = groups[index % deviceCount]
    group.circuitIds.push(circuit.id)
    circuit.rcdGroup = group.index
    if (electronicLoads.has(circuit.id)) group.type = 'F'
  })

  return groups
}

/** Modules a protective device occupies: one per pole, near enough for a domestic board. */
const modulesFor = (circuit: Circuit): number => (circuit.poles === 3 ? 3 : 1)

/**
 * Lay the board out left to right: main switch, the surge arrester behind it, then each
 * residual current device followed by the circuits it protects. That is the order a board is
 * actually wired in, and the order the schedule has to be read in to make sense.
 *
 * The rail is packed **by rows**, because a rail is a physical object: no fitter has ever
 * clipped a three-pole breaker half onto one rail and half onto the next, so a device that
 * would straddle a row boundary starts the next row and the modules it skipped are blanked
 * off. Counting the board as one flat run instead lets a 12-module enclosure appear to hold
 * a device that begins at module 10 and needs three.
 */
export function layOutPanel(
  circuits: Circuit[],
  rcdGroups: RcdGroup[],
  settings: ElectricalSettings,
  isMain = true,
): Omit<PanelDesign, 'id' | 'name' | 'levelId' | 'isMain' | 'submainMm2' | 'submainLength'> {
  const perRow = modulesPerRowOf(settings)
  const mainSwitchModules = settings.supply === 'three-phase' ? 4 : 2
  const ways: PanelWay[] = []
  let slot = 0

  /** Take `modules` of rail, starting a fresh row rather than straddling one. */
  const take = (modules: number): number => {
    if (slot % perRow !== 0 && (slot % perRow) + modules > perRow) {
      slot += perRow - (slot % perRow)
    }
    const at = slot
    slot += modules
    return at
  }

  take(mainSwitchModules)

  /**
   * The arrester sits between the main switch and the residual current devices: it discharges
   * a surge to earth, and behind a 30 mA device that discharge is a residual current, so the
   * house would trip out every time it did its job.
   */
  const spd = isMain
    ? spdFor(surgeProtectionOf(settings), settings.supply, settings.mainBreakerAmps)
    : null
  if (spd) {
    take(spd.modules)
    if (spd.backupBreakerAmps !== null) take(mainSwitchModules)
  }

  const place = (circuit: Circuit) => {
    const modules = modulesFor(circuit)
    ways.push({ slot: take(modules), modules, circuit })
  }

  for (const group of rcdGroups) {
    take(group.modules)
    for (const id of group.circuitIds) {
      const circuit = circuits.find((c) => c.id === id)
      if (circuit) place(circuit)
    }
  }
  // Anything not behind a device — there should be none in a modern board, but a project can
  // be edited into that state and the board still has to show it.
  for (const circuit of circuits) {
    if (!circuit.rcdProtected) place(circuit)
  }

  const modulesUsed = slot
  const sizes = enclosureSizes(perRow)
  const enclosureModules =
    sizes.find((size) => size >= modulesUsed) ?? Math.ceil(modulesUsed / perRow) * perRow

  const phaseLoad: Record<Phase, number> = { L1: 0, L2: 0, L3: 0 }
  for (const circuit of circuits) {
    const share = circuit.diversifiedCurrent / circuit.phases.length
    for (const phase of circuit.phases) phaseLoad[phase] += share
  }

  const lines = settings.supply === 'three-phase' ? PHASES : (['L1'] as Phase[])
  const loads = lines.map((phase) => phaseLoad[phase])
  const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length
  const imbalanceAmps = Math.max(...loads) - Math.min(...loads)
  const imbalancePercent = mean > 0 ? (imbalanceAmps / mean) * 100 : 0

  // The more final circuits a board carries, the smaller the fraction of them that is ever
  // drawing at once. This is the diversity that actually matters on a domestic board, and it
  // belongs here rather than smeared across the individual appliance allowances.
  const ks = circuitCountFactor(circuits.length)

  // Main protective bonding is done once, at the origin: a sub-board has a protective
  // conductor back to the main earthing terminal and nothing of its own to bond.
  const supplyPe = peSize(cableSizeForBreaker(settings.mainBreakerAmps, methodOf(settings)))

  return {
    supply: settings.supply,
    mainBreakerAmps: settings.mainBreakerAmps,
    mainSwitchModules,
    spd,
    earthing: earthingOf(settings),
    mainBondingMm2: isMain ? mainBondingSize(supplyPe) : 0,
    rcdGroups,
    ways,
    modulesUsed,
    enclosureModules,
    rows: Math.max(1, Math.ceil(enclosureModules / perRow)),
    modulesPerRow: perRow,
    phaseLoad,
    imbalancePercent,
    imbalanceAmps,
    ks,
    maximumDemand: Math.max(...loads, 0) * ks,
  }
}

/** Diversity allowance for a circuit's connected load, as a current per line. */
export function diversifiedCurrentFor(circuit: Circuit): number {
  return circuit.designCurrent * CIRCUIT_RULES[circuit.kind].diversity
}

/**
 * What one board asks of its supply, before it has been laid out.
 *
 * The submain has to be sized before the final circuits can be assessed — a circuit's volt
 * drop is measured from the origin of the installation, so the drop along the submain is part
 * of every circuit's figure — and that means this sum has to be available earlier than the
 * full layout.
 */
export function boardDemand(circuits: Circuit[], supply: ElectricalSettings['supply']): number {
  const phaseLoad: Record<Phase, number> = { L1: 0, L2: 0, L3: 0 }
  for (const circuit of circuits) {
    const share = circuit.diversifiedCurrent / Math.max(1, circuit.phases.length)
    for (const phase of circuit.phases) phaseLoad[phase] += share
  }
  const lines = supply === 'three-phase' ? PHASES : (['L1'] as Phase[])
  return Math.max(...lines.map((phase) => phaseLoad[phase]), 0) * circuitCountFactor(circuits.length)
}

/** The incomer a given maximum demand actually needs. */
export const recommendedMainBreaker = (maximumDemand: number): number =>
  breakerFor(maximumDemand)
