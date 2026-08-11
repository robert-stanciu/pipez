/**
 * What the supply solver has to get right beyond reaching every tap.
 *
 * The sizing tables are checked in `standards/en806.test.ts`; these are the cases where the
 * router has to apply them — the material the house is actually plumbed in, and the four
 * things EN 806 asks about a run once it exists: how fast the water goes, how far the size
 * carries, how much pressure is left at the end and how much water stands in a hot leg.
 */

import { describe, expect, test } from 'vitest'

import {
  createFixture,
  createProject,
  createRoom,
  createServicePoint,
  relevel,
} from '../project.ts'
import { supplySizes } from '../standards/en806.ts'
import type { FixtureType, Network, Project, SupplyMaterial, SupplyRoute } from '../types.ts'
import { solve } from './index.ts'

/** One room with a water entry in the corner and whatever draw-offs the case needs. */
function house(options: {
  width?: number
  fixtures: Array<{ type: FixtureType; wallIndex: number; offset: number }>
  material?: SupplyMaterial
  route?: SupplyRoute
}): Project {
  const project = createProject('test')
  if (options.material) project.settings.supply.material = options.material
  if (options.route) project.settings.supply.route = options.route
  // Pinned rather than left on the app's default, because back entry turns the tails into
  // wall runs — and these cases are about where the *distribution* sits, not the tails.
  project.settings.connectionEntry = 'bottom'

  const ground = project.levels[0]
  const room = createRoom('Room', { x: 0, y: 0 }, options.width ?? 5000, 3000, ground)
  project.rooms.push(room)

  for (const spec of options.fixtures) {
    project.fixtures.push(
      createFixture(project, spec.type, room.id, {
        wallIndex: spec.wallIndex,
        wallOffset: spec.offset,
      }),
    )
  }
  project.servicePoints.push(createServicePoint('waterEntry', { x: 200, y: 200 }, ground, room.id))
  return relevel(project)
}

const coldOf = (project: Project) => solve(project).networks.find((n) => n.system === 'cold')

const supplyWarnings = (project: Project) =>
  solve(project).warnings.filter((w) => w.system === 'cold' || w.system === 'hot')

describe('pipe material', () => {
  test('a new project is plumbed in PP-R, and every run comes off that ladder', () => {
    const project = house({ fixtures: [{ type: 'basin', wallIndex: 0, offset: 1000 }] })
    expect(project.settings.supply.material).toBe('PPR')

    const ladder = new Set(supplySizes('PPR').map((row) => row.od))
    const cold = coldOf(project)!
    expect(cold.segments.length).toBeGreaterThan(0)
    for (const segment of cold.segments) expect(ladder.has(segment.size)).toBe(true)
    // A basin tail is 15 mm in copper, which is ø20 in PP-R — never ø16 or a bare DN15.
    expect(Math.min(...cold.segments.map((s) => s.size))).toBe(20)
  })

  test('choosing copper puts the run back on copper outside diameters', () => {
    const fixtures = [{ type: 'basin' as const, wallIndex: 0, offset: 1000 }]
    const copper = coldOf(house({ fixtures, material: 'copper' }))!
    const ladder = new Set(supplySizes('copper').map((row) => row.od))
    for (const segment of copper.segments) expect(ladder.has(segment.size)).toBe(true)
    expect(Math.min(...copper.segments.map((s) => s.size))).toBe(15)
  })
})

describe('where the water runs', () => {
  const fixtures = [
    { type: 'basin' as const, wallIndex: 0, offset: 1000 },
    { type: 'sink' as const, wallIndex: 2, offset: 2000 },
    { type: 'shower' as const, wallIndex: 1, offset: 1200 },
  ]

  /** Heights of the horizontal distribution runs, which is all the choice moves. */
  const heightsOf = (project: Project): number[] =>
    (solve(project).networks.find((n) => n.system === 'cold') as Network).segments
      // Only the level runs: the connection to each point crosses the wall either way.
      .filter((s) => Math.abs(s.a.z - s.b.z) < 1 && s.role !== 'stack')
      .map((s) => s.a.z)

  test('a new project distributes under the floor', () => {
    // The default the app ships with: the pipe goes in with the screed that is being laid
    // anyway, and the runs to the sanitaryware are the short ones.
    expect(createProject('t').settings.supply.route).toBe('floor')
  })

  test('floor routing puts the distribution in the screed, ceiling routing under the slab', () => {
    const low = heightsOf(house({ fixtures, route: 'floor' }))
    const high = heightsOf(house({ fixtures, route: 'ceiling' }))
    expect(low.length).toBeGreaterThan(0)
    expect(high.length).toBeGreaterThan(0)

    // Compared as averages: both layouts still have to reach every draw-off, so the
    // difference is in where the horizontal runs sit, not in every single segment.
    const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length
    expect(mean(low)).toBeLessThan(mean(high))
    // In the build-up under the floor, not merely lower down the room.
    expect(Math.max(...low)).toBeLessThan(0)
  })

  test('cold and hot stay parallel — both follow the one choice', () => {
    const project = house({
      fixtures: [...fixtures, { type: 'water-heater', wallIndex: 3, offset: 800 }],
      route: 'floor',
    })
    const result = solve(project)
    for (const system of ['cold', 'hot'] as const) {
      const network = result.networks.find((n) => n.system === system)!
      const level = network.segments.filter((s) => Math.abs(s.a.z - s.b.z) < 1)
      expect(level.length).toBeGreaterThan(0)
      for (const run of level) expect(run.a.z).toBeLessThan(0)
    }
  })

  test('the choice moves the pipe without changing what is on the schedule', () => {
    const schedule = (route: SupplyRoute) => {
      const cold = solve(house({ fixtures, route })).networks.find((n) => n.system === 'cold')!
      return {
        unreached: cold.unreachedFixtureIds,
        sizes: [...new Set(cold.segments.map((s) => s.size))].sort((a, b) => a - b),
        load: Math.max(...cold.segments.map((s) => s.load)),
      }
    }
    expect(schedule('floor')).toEqual(schedule('ceiling'))
  })
})

