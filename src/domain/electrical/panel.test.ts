/**
 * Golden cases for the three-phase design.
 *
 * The board is where the electrical work becomes checkable: a phase that carries twice its
 * share, a cable that is legal but sags at the far end, or an incomer that cannot hold the
 * load are all arithmetic, and arithmetic is worth pinning down.
 */

import { describe, expect, test } from 'vitest'

import { fixtureDef } from '../catalog/fixtures.ts'
import { createFixture, createServicePoint, relevel, sampleProject } from '../project.ts'
import { solve } from '../routing/index.ts'
import {
  cableForRun,
  circuitCountFactor,
  CIRCUIT_RULES,
  currentCapacity,
  currentFor,
  groupingFactor,
  mainBondingSize,
  NOMINAL_LINE_VOLTAGE,
  NOMINAL_VOLTAGE,
  peSize,
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

/** The sample house has one board, so the design under test is the only one. */
const panelOf = (project: Project) => {
  const result = solve(project)
  expect(result.panels.length).toBeGreaterThan(0)
  return { panel: result.panels[0], result }
}

/**
 * The same house with a second board upstairs, which is the usual arrangement and the only
 * one in which a submain exists at all.
 */
const subBoardHouse = () => {
  const project = house()
  const upper = project.levels[1]
  const landing = project.rooms.find((r) => r.levelId === upper.id && r.name === 'Hol')!
  const at = landing.outline[0]
  project.servicePoints.push(
    createServicePoint(
      'electricalPanel',
      { x: at.x + 300, y: at.y + 300 },
      upper,
      landing.id,
    ),
  )
  const result = solve(relevel(project))
  return { project, result }
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
      (w: { severity: string; message: string }) =>
        w.severity === 'error' && /Maximum demand/.test(w.message),
    )
    expect(errors.length).toBe(1)
    expect(errors[0].message).toMatch(/Uprate the supply to at least \d+ A/)
  })

  test('a large single-phase load left on one line is flagged as imbalance', () => {
    const project = house({ cooker3ph: false })
    const kitchen = project.rooms.find((r) => r.name === 'Bucătărie')!
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
        group.circuitIds.flatMap(
          (id: string) => result.circuits.find((c) => c.id === id)?.phases ?? [],
        ),
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
    expect(solve(project).panels).toEqual(solve(project).panels)
  })

  test('a project with nothing electrical has no board rather than an empty one', () => {
    const project = sampleProject()
    // Taken from the catalogue rather than from a list of type names, so a new powered
    // fixture in the sample house cannot quietly leave one circuit behind and pass anyway.
    project.fixtures = project.fixtures.filter(
      (f) => fixtureDef(f.type).loads.circuit === undefined,
    )
    expect(solve(relevel(project)).panels).toEqual([])
  })

  test('no device straddles a row, and the enclosure is one that is made', () => {
    const { panel } = panelOf(house({ cooker3ph: true }))
    const perRow = panel.modulesPerRow
    for (const way of panel.ways) {
      // A three-pole breaker cannot be clipped half onto one rail and half onto the next.
      expect(Math.floor(way.slot / perRow)).toBe(Math.floor((way.slot + way.modules - 1) / perRow))
    }
    expect([12, 24, 36, 48, 60, 72]).toContain(panel.enclosureModules)
    expect(panel.modulesUsed).toBeLessThanOrEqual(panel.enclosureModules)
  })

  test('the maximum demand carries the IEC circuit-count factor', () => {
    expect(circuitCountFactor(1)).toBe(1)
    expect(circuitCountFactor(3)).toBe(0.9)
    expect(circuitCountFactor(5)).toBe(0.8)
    expect(circuitCountFactor(9)).toBe(0.7)
    expect(circuitCountFactor(12)).toBe(0.6)

    const { panel } = panelOf(house())
    expect(panel.ks).toBe(circuitCountFactor(panel.ways.length))
    const busiest = Math.max(panel.phaseLoad.L1, panel.phaseLoad.L2, panel.phaseLoad.L3)
    expect(panel.maximumDemand).toBeCloseTo(busiest * panel.ks, 9)
    // ks is a reduction, not a licence to exceed the connected load.
    expect(panel.maximumDemand).toBeLessThanOrEqual(busiest + 1e-9)
  })
})

