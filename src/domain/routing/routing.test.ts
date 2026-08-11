/**
 * Golden cases for the routing engine.
 *
 * These are the real safety net for this project: the 3D view can look plausible while the
 * drainage runs uphill, so the properties that actually matter — falls, diameters, reach —
 * are asserted here rather than eyeballed.
 */

import { describe, expect, test } from 'vitest'

import {
  createFixture,
  createLevel,
  createOpening,
  createProject,
  createRoom,
  createServicePoint,
  relevel,
  sampleProject,
} from '../project.ts'
import { branchDiameter, flowFromDu } from '../standards/en12056.ts'
import { supplyDiameter } from '../standards/en806.ts'
import type { FixtureType, Network, Project, Segment } from '../types.ts'
import { groupCircuits, solve } from './index.ts'
import { RouteGraph } from './graph.ts'
import { buildWallGraph } from './layers.ts'

/* ------------------------------------------------------------------ helpers */

/** One room, one outlet, whatever fixtures the case needs. */
function scenario(options: {
  width?: number
  depth?: number
  fixtures?: Array<{ type: FixtureType; wallIndex: number; offset: number }>
  outletAt?: { x: number; y: number }
  outletZ?: number
}): Project {
  const project = createProject('test')
  const ground = project.levels[0]
  const room = createRoom(
    'Room',
    { x: 0, y: 0 },
    options.width ?? 4000,
    options.depth ?? 3000,
    ground,
  )
  project.rooms.push(room)

  for (const spec of options.fixtures ?? []) {
    project.fixtures.push(
      createFixture(project, spec.type, room.id, {
        wallIndex: spec.wallIndex,
        wallOffset: spec.offset,
      }),
    )
  }

  const outlet = createServicePoint(
    'wasteOutlet',
    options.outletAt ?? { x: 3600, y: 200 },
    ground,
    room.id,
  )
  if (options.outletZ !== undefined) outlet.z = options.outletZ
  project.servicePoints.push(outlet)
  return relevel(project)
}

/**
 * Two storeys with a fixture upstairs. `alignUpper` shifts the upper room sideways, which is
 * how a stack is made impossible: no wall lines up through the slab.
 */
function twoStorey(options: { alignUpper?: boolean } = {}): Project {
  const aligned = options.alignUpper ?? true
  const project = createProject('two storey')
  const ground = project.levels[0]
  const upper = createLevel(1, project.settings)
  project.levels.push(upper)
  relevel(project)

  const downstairs = createRoom('Kitchen', { x: 0, y: 0 }, 4000, 3000, ground, project.settings)
  const upstairs = createRoom(
    'Bathroom',
    { x: aligned ? 0 : 9000, y: 0 },
    4000,
    3000,
    upper,
    project.settings,
  )
  project.rooms.push(downstairs, upstairs)

  project.fixtures.push(
    createFixture(project, 'sink', downstairs.id, { wallIndex: 0, wallOffset: 700 }),
    createFixture(project, 'socket', downstairs.id, { wallIndex: 2, wallOffset: 1000 }),
    createFixture(project, 'wc', upstairs.id, { wallIndex: 0, wallOffset: 900 }),
    createFixture(project, 'basin', upstairs.id, { wallIndex: 0, wallOffset: 2000 }),
    // Something electrical upstairs, so the cable riser has a reason to exist.
    createFixture(project, 'socket', upstairs.id, { wallIndex: 2, wallOffset: 1200 }),
  )

  project.servicePoints.push(
    createServicePoint('wasteOutlet', { x: 3600, y: 200 }, ground, downstairs.id),
    createServicePoint('waterEntry', { x: 200, y: 200 }, ground, downstairs.id),
    createServicePoint('electricalPanel', { x: 200, y: 2800 }, ground, downstairs.id),
  )

  return relevel(project)
}

const networkOf = (project: Project, system: Network['system']): Network | undefined =>
  solve(project).networks.find((n) => n.system === system)

/** Horizontal component of a run — the distance the fall is measured over. */
const planRun = (s: Segment): number => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)

const planLength = (network: Network): number =>
  network.segments.reduce((sum, s) => sum + planRun(s), 0)

/* -------------------------------------------------------------------- cases */

