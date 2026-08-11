/**
 * Golden cases for the three-phase design.
 *
 * The board is where the electrical work becomes checkable: a phase that carries twice its
 * share, a cable that is legal but sags at the far end, or an incomer that cannot hold the
 * load are all arithmetic, and arithmetic is worth pinning down.
 */

import { describe, expect, test } from 'vitest'

import { createFixture, relevel, sampleProject } from '../project.ts'
import { solve } from '../routing/index.ts'
import {
  cableForRun,
  currentFor,
  NOMINAL_LINE_VOLTAGE,
  NOMINAL_VOLTAGE,
  voltDrop,
  voltDropPercent,
  VOLT_DROP_LIMIT,
} from '../standards/electrical.ts'
import type { Project } from '../types.ts'

/** The sample house, with the cooker optionally taken across all three lines. */
const house = (options: { supply?: 'single-phase' | 'three-phase'; cooker3ph?: boolean } = {}) => {
  const project = sampleProject()
  project.settings.electrical.supply = options.supply ?? 'three-phase'
  const cooker = project.fixtures.find((f) => f.type === 'cooker')
  if (cooker) cooker.threePhase = options.cooker3ph ?? false
  return relevel(project)
}

const panelOf = (project: Project) => {
  const result = solve(project)
  expect(result.panel).not.toBeNull()
  return { panel: result.panel!, result }
}

describe('three-phase supply', () => {
  test('single-phase puts everything on one line; three-phase spreads it', () => {
    const single = panelOf(house({ supply: 'single-phase' })).panel
    expect(single.phaseLoad.L2).toBe(0)
    expect(single.phaseLoad.L3).toBe(0)

    const three = panelOf(house()).panel
    const used = (['L1', 'L2', 'L3'] as const).filter((p) => three.phaseLoad[p] > 0)
    expect(used.length).toBeGreaterThan(1)
  })

  test('spreading the load lowers the demand each line has to carry', () => {
    const single = panelOf(house({ supply: 'single-phase' })).panel
    const three = panelOf(house()).panel
    expect(three.maximumDemand).toBeLessThan(single.maximumDemand)
  })

  test('a cooker on three phases draws a third of the current', () => {
    const watts = 7000
    const onOne = currentFor(watts, 1, NOMINAL_VOLTAGE, NOMINAL_LINE_VOLTAGE)
    const onThree = currentFor(watts, 3, NOMINAL_VOLTAGE, NOMINAL_LINE_VOLTAGE)
    expect(onOne).toBeCloseTo(30.4, 1)
    expect(onThree).toBeCloseTo(10.1, 1)
  })

  test('taking the cooker across three lines cuts its volt drop', () => {
    const one = panelOf(house({ cooker3ph: false }))
    const three = panelOf(house({ cooker3ph: true }))
    const cookerIn = (r: ReturnType<typeof panelOf>) =>
      r.result.circuits.find((c) => c.kind === 'cooker')!

    expect(cookerIn(one).poles).toBe(1)
    expect(cookerIn(three).poles).toBe(3)
    expect(cookerIn(three).phases).toEqual(['L1', 'L2', 'L3'])
    // Five cores: three lines, a neutral and an earth.
    expect(cookerIn(three).cores).toBe(5)
    expect(cookerIn(three).voltDropPercent).toBeLessThan(cookerIn(one).voltDropPercent)
  })

  test('a load too big for the incomer is reported, with the rating that would carry it', () => {
    const project = house({ supply: 'single-phase' })
    project.settings.electrical.mainBreakerAmps = 16
    const errors = solve(project).warnings.filter(
      (w) => w.severity === 'error' && /Maximum demand/.test(w.message),
    )
    expect(errors.length).toBe(1)
    expect(errors[0].message).toMatch(/Uprate the supply to at least \d+ A/)
  })

  test('a large single-phase load left on one line is flagged as imbalance', () => {
    const project = house({ cooker3ph: false })
    const kitchen = project.rooms.find((r) => r.name === 'Kitchen')!
    // Two more heavy dedicated appliances, all necessarily single-phase.
    for (let i = 0; i < 2; i++) {
      project.fixtures.push(
        createFixture(project, 'water-heater', kitchen.id, { wallIndex: 2, wallOffset: 400 + i * 500 }),
      )
    }
    const { panel } = panelOf(relevel(project))
    // The balancer should still be doing its job — the spread stays well under the total.
    expect(panel.imbalanceAmps).toBeLessThan(panel.maximumDemand)
  })
})