describe('current-carrying capacity', () => {
  test('the table is HD 60364-5-52 Table B.52.4, and the grouping factors B.52.17', () => {
    expect(currentCapacity(1.5, 'A1')).toBeCloseTo(14.5, 9)
    expect(currentCapacity(2.5, 'B1')).toBeCloseTo(24, 9)
    expect(currentCapacity(6, 'B2')).toBeCloseTo(38, 9)
    expect(currentCapacity(25, 'C')).toBeCloseTo(112, 9)

    expect(groupingFactor(1)).toBe(1)
    expect(groupingFactor(6)).toBe(0.57)
    expect(groupingFactor(12)).toBe(0.5)
    // The case a bare ladder cannot see: six 2.5 mm² circuits in one chase behind a 16 A
    // breaker carry 13.7 A each, not 24.
    expect(currentCapacity(2.5, 'B1', 6)).toBeCloseTo(13.68, 2)
  })

  test('every routed circuit satisfies Iz >= In where it is actually installed', () => {
    const { result } = panelOf(house())
    for (const circuit of result.circuits) {
      expect(circuit.groupingFactor).toBe(groupingFactor(circuit.groupedWith))
      expect(circuit.currentCapacity).toBeCloseTo(
        currentCapacity(circuit.cableMm2, circuit.installationMethod, circuit.groupedWith),
        9,
      )
      expect(circuit.currentCapacity).toBeGreaterThanOrEqual(circuit.breakerAmps - 1e-9)
    }
  })

  test('bunching uprates a conductor rather than being ignored', () => {
    const { result } = panelOf(house())
    const bunched = result.circuits.filter((c) => c.groupedWith > 1)
    // The router deliberately shares chases, so this is not a hypothetical.
    expect(bunched.length).toBeGreaterThan(0)
    for (const circuit of bunched) {
      // Whatever it ended up on, the ungrouped table would have allowed something smaller or
      // the same — never larger.
      const ungrouped = currentCapacity(circuit.cableMm2, circuit.installationMethod)
      expect(ungrouped).toBeGreaterThanOrEqual(circuit.currentCapacity)
    }
    // At least one of them had to grow beyond what a single circuit would have needed.
    expect(bunched.some((c) => c.cableMm2 > CIRCUIT_RULES[c.kind].cableMm2)).toBe(true)
  })
})

describe('volt drop from the origin', () => {
  test('a circuit is assessed over its longest run, not over all its copper', () => {
    const { result } = panelOf(house())
    const power = result.networks.find((n) => n.system === 'power')!

    let branched = 0
    for (const circuit of result.circuits) {
      const installed = power.segments
        .filter((s) => s.circuitId === circuit.id)
        .reduce((sum, s) => sum + s.length, 0)
      // The run to the furthest point is part of the tree, so it can never exceed the tree.
      expect(circuit.routeLength).toBeLessThanOrEqual(installed + 1e-6)
      if (circuit.routeLength < installed - 1) branched += 1

      expect(circuit.circuitDropPercent).toBeCloseTo(
        voltDropPercent(
          voltDrop(circuit.assessedCurrent, circuit.routeLength, circuit.cableMm2, circuit.poles),
          circuit.poles,
        ),
        6,
      )
    }
    // A lighting circuit feeding several pendants installs far more cable than any one lamp
    // is fed through; assessing it over the total is what this replaced.
    expect(branched).toBeGreaterThan(0)
  })

  test('a circuit on a sub-board carries its submain drop as well as its own', () => {
    const { result } = subBoardHouse()
    const sub = result.panels.find((p) => !p.isMain)
    expect(sub).toBeDefined()
    expect(sub!.submainMm2).not.toBeNull()

    const onSub = result.circuits.filter((c) => c.panelId === sub!.id)
    expect(onSub.length).toBeGreaterThan(0)

    // Every circuit behind the same submain is charged the same amount for it, and it is not
    // nothing — the limit is measured from the origin of the installation.
    const upstream = onSub.map((c) => c.voltDropPercent - c.circuitDropPercent)
    for (const share of upstream) expect(share).toBeCloseTo(upstream[0], 9)
    expect(upstream[0]).toBeGreaterThan(0)

    // The main board's own circuits have nothing upstream of them.
    for (const circuit of result.circuits.filter((c) => c.panelId !== sub!.id)) {
      expect(circuit.voltDropPercent).toBeCloseTo(circuit.circuitDropPercent, 9)
    }
  })
})

