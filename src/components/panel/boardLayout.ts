/**
 * Turning a `PanelDesign` into something that can be drawn as an enclosure.
 *
 * The domain lays a board out as one flat run of modules, which is what a schedule wants: way
 * one, way two, and so on down the rail. A picture of the board wants rows of twelve, and no
 * fitter has ever clipped a three-pole breaker half onto one rail and half onto the next — so
 * a device that would straddle a row boundary starts the next row instead, and the gap it
 * leaves is blanked off the way it would be blanked in the flesh.
 *
 * The order is still the domain's, because that is the order the board is wired in: main
 * switch, then each residual current device followed by everything behind it.
 */

import { spdMarking, VOLT_DROP_LIMIT } from '../../domain/standards/electrical.ts'
import type { PanelDesign, Phase, RcdGroup } from '../../domain/types.ts'

/** DIN module pitch, and the rail length a standard enclosure row is built to. */
export const MODULE_MM = 17.5

/**
 * Rails come in twelve and in eighteen. The design says which, and everything drawn here
 * follows it; the constant is only the fallback for a board that predates the setting.
 */
export const MODULES_PER_ROW = 12

export type DeviceKind = 'main' | 'spd' | 'rcd' | 'mcb' | 'blank'

/** A pole is on a line or on the neutral; both get a terminal and a colour. */
export type PoleLine = Phase | 'N'

export interface BoardDevice {
  key: string
  kind: DeviceKind
  row: number
  /** Modules from the left-hand end of the rail. */
  column: number
  modules: number
  poles: number
  /** One entry per pole, left to right, which is how the terminals are coloured. */
  poleLines: PoleLine[]
  /** The large marking on the front: `C16` on a breaker, `40A` on an RCCB. */
  marking: string
  /** The smaller second marking: the trip current, or the pole count where it matters. */
  note: string
  /** Circuit name, for the label window and the tooltip. */
  label: string
  circuitId: string | null
  /** Way number, matching the schedule. */
  way: number | null
  rcdIndex: number | null
  overDrop: boolean
  title: string
}

/**
 * The comb busbar bridging a residual current device to the breakers behind it.
 *
 * Split per row: a group that runs off the end of one rail is combed again on the next, which
 * is what actually happens on a two-row board.
 */
export interface CombBusbar {
  key: string
  row: number
  /** Left and right ends of the bar, in modules from the left of the rail. */
  fromColumn: number
  toColumn: number
  /** Lines the device hands to the bar; a four-pole RCCB feeds a three-phase comb. */
  phases: Phase[]
  /** The device the bar is fed from, when it sits on this row. */
  sourceColumn: number | null
  sourceModules: number
  pins: { column: number; modules: number; phases: Phase[] }[]
}

export interface BoardLayout {
  devices: BoardDevice[]
  combs: CombBusbar[]
  rows: number
}

/**
 * Ratings an RCCB is actually made in. The device is not a breaker — it does not protect
 * against overload — so its rating only has to cover the current that can pass through it.
 */
const RCD_RATINGS = [25, 40, 63, 80, 100]

const isPhase = (line: PoleLine): line is Phase => line !== 'N'

/**
 * What one residual current device has to be rated for.
 *
 * Two figures compete and the larger wins: the worst line's diversified load, and the biggest
 * breaker behind it. The second is what stops a 25 A device being drawn in front of a 32 A
 * cooker circuit — the RCCB has no overload protection of its own, so nothing downstream may
 * be allowed to pass more than it can carry.
 */
function groupDuty(design: PanelDesign, group: RcdGroup): number {
  const load: Record<Phase, number> = { L1: 0, L2: 0, L3: 0 }
  let largestBreaker = 0
  for (const id of group.circuitIds) {
    const way = design.ways.find((candidate) => candidate.circuit.id === id)
    if (!way) continue
    const circuit = way.circuit
    const share = circuit.diversifiedCurrent / Math.max(1, circuit.phases.length)
    for (const phase of circuit.phases) load[phase] += share
    largestBreaker = Math.max(largestBreaker, circuit.breakerAmps)
  }
  return Math.max(load.L1, load.L2, load.L3, largestBreaker)
}