describe('drainage', () => {
  test('a single sink drains downhill to the outlet at a legal fall', () => {
    const project = scenario({ fixtures: [{ type: 'sink', wallIndex: 0, offset: 700 }] })
    const waste = networkOf(project, 'waste')

    expect(waste).toBeDefined()
    expect(waste!.unreachedFixtureIds).toEqual([])

    for (const segment of waste!.segments) {
      // Segments are emitted child -> parent, i.e. away from the outlet, so the far end is
      // always the higher one. Anything else would be a pipe asking water to climb.
      expect(segment.a.z).toBeGreaterThanOrEqual(segment.b.z - 1e-6)
      if (segment.role === 'branch' && planRun(segment) > 1) {
        expect(segment.slope).toBeGreaterThanOrEqual(project.settings.drainage.minSlope - 1e-9)
        expect(segment.slope).toBeLessThanOrEqual(project.settings.drainage.maxSlope + 1e-9)
      }
    }
  })

  test('a kitchen sink branch is DN50 — its own connection size, not its tiny DU load', () => {
    const project = scenario({ fixtures: [{ type: 'sink', wallIndex: 0, offset: 700 }] })
    const waste = networkOf(project, 'waste')!
    for (const segment of waste.segments) expect(segment.size).toBeGreaterThanOrEqual(50)
  })

  test('the route is close to the rectilinear optimum', () => {
    const project = scenario({
      fixtures: [{ type: 'sink', wallIndex: 0, offset: 700 }],
      outletAt: { x: 3600, y: 200 },
    })
    const waste = networkOf(project, 'waste')!

    // Sink on wall 0 (the south wall): its waste port sits 150 mm into the room.
    const manhattan = Math.abs(3600 - 700) + Math.abs(200 - 150)
    const straight = Math.hypot(3600 - 700, 200 - 150)

    // Nothing can beat the straight line, and swept corners cut fractionally inside the
    // Manhattan path, so the route lands just under it rather than exactly on it.
    expect(planLength(waste)).toBeGreaterThanOrEqual(straight - 1)
    expect(planLength(waste)).toBeLessThan(manhattan * 1.5)
  })

  test('two fixtures share a trunk, and the trunk steps up to carry both', () => {
    const project = scenario({
      fixtures: [
        { type: 'sink', wallIndex: 0, offset: 700 },
        { type: 'sink', wallIndex: 0, offset: 1600 },
      ],
    })
    const waste = networkOf(project, 'waste')!

    // Two kitchen sinks are 0.8 DU each; 1.6 DU is past what DN50 may carry.
    const trunk = waste.segments.filter((s) => s.load > 1.5)
    expect(trunk.length).toBeGreaterThan(0)
    expect(Math.max(...trunk.map((s) => s.size))).toBeGreaterThanOrEqual(70)

    // And the shared run really is shared, rather than two parallel pipes.
    const soloTotal = waste.segments.filter((s) => s.load <= 0.8).reduce((n, s) => n + planRun(s), 0)
    expect(trunk.reduce((n, s) => n + planRun(s), 0)).toBeGreaterThan(0)
    expect(soloTotal).toBeLessThan(planLength(waste))
  })

  test('diameters never reduce on the way to the outlet', () => {
    const waste = solve(sampleProject()).networks.find((n) => n.system === 'waste')!
    // Walk each junction: the largest pipe arriving must not exceed the pipe leaving.
    const byStart = new Map<string, Segment[]>()
    const key = (p: { x: number; y: number; z: number }) =>
      `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    for (const segment of waste.segments) {
      const list = byStart.get(key(segment.b))
      if (list) list.push(segment)
      else byStart.set(key(segment.b), [segment])
    }
    for (const segment of waste.segments) {
      const upstream = byStart.get(key(segment.a)) ?? []
      for (const feeder of upstream) expect(segment.size).toBeGreaterThanOrEqual(feeder.size)
    }
  })

  test('an outlet above the fixtures is reported, not drawn as an uphill pipe', () => {
    const project = scenario({
      fixtures: [{ type: 'sink', wallIndex: 0, offset: 700 }],
      outletZ: 2000,
    })
    const result = solve(project)

    const errors = result.warnings.filter((w) => w.severity === 'error' && w.system === 'waste')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((w) => /trap/i.test(w.message))).toBe(true)

    const waste = result.networks.find((n) => n.system === 'waste')
    for (const segment of waste?.segments ?? []) {
      expect(segment.a.z).toBeGreaterThanOrEqual(segment.b.z - 1e-6)
    }
  })

  test('the fall is eased, not abandoned, when the design slope will not fit', () => {
    const project = scenario({
      width: 9000,
      fixtures: [{ type: 'sink', wallIndex: 0, offset: 200 }],
      outletAt: { x: 8600, y: 200 },
      outletZ: -180,
    })
    const result = solve(project)

    // 2% over ~8.4 m wants 170 mm of drop and there is only 120 mm of headroom — but 1.4%
    // fits and is still above the 1% minimum, so the solver should ease the fall rather
    // than either giving up or quietly running the pipe up through the floor.
    expect(result.warnings.some((w) => w.severity === 'info' && /eased/.test(w.message))).toBe(true)
    expect(
      result.warnings.some((w) => w.severity === 'error' && w.system === 'waste'),
    ).toBe(false)

    const waste = result.networks.find((n) => n.system === 'waste')!
    for (const segment of waste.segments) {
      if (segment.role !== 'branch' || planRun(segment) <= 1) continue
      expect(segment.slope).toBeGreaterThanOrEqual(project.settings.drainage.minSlope - 1e-9)
      // No part of a buried branch may surface above the finished floor.
      expect(Math.max(segment.a.z, segment.b.z)).toBeLessThanOrEqual(0)
    }
  })

  test('a run too long to stay under the floor at any legal fall is reported', () => {
    const project = scenario({
      width: 30_000,
      fixtures: [{ type: 'sink', wallIndex: 0, offset: 200 }],
      outletAt: { x: 29_600, y: 200 },
      outletZ: -120,
    })
    const errors = solve(project).warnings.filter(
      (w) => w.severity === 'error' && /under the floor/.test(w.message),
    )
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('swept corners', () => {
  const turnAt = (a: Segment, b: Segment, corner: { x: number; y: number; z: number }) => {
    const key = (p: { x: number; y: number; z: number }) =>
      `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    const dir = (from: { x: number; y: number; z: number }, to: typeof from) => {
      const l = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) || 1
      return { x: (to.x - from.x) / l, y: (to.y - from.y) / l, z: (to.z - from.z) / l }
    }
    const inDir = dir(key(a.a) === key(corner) ? a.b : a.a, corner)
    const outDir = dir(corner, key(b.a) === key(corner) ? b.b : b.a)
    const dot = Math.max(-1, Math.min(1, inDir.x * outDir.x + inDir.y * outDir.y + inDir.z * outDir.z))
    return (Math.acos(dot) * 180) / Math.PI
  }

  test('no square corner survives — every turn is 45° or less', () => {
    const waste = solve(sampleProject()).networks.find((n) => n.system === 'waste')!

    const key = (p: { x: number; y: number; z: number }) =>
      `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    const junctions = new Map<string, { point: (typeof waste.segments)[0]['a']; segs: Segment[] }>()
    for (const segment of waste.segments) {
      for (const end of [segment.a, segment.b]) {
        const entry = junctions.get(key(end))
        if (entry) entry.segs.push(segment)
        else junctions.set(key(end), { point: end, segs: [segment] })
      }
    }

    let corners = 0
    for (const { point, segs } of junctions.values()) {
      if (segs.length !== 2) continue
      const turn = turnAt(segs[0], segs[1], point)
      if (turn < 1) continue
      corners += 1
      // 45° with a little slack for the millimetre rounding of node positions.
      expect(turn).toBeLessThan(50)
    }
    expect(corners).toBeGreaterThan(0)
  })

  test('a square corner becomes two 45° bends with a leg between them', () => {
    const waste = solve(sampleProject()).networks.find((n) => n.system === 'waste')!

    const bends = waste.segments.filter((s) => s.role === 'bend')
    expect(bends.length).toBeGreaterThan(0)

    const elbows = waste.fittings.filter((f) => f.kind === 'elbow')
    // Each swept corner contributes exactly two elbows, one at each end of its leg.
    expect(elbows.length).toBeGreaterThanOrEqual(bends.length * 2)
    for (const elbow of elbows) {
      // Exactly 45 — the fitting you can order, not the raw angle, which the fall tilts by
      // about a degree.
      expect(elbow.angle).toBe(45)
      expect(elbow.dirIn).toBeDefined()
      expect(elbow.dirOut).toBeDefined()
    }
  })

  test('a joint in a graded straight run is not reported as a fitting', () => {
    // Pipe laid to a fall is never level, so two square legs meet at 89-ish degrees. Nothing
    // in that neighbourhood may be called an elbow.
    for (const strategy of ['rectilinear', 'diagonal'] as const) {
      const project = sampleProject()
      project.settings.drainage.strategy = strategy
      const waste = solve(project).networks.find((n) => n.system === 'waste')!
      for (const fitting of waste.fittings) {
        if (fitting.kind !== 'elbow') continue
        expect(fitting.angle).toBeGreaterThanOrEqual(15)
      }
    }
  })

  test('bends are billed as bends, and their bodies are not billed twice as pipe', () => {
    const result = solve(sampleProject())
    const drainLines = result.bom.filter((line) => line.system === 'waste')
    expect(drainLines.some((line) => /^Bend 4\d° DN/.test(line.item))).toBe(true)
    // The whole point: drainage never orders a square bend.
    expect(drainLines.some((line) => /^Bend 90° DN/.test(line.item))).toBe(false)

    const waste = result.networks.find((n) => n.system === 'waste')!
    const pipeMetres = result.bom
      .filter((l) => l.system === 'waste' && l.unit === 'm')
      .reduce((sum, l) => sum + l.quantity, 0)
    const bendMetres = waste.segments
      .filter((s) => s.role === 'bend')
      .reduce((sum, s) => sum + s.length, 0)
    expect(bendMetres).toBeGreaterThan(0)
    expect(pipeMetres * 1000).toBeLessThan(waste.totalLength - bendMetres + 1)
  })

  test('sweeping keeps the network connected and still flowing downhill', () => {
    const waste = solve(sampleProject()).networks.find((n) => n.system === 'waste')!
    for (const segment of waste.segments) {
      expect(segment.a.z).toBeGreaterThanOrEqual(segment.b.z - 1e-6)
      expect(segment.length).toBeGreaterThan(0)
    }
    // Nothing orphaned: every endpoint is shared with at least one other run.
    const key = (p: { x: number; y: number; z: number }) =>
      `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    const seen = new Map<string, number>()
    for (const s of waste.segments) {
      for (const end of [s.a, s.b]) seen.set(key(end), (seen.get(key(end)) ?? 0) + 1)
    }
    const loose = [...seen.values()].filter((n) => n === 1).length
    // Loose ends are the fixtures plus the outlet, nothing more.
    expect(loose).toBeLessThanOrEqual(waste.segments.filter((s) => s.role === 'drop').length + 1)
  })
})