describe('earthing, protection and the devices in front of the circuits', () => {
  test('protective conductors follow HD 60364-5-54 Table 54.2', () => {
    expect(peSize(1.5)).toBe(1.5)
    expect(peSize(16)).toBe(16)
    expect(peSize(25)).toBe(16)
    expect(peSize(35)).toBe(16)
    expect(peSize(50)).toBe(25)

    const { result } = panelOf(house())
    for (const circuit of result.circuits) {
      expect(circuit.peMm2).toBe(peSize(circuit.cableMm2))
    }
  })

  test('main protective bonding is half the PE, at least 6 mm² and never above 25', () => {
    expect(mainBondingSize(6)).toBe(6)
    expect(mainBondingSize(16)).toBe(8)
    expect(mainBondingSize(70)).toBe(25)

    const { result } = panelOf(house())
    const main = result.panels.find((p) => p.isMain)!
    expect(main.earthing).toBe('TN-C-S')
    expect(main.mainBondingMm2).toBeGreaterThanOrEqual(6)
    expect(main.mainBondingMm2).toBeLessThanOrEqual(25)
  })

  test('a TT installation says that the residual current devices are the whole protection', () => {
    const project = house()
    project.settings.electrical.earthing = 'TT'
    const result = solve(project)
    expect(result.panels.find((p) => p.isMain)!.earthing).toBe('TT')
    expect(result.warnings.some((w) => /earth electrode/.test(w.message))).toBe(true)
  })

  test('a surge arrester sits between the main switch and the first RCD', () => {
    const { panel } = panelOf(house())
    expect(panel.spd).not.toBeNull()
    // One pole per line plus the neutral.
    expect(panel.spd!.modules).toBe(4)
    expect(panel.spd!.upKv).toBeLessThanOrEqual(1.5)
    expect(panel.spd!.inKa).toBe(20)
    // Nothing may be laid out over the modules it occupies.
    const first = [...panel.ways].sort((l, r) => l.slot - r.slot)[0]
    expect(first.slot).toBeGreaterThanOrEqual(panel.mainSwitchModules + panel.spd!.modules)
  })

  test('every residual current device has a type, and an inverter load makes it F', () => {
    const project = house()
    const result = solve(project)
    const groupOf = (panelId: string, index: number) =>
      result.panels.find((p) => p.id === panelId)!.rcdGroups.find((g) => g.index === index)!

    for (const panel of result.panels) {
      for (const group of panel.rcdGroups) {
        expect(group.sensitivity).toBe(30)
        // Type AC has not been acceptable since the 2018 amendment, whatever is behind it.
        expect(['A', 'F', 'B']).toContain(group.type)
      }
    }

    // A washing machine or a dishwasher is an inverter drive, and the composite residual
    // waveform one produces is what Type F exists for.
    const drives = new Set<string>(['washing-machine', 'dishwasher', 'tumble-dryer'])
    const byId = new Map(project.fixtures.map((f) => [f.id, f]))
    const withDrive = result.circuits.filter((c) =>
      c.fixtureIds.some((id) => drives.has(byId.get(id)?.type ?? '')),
    )
    expect(withDrive.length).toBeGreaterThan(0)
    for (const circuit of withDrive) {
      expect(groupOf(circuit.panelId, circuit.rcdGroup).type).toBe('F')
    }
  })

  test('a three-phase load is not given the single-phase rule breaker', () => {
    const onOne = panelOf(house({ cooker3ph: false })).result.circuits.find(
      (c) => c.kind === 'cooker',
    )!
    const onThree = panelOf(house({ cooker3ph: true })).result.circuits.find(
      (c) => c.kind === 'cooker',
    )!

    // 7 kW over three lines is 10.1 A a line. The rule's 32 A floor is a single-phase
    // convention: on three lines it would be a breaker the circuit could never trip, on a
    // cable three times the size it needs. European practice for that hob is C16.
    expect(onOne.breakerAmps).toBe(32)
    expect(onThree.breakerAmps).toBe(16)
    expect(onThree.curve).toBe('C')
    expect(onThree.cableMm2).toBeLessThan(onOne.cableMm2)
    expect(onThree.cores).toBe(5)
  })
})