export function layOutBoard(design: PanelDesign): BoardLayout {
  const lines: Phase[] = design.supply === 'three-phase' ? ['L1', 'L2', 'L3'] : ['L1']
  const perRow = design.modulesPerRow || MODULES_PER_ROW
  const wayNumber = new Map(design.ways.map((way, index) => [way.circuit.id, index + 1]))

  type Pending = Omit<BoardDevice, 'row' | 'column'>
  const pending: Pending[] = []

  pending.push({
    key: 'main',
    kind: 'main',
    modules: design.mainSwitchModules,
    poles: design.mainSwitchModules,
    poleLines: [...lines, 'N'],
    marking: `${design.mainBreakerAmps}A`,
    note: `${design.mainSwitchModules}P`,
    label: design.isMain ? 'Main switch' : 'Submain isolator',
    circuitId: null,
    way: null,
    rcdIndex: null,
    overDrop: false,
    title: `${design.isMain ? 'Main switch' : 'Submain isolator'} — ${design.mainBreakerAmps} A, ${design.mainSwitchModules}-pole`,
  })

  /**
   * The surge arrester, immediately behind the main switch and in front of everything else.
   *
   * It has to be on the supply side of the residual current devices: discharging a surge to
   * earth is a residual current, and behind an RCCB the house would trip out every time the
   * arrester did its job.
   */
  if (design.spd) {
    const spd = design.spd
    pending.push({
      key: 'spd',
      kind: 'spd',
      modules: spd.modules,
      poles: spd.modules,
      poleLines: [...lines, 'N'],
      marking: spdMarking(spd.kind),
      note: `${spd.inKa}kA`,
      label: 'Surge arrester',
      circuitId: null,
      way: null,
      rcdIndex: null,
      overDrop: false,
      title: [
        `Surge protective device — ${spdMarking(spd.kind)}, In ${spd.inKa} kA (8/20 µs), Up ≤ ${spd.upKv} kV`,
        spd.backupBreakerAmps === null
          ? 'Backed up by the main switch'
          : `Backup device ${spd.backupBreakerAmps} A`,
      ].join('\n'),
    })
    if (spd.backupBreakerAmps !== null) {
      pending.push({
        key: 'spd-backup',
        kind: 'mcb',
        modules: design.mainSwitchModules,
        poles: design.mainSwitchModules,
        poleLines: [...lines, 'N'],
        marking: `C${spd.backupBreakerAmps}`,
        note: `${design.mainSwitchModules}P`,
        label: 'Arrester backup',
        circuitId: null,
        way: null,
        rcdIndex: null,
        overDrop: false,
        title: `Backup overcurrent device for the surge arrester — ${spd.backupBreakerAmps} A`,
      })
    }
  }

  const breaker = (circuitId: string, modules: number, rcdIndex: number | null): Pending | null => {
    const way = design.ways.find((candidate) => candidate.circuit.id === circuitId)
    if (!way) return null
    const circuit = way.circuit
    const limit =
      (circuit.kind === 'lighting' ? VOLT_DROP_LIMIT.lighting : VOLT_DROP_LIMIT.other) * 100
    const number = wayNumber.get(circuit.id) ?? null
    return {
      key: circuit.id,
      kind: 'mcb',
      modules,
      poles: circuit.poles,
      poleLines: [...circuit.phases],
      marking: `${circuit.curve}${circuit.breakerAmps}`,
      note: circuit.poles === 3 ? '3P' : '',
      label: circuit.name,
      circuitId: circuit.id,
      way: number,
      rcdIndex,
      overDrop: circuit.voltDropPercent > limit,
      title: [
        `Way ${number ?? '—'} · ${circuit.name}`,
        `${circuit.curve}${circuit.breakerAmps} A ${circuit.poles === 3 ? '3-pole' : '1-pole'} on ${circuit.phases.join('/')}, ${(circuit.icn / 1000).toFixed(0)} kA`,
        `${circuit.cores} × ${circuit.cableMm2} mm² + ${circuit.peMm2} mm² PE · method ${circuit.installationMethod}` +
          (circuit.groupedWith > 1
            ? `, ${circuit.groupedWith} circuits grouped (Cg ${circuit.groupingFactor.toFixed(2)}) → ${circuit.currentCapacity.toFixed(1)} A`
            : ` → ${circuit.currentCapacity.toFixed(1)} A`),
        `${(circuit.routeLength / 1000).toFixed(1)} m · ${circuit.voltDropPercent.toFixed(2)}% drop from the origin`,
      ].join('\n'),
    }
  }

  for (const group of design.rcdGroups) {
    const rating = RCD_RATINGS.find((amps) => amps >= groupDuty(design, group)) ?? 100
    pending.push({
      key: `rcd-${group.index}`,
      kind: 'rcd',
      modules: group.modules,
      poles: group.poles,
      poleLines: group.poles === 4 ? ['L1', 'L2', 'L3', 'N'] : [lines[0], 'N'],
      marking: `${rating}A`,
      // The type is as much of the specification as the trip current: a device that cannot
      // see the residual current its circuits produce is not protecting them.
      note: `${group.type} ${group.sensitivity}mA`,
      label: `RCD ${group.index + 1}`,
      circuitId: null,
      way: null,
      rcdIndex: group.index,
      overDrop: false,
      title: `RCCB ${group.index + 1} — ${rating} A ${group.poles}-pole, Type ${group.type}, ${group.sensitivity} mA, protecting ${group.circuitIds.length} circuits`,
    })
    for (const id of group.circuitIds) {
      const way = design.ways.find((candidate) => candidate.circuit.id === id)
      const device = way ? breaker(id, way.modules, group.index) : null
      if (device) pending.push(device)
    }
  }

  // Anything with no residual current device in front of it still has to appear on the rail.
  for (const way of design.ways) {
    if (way.circuit.rcdProtected) continue
    const device = breaker(way.circuit.id, way.modules, null)
    if (device) pending.push(device)
  }

  const devices: BoardDevice[] = []
  let row = 0
  let column = 0
  for (const item of pending) {
    if (column + item.modules > perRow) {
      row += 1
      column = 0
    }
    devices.push({ ...item, row, column })
    column += item.modules
  }

  // The enclosure is at least as big as the domain sized it, and at least big enough to hold
  // what the row packing produced.
  const rows = Math.max(1, design.rows, row + 1)

  const occupied = new Set<string>()
  for (const device of devices) {
    for (let offset = 0; offset < device.modules; offset += 1) {
      occupied.add(`${device.row}:${device.column + offset}`)
    }
  }
  for (let index = 0; index < rows; index += 1) {
    for (let slot = 0; slot < perRow; slot += 1) {
      if (occupied.has(`${index}:${slot}`)) continue
      devices.push({
        key: `blank-${index}-${slot}`,
        kind: 'blank',
        row: index,
        column: slot,
        modules: 1,
        poles: 0,
        poleLines: [],
        marking: '',
        note: '',
        label: '',
        circuitId: null,
        way: null,
        rcdIndex: null,
        overDrop: false,
        title: 'Blanking plate',
      })
    }
  }

  const combs: CombBusbar[] = []
  for (const group of design.rcdGroups) {
    const source = devices.find(
      (device) => device.kind === 'rcd' && device.rcdIndex === group.index,
    )
    const fed = devices.filter(
      (device) => device.kind === 'mcb' && device.rcdIndex === group.index,
    )
    for (let index = 0; index < rows; index += 1) {
      const onRow = fed
        .filter((device) => device.row === index)
        .sort((left, right) => left.column - right.column)
      if (onRow.length === 0) continue
      const first = onRow[0]
      const last = onRow[onRow.length - 1]
      const feedsThisRow = source !== undefined && source.row === index
      combs.push({
        key: `comb-${group.index}-${index}`,
        row: index,
        fromColumn: feedsThisRow && source ? source.column + source.modules : first.column,
        toColumn: last.column + last.modules,
        phases: group.poles === 4 ? lines : lines.slice(0, 1),
        sourceColumn: feedsThisRow && source ? source.column : null,
        sourceModules: source?.modules ?? 0,
        pins: onRow.map((device) => ({
          column: device.column,
          modules: device.modules,
          phases: device.poleLines.filter(isPhase),
        })),
      })
    }
  }

  return { devices, combs, rows }
}