describe('drainage strategies', () => {
  const diagonalProject = () => {
    const project = sampleProject()
    project.settings.drainage.strategy = 'diagonal'
    return project
  }

  test('the rectilinear strategy keeps every branch parallel to an axis', () => {
    const waste = solve(sampleProject()).networks.find((n) => n.system === 'waste')!
    for (const segment of waste.segments) {
      if (segment.role === 'bend') continue // a swept corner is 45° by construction
      const dx = Math.abs(segment.a.x - segment.b.x)
      const dy = Math.abs(segment.a.y - segment.b.y)
      expect(Math.min(dx, dy)).toBeLessThan(1)
    }
  })

  test('the diagonal strategy produces 45° runs, and only 45°', () => {
    const waste = solve(diagonalProject()).networks.find((n) => n.system === 'waste')!

    const diagonals = waste.segments.filter((s) => {
      if (s.role === 'bend') return false
      const dx = Math.abs(s.a.x - s.b.x)
      const dy = Math.abs(s.a.y - s.b.y)
      return dx > 1 && dy > 1
    })
    expect(diagonals.length).toBeGreaterThan(0)

    // Any angle other than 45° would need a fitting that is not made.
    for (const segment of diagonals) {
      const dx = Math.abs(segment.a.x - segment.b.x)
      const dy = Math.abs(segment.a.y - segment.b.y)
      expect(Math.abs(dx - dy)).toBeLessThan(2)
    }
  })

  test('going diagonally is shorter than going round the corner', () => {
    // A fixture set diagonally away from the outlet is where the strategy earns its keep.
    const build = (strategy: 'rectilinear' | 'diagonal') => {
      const project = scenario({
        width: 6000,
        depth: 5000,
        fixtures: [{ type: 'sink', wallIndex: 0, offset: 400 }],
        outletAt: { x: 5600, y: 4600 },
      })
      project.settings.drainage.strategy = strategy
      return solve(project).networks.find((n) => n.system === 'waste')!
    }

    const straight = build('rectilinear')
    const diagonal = build('diagonal')
    expect(diagonal.totalLength).toBeLessThan(straight.totalLength)
  })

  test('both strategies still reach every fixture and stay legal', () => {
    for (const strategy of ['rectilinear', 'diagonal'] as const) {
      const project = sampleProject()
      project.settings.drainage.strategy = strategy
      const result = solve(project)
      const waste = result.networks.find((n) => n.system === 'waste')!
      expect(waste.unreachedFixtureIds).toEqual([])
      for (const segment of waste.segments) {
        expect(segment.a.z).toBeGreaterThanOrEqual(segment.b.z - 1e-6)
      }
    }
  })

  test('only drainage changes strategy — supply and cabling stay rectilinear', () => {
    const result = solve(diagonalProject())
    for (const system of ['cold', 'hot', 'power'] as const) {
      const network = result.networks.find((n) => n.system === system)
      for (const segment of network?.segments ?? []) {
        const dx = Math.abs(segment.a.x - segment.b.x)
        const dy = Math.abs(segment.a.y - segment.b.y)
        expect(Math.min(dx, dy)).toBeLessThan(1)
      }
    }
  })
})