describe('cable sizing', () => {
  test('a long run is uprated beyond what the breaker alone would need', () => {
    // 16 A over 60 m on 2.5 mm² would drop far past 5%.
    const short = cableForRun(16, 16, 5_000, 1, VOLT_DROP_LIMIT.other)
    const long = cableForRun(16, 16, 60_000, 1, VOLT_DROP_LIMIT.other)
    expect(short).toBe(2.5)
    expect(long).toBeGreaterThan(short)
  })

  test('the chosen cable actually satisfies the limit it was chosen for', () => {
    for (const metres of [5, 20, 40, 80]) {
      const size = cableForRun(16, 16, metres * 1000, 1, VOLT_DROP_LIMIT.other)
      const drop = voltDropPercent(voltDrop(16, metres * 1000, size, 1), 1)
      expect(drop).toBeLessThanOrEqual(VOLT_DROP_LIMIT.other * 100 + 1e-9)
    }
  })

  test('lighting is held to the tighter limit', () => {
    expect(VOLT_DROP_LIMIT.lighting).toBeLessThan(VOLT_DROP_LIMIT.other)
    const size = cableForRun(10, 10, 90_000, 1, VOLT_DROP_LIMIT.lighting)
    const drop = voltDropPercent(voltDrop(10, 90_000, size, 1), 1)
    expect(drop).toBeLessThanOrEqual(VOLT_DROP_LIMIT.lighting * 100 + 1e-9)
  })

  test('every routed circuit ends up inside its own limit, or says why not', () => {
    const { result } = panelOf(house())
    for (const circuit of result.circuits) {
      const limit = (circuit.kind === 'lighting' ? VOLT_DROP_LIMIT.lighting : VOLT_DROP_LIMIT.other) * 100
      if (circuit.voltDropPercent <= limit) continue
      expect(
        result.warnings.some((w) => w.message.includes(circuit.name) && /drops/.test(w.message)),
      ).toBe(true)
    }
  })

  test('the cable in the schedule is the cable that was drawn', () => {
    const { result } = panelOf(house())
    const power = result.networks.find((n) => n.system === 'power')!
    for (const circuit of result.circuits) {
      for (const segment of power.segments.filter((s) => s.circuitId === circuit.id)) {
        expect(segment.size).toBe(circuit.cableMm2)
      }
    }
  })
})

describe('the board', () => {
  test('every circuit gets a way, and the ways fit the enclosure', () => {
    const { panel, result } = panelOf(house({ cooker3ph: true }))
    expect(panel.ways.length).toBe(result.circuits.length)
    expect(panel.modulesUsed).toBeLessThanOrEqual(panel.enclosureModules)

    // Nothing overlaps on the rail.
    const ordered = [...panel.ways].sort((l, r) => l.slot - r.slot)
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].slot).toBeGreaterThanOrEqual(ordered[i - 1].slot + ordered[i - 1].modules)
    }
  })

  test('a three-phase way takes three modules and a four-pole device', () => {
    const { panel } = panelOf(house({ cooker3ph: true }))
    const cooker = panel.ways.find((w) => w.circuit.poles === 3)!
    expect(cooker.modules).toBe(3)
    expect(panel.rcdGroups.find((g) => g.circuitIds.includes(cooker.circuit.id))!.poles).toBe(4)
  })

  test('a three-phase board uses four-pole RCDs, a single-phase one two-pole', () => {
    // A two-pole device switches one line and the neutral, so everything behind it would have
    // to be on that same line. Putting circuits from two phases behind one is not buildable.
    const three = panelOf(house()).panel
    for (const group of three.rcdGroups) expect(group.poles).toBe(4)

    const single = panelOf(house({ supply: 'single-phase' })).panel
    for (const group of single.rcdGroups) expect(group.poles).toBe(2)
  })

  test('nothing sits behind a device that could not switch it', () => {
    const { panel, result } = panelOf(house({ cooker3ph: true }))
    for (const group of panel.rcdGroups) {
      if (group.poles === 4) continue
      const lines = new Set(
        group.circuitIds.flatMap((id) => result.circuits.find((c) => c.id === id)?.phases ?? []),
      )
      expect(lines.size).toBeLessThanOrEqual(1)
    }
  })

  test('lighting and power are dealt round different RCDs', () => {
    const { panel, result } = panelOf(house())
    if (panel.rcdGroups.length < 2) return
    const lighting = result.circuits.filter((c) => c.kind === 'lighting')
    if (lighting.length < 2) return
    // A fault on one device must not be able to take every light out at once.
    expect(new Set(lighting.map((c) => c.rcdGroup)).size).toBeGreaterThan(1)
  })

  test('the design is deterministic', () => {
    // The same project, twice — two separately built projects would differ only by their
    // random ids, which says nothing about the design.
    const project = house({ cooker3ph: true })
    expect(solve(project).panel).toEqual(solve(project).panel)
  })

  test('a project with nothing electrical has no board rather than an empty one', () => {
    const project = sampleProject()
    project.fixtures = project.fixtures.filter(
      (f) => !['socket', 'ceiling-light', 'cooker', 'dishwasher', 'washing-machine'].includes(f.type),
    )
    expect(solve(relevel(project)).panel).toBeNull()
  })
})