describe('EN 806-3 §4.4 velocity', () => {
  test('a shared run past 2 m/s is reported once, with the size that is too small', () => {
    // Four kitchen sinks are 8 LU of cold, which the table puts on ø25 PP-R — a 16,6 mm
    // bore, and 0,48 l/s through that is over two metres a second.
    const project = house({
      width: 6000,
      fixtures: [0, 1, 2, 3].map((i) => ({
        type: 'sink' as const,
        wallIndex: 0,
        offset: 900 + i * 1100,
      })),
    })
    const fast = supplyWarnings(project).filter(
      (w) => w.system === 'cold' && /m\/s/.test(w.message),
    )
    expect(fast.length).toBeGreaterThan(0)
    expect(fast[0].message).toMatch(/Ø\d+ PPR runs at \d\.\d m\/s/)
    expect(fast[0].severity).toBe('warning')

    // One warning per size, however many grid edges the run was made of.
    const sizes = fast.map((w) => w.message.slice(0, w.message.indexOf(' runs')))
    expect(new Set(sizes).size).toBe(sizes.length)
  })

  test('a single basin on its own connection is nowhere near either ceiling', () => {
    const project = house({ fixtures: [{ type: 'basin', wallIndex: 0, offset: 1000 }] })
    expect(supplyWarnings(project).filter((w) => /m\/s/.test(w.message))).toEqual([])
  })
})

describe('EN 806-3 Table 3 maximum run length', () => {
  test('a long run of the smallest size is reported', () => {
    // ø20 PP-R carrying 3 LU or less is limited to 9 m; this basin is well past that.
    const project = house({
      width: 16_000,
      fixtures: [{ type: 'basin', wallIndex: 0, offset: 15_000 }],
    })
    const long = supplyWarnings(project).filter((w) => /the EN 806-3 table allows/.test(w.message))
    expect(long.length).toBeGreaterThan(0)
    expect(long[0].message).toMatch(/m of Ø20 PPR/)
  })

  test('a short run of the same size is not', () => {
    const project = house({ fixtures: [{ type: 'basin', wallIndex: 0, offset: 1000 }] })
    expect(supplyWarnings(project).filter((w) => /table allows/.test(w.message))).toEqual([])
  })
})

describe('the hot dead leg', () => {
  test('a leg is measured by the water standing in it, not by its length', () => {
    // A heater at one end of a long room and a basin at the other — wall 2 is the far side
    // of the room and runs back the other way, so both offsets are measured towards it.
    // ø20 PP-R holds 0,137 litres a metre, so three litres is about 22 m of it.
    const project = house({
      width: 26_000,
      fixtures: [
        { type: 'water-heater', wallIndex: 2, offset: 25_000 },
        { type: 'basin', wallIndex: 0, offset: 25_000 },
      ],
    })
    const legs = supplyWarnings(project).filter((w) => /dead-leg limit/.test(w.message))
    expect(legs.length).toBeGreaterThan(0)
    expect(legs[0].message).toMatch(/litres of hot water standing/)
    expect(legs[0].system).toBe('hot')
    expect(legs[0].severity).toBe('warning')
  })

  test('a basin beside the heater has no dead leg worth reporting', () => {
    const project = house({
      fixtures: [
        { type: 'water-heater', wallIndex: 2, offset: 1000 },
        { type: 'basin', wallIndex: 2, offset: 2000 },
      ],
    })
    expect(supplyWarnings(project).filter((w) => /dead-leg/.test(w.message))).toEqual([])
  })
})

describe('EN 806-3 §4.3 pressure', () => {
  test('a normal house keeps its 100 kPa at the worst outlet', () => {
    const project = house({
      fixtures: [
        { type: 'basin', wallIndex: 0, offset: 1000 },
        { type: 'sink', wallIndex: 2, offset: 2000 },
      ],
    })
    expect(supplyWarnings(project).filter((w) => /worst outlet/.test(w.message))).toEqual([])
  })

  test('a weak main is reported at the outlet that suffers for it, by name', () => {
    const project = house({
      fixtures: [
        { type: 'basin', wallIndex: 0, offset: 1000 },
        { type: 'sink', wallIndex: 2, offset: 2000 },
      ],
    })
    project.settings.supply.entryPressureKpa = 90

    const short = supplyWarnings(project).filter((w) => /worst outlet/.test(w.message))
    expect(short.length).toBeGreaterThan(0)
    expect(short[0].message).toMatch(/short of the 100 kPa/)
    // Table 2's minimum flow rate is what the pressure has to deliver, so it is quoted.
    expect(short[0].message).toMatch(/0\.\d\d l\/s minimum/)
  })

  test('an unreduced high-pressure main is reported at the lowest draw-off', () => {
    const project = house({ fixtures: [{ type: 'basin', wallIndex: 0, offset: 1000 }] })
    project.settings.supply.entryPressureKpa = 700

    const high = supplyWarnings(project).filter((w) => /pressure reducing valve/.test(w.message))
    expect(high.length).toBeGreaterThan(0)
  })
})