describe('storeys and stacks', () => {
  test('an upstairs fixture drains down a stack to the ground-floor outlet', () => {
    const project = twoStorey()
    const result = solve(project)
    const waste = result.networks.find((n) => n.system === 'waste')!

    expect(waste.unreachedFixtureIds).toEqual([])

    const stacks = waste.segments.filter((s) => s.role === 'stack')
    expect(stacks.length).toBeGreaterThan(0)

    const storey = project.levels[1].elevation - project.levels[0].elevation
    for (const stack of stacks) {
      // Vertical, downward, and spanning roughly a storey.
      expect(Math.hypot(stack.b.x - stack.a.x, stack.b.y - stack.a.y)).toBeLessThan(1)
      expect(stack.a.z).toBeGreaterThan(stack.b.z)
      expect(stack.length).toBeGreaterThan(storey * 0.5)
    }
  })

  test('the stack is a single shared riser, not one hole per fixture', () => {
    const waste = solve(twoStorey()).networks.find((n) => n.system === 'waste')!
    const columns = new Set(
      waste.segments
        .filter((s) => s.role === 'stack')
        .map((s) => `${Math.round(s.a.x)},${Math.round(s.a.y)}`),
    )
    // A WC and a basin upstairs; both should come down the same shaft.
    expect(columns.size).toBe(1)
  })

  test('a WC upstairs makes the stack DN100', () => {
    const waste = solve(twoStorey()).networks.find((n) => n.system === 'waste')!
    const stack = waste.segments.find((s) => s.role === 'stack')!
    expect(stack.size).toBeGreaterThanOrEqual(100)
  })

  test('only the horizontal run buys fall — the stack drop does not eat headroom', () => {
    const project = twoStorey()
    const waste = solve(project).networks.find((n) => n.system === 'waste')!

    // Every branch on a storey has to stay under that storey's own floor.
    for (const segment of waste.segments) {
      if (segment.role !== 'branch') continue
      const level = [...project.levels]
        .reverse()
        .find((l) => Math.max(segment.a.z, segment.b.z) < l.elevation + l.height)
      if (!level) continue
      expect(Math.max(segment.a.z, segment.b.z)).toBeLessThanOrEqual(level.elevation)
    }
  })

  test('every system reaches upstairs, and each rises on its own riser', () => {
    const result = solve(twoStorey())
    for (const network of result.networks) {
      expect(network.unreachedFixtureIds).toEqual([])
    }
    for (const system of ['cold', 'power'] as const) {
      const network = result.networks.find((n) => n.system === system)
      expect(network?.segments.some((s) => s.role === 'stack')).toBe(true)
    }
  })

  test('an upper storey whose walls do not line up cannot be served, and says why', () => {
    const result = solve(twoStorey({ alignUpper: false }))

    expect(result.warnings.some((w) => /stack|riser/i.test(w.message))).toBe(true)
    expect(result.networks.flatMap((n) => n.unreachedFixtureIds).length).toBeGreaterThan(0)
  })

  test('a stack is billed as a soil stack, not as more waste pipe', () => {
    const result = solve(twoStorey())
    expect(result.bom.some((line) => line.item.startsWith('Soil stack DN'))).toBe(true)
  })

  test('the sample house is a two-storey building that fully solves', () => {
    const project = sampleProject()
    expect(project.levels).toHaveLength(2)
    expect(new Set(project.rooms.map((r) => r.levelId)).size).toBe(2)

    const result = solve(project)
    for (const network of result.networks) expect(network.unreachedFixtureIds).toEqual([])
    expect(result.warnings.some((w) => w.severity === 'error')).toBe(false)
  })
})

