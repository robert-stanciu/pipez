/**
 * The consumer unit.
 *
 * Once circuits exist, three questions remain that the routing does not answer: which line
 * each one hangs off, which residual current device protects it, and where it sits on the
 * rail. This module answers all three, and totals the result into a maximum demand that can
 * be checked against the incomer.
 */

import {
  CIRCUIT_RULES,
  PHASES,
  breakerFor,
} from '../standards/electrical.ts'
import type {
  Circuit,
  ElectricalSettings,
  PanelDesign,
  PanelWay,
  Phase,
  RcdGroup,
} from '../types.ts'

/** Standard enclosure sizes, in 17.5 mm DIN modules, as whole rows of twelve. */
const ENCLOSURE_SIZES = [12, 24, 36, 48, 72]
const MODULES_PER_ROW = 12

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
 */
export function groupRcds(
  circuits: Circuit[],
  perDevice: number,
  supply: ElectricalSettings['supply'],
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
  })

  return groups
}

/** Modules a protective device occupies: one per pole, near enough for a domestic board. */
const modulesFor = (circuit: Circuit): number => (circuit.poles === 3 ? 3 : 1)

/**
 * Lay the board out left to right: main switch, then each residual current device followed by
 * the circuits behind it. That is the order a board is actually wired in, and the order the
 * schedule has to be read in to make sense.
 */
export function layOutPanel(
  circuits: Circuit[],
  rcdGroups: RcdGroup[],
  settings: ElectricalSettings,
): PanelDesign {
  const mainSwitchModules = settings.supply === 'three-phase' ? 4 : 2
  let slot = mainSwitchModules
  const ways: PanelWay[] = []

  const place = (circuit: Circuit) => {
    const modules = modulesFor(circuit)
    ways.push({ slot, modules, circuit })
    slot += modules
  }

  for (const group of rcdGroups) {
    slot += group.modules
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
  const enclosureModules =
    ENCLOSURE_SIZES.find((size) => size >= modulesUsed) ??
    Math.ceil(modulesUsed / MODULES_PER_ROW) * MODULES_PER_ROW

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

  return {
    supply: settings.supply,
    mainBreakerAmps: settings.mainBreakerAmps,
    mainSwitchModules,
    rcdGroups,
    ways,
    modulesUsed,
    enclosureModules,
    rows: Math.max(1, Math.ceil(enclosureModules / MODULES_PER_ROW)),
    phaseLoad,
    imbalancePercent,
    imbalanceAmps,
    maximumDemand: Math.max(...loads, 0),
  }
}

/** Diversity allowance for a circuit's connected load, as a current per line. */
export function diversifiedCurrentFor(circuit: Circuit): number {
  return circuit.designCurrent * CIRCUIT_RULES[circuit.kind].diversity
}

/** The incomer a given maximum demand actually needs. */
export const recommendedMainBreaker = (maximumDemand: number): number =>
  breakerFor(maximumDemand)