describe('reach across rooms', () => {
  test('a fixture in the next room still reaches the outlet', () => {
    const project = sampleProject()
    const result = solve(project)

    const bathroom = project.rooms.find((r) => r.name === 'Bathroom')!
    const bathroomFixtures = project.fixtures.filter((f) => f.roomId === bathroom.id)
    expect(bathroomFixtures.length).toBeGreaterThan(0)

    for (const network of result.networks) {
      expect(network.unreachedFixtureIds).toEqual([])
    }
  })

  test('a detached room cannot be reached, and says so', () => {
    const project = sampleProject()
    // Shove the bathroom well clear of the kitchen — nothing connects them any more.
    const bathroom = project.rooms.find((r) => r.name === 'Bathroom')!
    bathroom.outline = bathroom.outline.map((p) => ({ x: p.x + 6000, y: p.y }))

    const result = solve(project)
    const unreached = result.networks.flatMap((n) => n.unreachedFixtureIds)
    expect(unreached.length).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.severity === 'error')).toBe(true)
  })
})

describe('supply', () => {
  test('cold reaches every draw-off and is sized by loading units', () => {
    const cold = solve(sampleProject()).networks.find((n) => n.system === 'cold')!
    expect(cold.unreachedFixtureIds).toEqual([])
    expect(cold.segments.length).toBeGreaterThan(0)
    for (const segment of cold.segments) {
      expect(segment.size).toBeGreaterThanOrEqual(supplyDiameter(segment.load, 12))
    }
  })

  test('supply diameters follow the EN 806-3 table', () => {
    expect(supplyDiameter(1, 12)).toBe(12)
    expect(supplyDiameter(3, 12)).toBe(15)
    expect(supplyDiameter(8, 12)).toBe(18)
    expect(supplyDiameter(20, 12)).toBe(22)
    // A fixture's own connection size is a floor, whatever the load says.
    expect(supplyDiameter(1, 22)).toBe(22)
  })
})

describe('standards tables', () => {
  test('branch diameters follow EN 12056-2 System I', () => {
    expect(branchDiameter(0.5, 40)).toBe(40)
    expect(branchDiameter(0.8, 40)).toBe(50)
    expect(branchDiameter(1.6, 40)).toBe(70)
    expect(branchDiameter(4.0, 40)).toBe(100)
    expect(branchDiameter(0.5, 100)).toBe(100)
  })

  test('Qww = K·√ΣDU', () => {
    expect(flowFromDu(4)).toBeCloseTo(1.0, 6)
    expect(flowFromDu(0)).toBe(0)
  })
})

describe('electrical', () => {
  test('appliances and the cooker each get a dedicated circuit', () => {
    const project = sampleProject()
    let n = 0
    const circuits = groupCircuits(project, () => `c${n++}`)

    const cooker = circuits.find((c) => c.kind === 'cooker')
    expect(cooker).toBeDefined()
    expect(cooker!.breakerAmps).toBe(32)
    expect(cooker!.fixtureIds).toHaveLength(1)

    for (const circuit of circuits.filter((c) => c.kind === 'appliance')) {
      expect(circuit.fixtureIds).toHaveLength(1)
    }
  })

  test('a socket circuit splits once it runs out of outlets', () => {
    const project = createProject('sockets')
    const room = createRoom('Room', { x: 0, y: 0 }, 6000, 4000, project.levels[0])
    project.rooms.push(room)
    for (let i = 0; i < 15; i++) {
      project.fixtures.push(
        createFixture(project, 'socket', room.id, { wallIndex: 0, wallOffset: 300 + i * 350 }),
      )
    }

    let n = 0
    const circuits = groupCircuits(project, () => `c${n++}`).filter((c) => c.kind === 'sockets')
    expect(circuits.length).toBe(2)
    for (const circuit of circuits) expect(circuit.fixtureIds.length).toBeLessThanOrEqual(10)
  })

  test('every circuit is routed and RCD protected', () => {
    const result = solve(sampleProject())
    const power = result.networks.find((n) => n.system === 'power')!
    expect(power.unreachedFixtureIds).toEqual([])
    for (const circuit of result.circuits) expect(circuit.rcdProtected).toBe(true)

    const routed = new Set(power.segments.map((s) => s.circuitId))
    for (const circuit of result.circuits) expect(routed.has(circuit.id)).toBe(true)
  })

  test('a doorway blocks cable runs through the wall it sits in', () => {
    const withoutDoor = createProject('plain')
    withoutDoor.rooms.push(createRoom('Room', { x: 0, y: 0 }, 4000, 3000, withoutDoor.levels[0]))

    const withDoor = createProject('door')
    const room = createRoom('Room', { x: 0, y: 0 }, 4000, 3000, withDoor.levels[0])
    withDoor.rooms.push(room)
    // A door across the middle of wall 0, spanning the cable zone's height.
    const door = createOpening(room.id, 0, 2000, 'door')
    door.width = 2000
    door.height = 2600
    withDoor.openings.push(door)

    const options = { heightAboveFloor: 2300, step: 400 }
    const plain = new RouteGraph()
    buildWallGraph(plain, withoutDoor, options)
    const blocked = new RouteGraph()
    buildWallGraph(blocked, withDoor, options)

    expect(blocked.edgeCount).toBeLessThan(plain.edgeCount)
  })
})

describe('engine behaviour', () => {
  test('solving is deterministic', () => {
    const project = sampleProject()
    // Everything but the wall-clock measurement has to match exactly, run to run.
    const stable = (p: Project) => {
      const { stats, ...rest } = solve(p)
      return { ...rest, stats: { nodes: stats.graphNodes, edges: stats.graphEdges } }
    }
    expect(stable(project)).toEqual(stable(project))
  })

  test('the graph stays small enough to search interactively', () => {
    const result = solve(sampleProject())
    // Across all four solves. A uniform voxel field over the same flat would be six figures.
    expect(result.stats.graphNodes).toBeLessThan(20_000)
  })

  test('an empty project produces nothing rather than throwing', () => {
    const result = solve(createProject())
    expect(result.networks).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.bom).toEqual([])
  })

  test('collinear runs are merged, so fittings are not invented', () => {
    const waste = solve(sampleProject()).networks.find((n) => n.system === 'waste')!
    // No two segments meeting end to end may share an axis, size and load — that would be
    // one pipe reported as two, with a phantom coupling between them.
    const key = (p: { x: number; y: number; z: number }) =>
      `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
    // Compare real directions, not dominant axes: a 45° swept corner shares an axis with the
    // leg it joins without being collinear with it.
    const direction = (s: Segment) => {
      const length = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y, s.b.z - s.a.z) || 1
      return [(s.b.x - s.a.x) / length, (s.b.y - s.a.y) / length, (s.b.z - s.a.z) / length]
    }
    const collinear = (x: Segment, y: Segment) => {
      const [ax, ay, az] = direction(x)
      const [bx, by, bz] = direction(y)
      return Math.abs(ax * bx + ay * by + az * bz) > 0.999
    }
    const touching = new Map<string, Segment[]>()
    for (const segment of waste.segments) {
      for (const end of [segment.a, segment.b]) {
        const list = touching.get(key(end))
        if (list) list.push(segment)
        else touching.set(key(end), [segment])
      }
    }
    for (const [, group] of touching) {
      if (group.length !== 2) continue
      const [x, y] = group
      const redundant =
        collinear(x, y) && x.size === y.size && x.load === y.load && x.role === y.role
      expect(redundant).toBe(false)
    }
  })
})
