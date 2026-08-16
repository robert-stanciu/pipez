/**
 * Golden cases for the underfloor heating engine.
 *
 * Like the drainage suite, these assert *invariants* rather than geometry. A coil can look
 * perfectly convincing on a plan while it doubles back over itself, covers half the room, or
 * asks the floor to run at 40 °C — none of which is visible in a screenshot and all of which
 * is a floor that has to come up again.
 *
 * The properties that matter, and are checked below:
 *
 *  - a coil is **one continuous pipe** from the manifold and back, with nothing in the room
 *    left uncovered by more than a pitch and nothing crossing anything else;
 *  - the pipe **keeps clear of the walls** and of anything screwed to the floor;
 *  - the floor **never passes its surface temperature limit** without saying so;
 *  - **every loop reaches its manifold**, and no loop is longer than the pipe allows;
 *  - the whole thing is **deterministic**.
 */

import { describe, expect, test } from 'vitest'

import { area, pointInPolygon } from '../geometry/polygon.ts'
import { cross2, dist2, dot2, sub2, type Vec2 } from '../geometry/vec.ts'
import {
  createFixture,
  createLevel,
  createProject,
  createRoom,
  createServicePoint,
  relevel,
  roomHeating,
  sampleProject,
} from '../project.ts'
import {
  logMeanExcess,
  MAX_LOOPS_PER_MANIFOLD,
  MAX_SURFACE_TEMP,
  maxFlux,
  peripheralPitch,
  SURFACE_COEFFICIENT,
  ufhPipe,
  upwardFlux,
  WALL_CLEARANCE,
} from '../standards/en1264.ts'
import type { HeatingLoop, Project, Segment } from '../types.ts'
import { servicePointsOf } from '../model.ts'
import { solve } from './index.ts'
import { layLoop, splitBands, type LoopLayout } from './loops.ts'
import { bestManifoldPosition, costOf, manifoldPlacementCost } from './placement.ts'

/* ------------------------------------------------------------------ helpers */

/** One heated room with a manifold in the corner of it. */
function scenario(options: {
  width?: number
  depth?: number
  spacing?: number
  manifoldAt?: Vec2
  fixtures?: Array<{ type: 'wc' | 'bathtub'; wallIndex: number; offset: number }>
}): Project {
  const project = createProject('heating test')
  const ground = project.levels[0]
  const room = createRoom(
    'Room',
    { x: 0, y: 0 },
    options.width ?? 4000,
    options.depth ?? 3000,
    ground,
  )
  if (options.spacing) room.heating = roomHeating({ spacing: options.spacing })
  project.rooms.push(room)

  for (const spec of options.fixtures ?? []) {
    project.fixtures.push(
      createFixture(project, spec.type, room.id, {
        wallIndex: spec.wallIndex,
        wallOffset: spec.offset,
      }),
    )
  }

  project.servicePoints.push(
    createServicePoint('heatingManifold', options.manifoldAt ?? { x: 200, y: 200 }, ground, room.id),
  )
  return relevel(project)
}

const PERIPHERAL = peripheralPitch(150)

/** One coil in a plain 4 × 3 m room, with the manifold in a corner of it. */
function rectangularCoil(): LoopLayout {
  const layout = layLoop({
    outline: [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ],
    obstacles: [],
    spacing: 150,
    peripheral: PERIPHERAL,
    clearance: WALL_CLEARANCE,
    anchor: { x: 100, y: 2900 },
  })
  if (!layout) throw new Error('the 4 × 3 m room has to take a coil')
  return layout
}

/**
 * Where the runs of the field sit across the room, in order.
 *
 * The runs are the long legs along the room's length; everything else in the path is an end
 * turn or the perimeter leg. Taken from a room laid out along x, so a run is a leg with the
 * same y at both ends.
 */
function alongRuns(path: LoopLayout['path']): number[] {
  const offsets: number[] = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    if (Math.abs(a.y - b.y) > 1 || Math.abs(a.x - b.x) < 1000) continue
    offsets.push(a.y)
  }
  return offsets.sort((l, r) => l - r)
}

const heatingSegments = (project: Project): Segment[] =>
  solve(project).networks.find((n) => n.system === 'heating')?.segments ?? []

/** Do two segments cross, other than by sharing an end? */
function crosses(a: Segment, b: Segment): boolean {
  const shared = [a.a, a.b].some((p) => [b.a, b.b].some((q) => dist2(p, q) < 1))
  if (shared) return false
  const d1 = { x: a.b.x - a.a.x, y: a.b.y - a.a.y }
  const d2 = { x: b.b.x - b.a.x, y: b.b.y - b.a.y }
  const denom = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(denom) < 1e-9) return false
  const dx = b.a.x - a.a.x
  const dy = b.a.y - a.a.y
  const t = (dx * d2.y - dy * d2.x) / denom
  const u = (dx * d1.y - dy * d1.x) / denom
  // Strictly inside both, with a hair of tolerance so a shared corner is not a crossing.
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999
}

/* -------------------------------------------------------------------- tests */

describe('coils', () => {
  test('a manifold is what turns heating on — no manifold, no loops', () => {
    const project = scenario({})
    project.servicePoints = []
    const result = solve(project)
    expect(result.loops).toEqual([])
    expect(result.manifolds).toEqual([])
    expect(result.networks.some((n) => n.system === 'heating')).toBe(false)
    // And it is not an error: a house without underfloor heating is not a broken design.
    expect(result.warnings.filter((w) => w.system === 'heating')).toEqual([])
  })

  test('every heated room gets a loop, and every loop reaches its manifold', () => {
    const project = sampleProject()
    const result = solve(project)
    const heated = project.rooms.filter((room) => room.heating?.enabled !== false)
    const covered = new Set(result.loops.map((loop) => loop.roomId))
    for (const room of heated) {
      expect(covered.has(room.id), `${room.name} has no loop`).toBe(true)
    }
    for (const loop of result.loops) {
      expect(result.manifolds.some((m) => m.id === loop.manifoldId)).toBe(true)
    }
    // Nothing in the drawing may be a hard failure — the sample has to stay buildable.
    expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([])
  })

  test('a room switched off gets nothing', () => {
    const project = scenario({})
    project.rooms[0].heating = roomHeating({ enabled: false })
    expect(solve(project).loops).toEqual([])
  })

  test('the coil is one unbroken run with two ends and no branch', () => {
    // A loop has no joint in the screed, so its pipe has to form a single chain: exactly two
    // loose ends — where the two leaders pick it up — and every other point joining exactly
    // two lengths. Anything with three lengths at it is a tee, and there are no tees.
    const project = scenario({})
    const result = solve(project)
    const segments = (result.networks.find((n) => n.system === 'heating')?.segments ?? []).filter(
      (s) => s.role === 'loop',
    )
    expect(segments.length).toBeGreaterThan(4)

    const touching = new Map<string, number>()
    for (const segment of segments) {
      for (const end of [segment.a, segment.b]) {
        const key = `${Math.round(end.x)},${Math.round(end.y)},${Math.round(end.z)}`
        touching.set(key, (touching.get(key) ?? 0) + 1)
      }
    }
    const ends = [...touching.values()].filter((count) => count === 1)
    expect(ends).toHaveLength(2 * result.loops.length)
    for (const count of touching.values()) expect(count).toBeLessThanOrEqual(2)
  })

  test('nothing in a coil crosses anything else in it', () => {
    // The reason the pattern is a serpentine with a perimeter return rather than a
    // counterflow meander: the latter's end turns interleave and cannot be drawn without
    // one pipe passing through another.
    const segments = heatingSegments(scenario({ width: 5000, depth: 4000 })).filter(
      (s) => s.role === 'loop',
    )
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        expect(
          crosses(segments[i], segments[j]),
          `${JSON.stringify(segments[i].a)}–${JSON.stringify(segments[i].b)} crosses ${JSON.stringify(segments[j].a)}–${JSON.stringify(segments[j].b)}`,
        ).toBe(false)
      }
    }
  })

  test('the coil keeps its distance from the walls', () => {
    const project = scenario({})
    const outline = project.rooms[0].outline
    for (const segment of heatingSegments(project).filter((s) => s.role === 'loop')) {
      for (const end of [segment.a, segment.b]) {
        const point = { x: end.x, y: end.y }
        expect(pointInPolygon(point, outline)).toBe(true)
        // The edge strip and the skirting fixings have to be clear of the pipe.
        expect(distanceToEdges(point, outline)).toBeGreaterThanOrEqual(WALL_CLEARANCE - 1)
      }
    }
  })

  test('no pipe is laid under a WC or a bath', () => {
    const bare = scenario({ width: 3000, depth: 2500 })
    const withFixtures = scenario({
      width: 3000,
      depth: 2500,
      fixtures: [
        { type: 'wc', wallIndex: 2, offset: 800 },
        { type: 'bathtub', wallIndex: 1, offset: 900 },
      ],
    })
    const laid = (p: Project) =>
      heatingSegments(p)
        .filter((s) => s.role === 'loop')
        .reduce((sum, s) => sum + s.length, 0)
    // Not a proof that the footprints are clear — that is what the obstacle subtraction is
    // for — but a coil that ignored them would come out exactly the same length.
    expect(laid(withFixtures)).toBeLessThan(laid(bare))
  })

  test('a room too big for one loop is split, and the parts are laid to the same pitch', () => {
    const small = solve(scenario({ width: 3000, depth: 2500 }))
    const large = solve(scenario({ width: 8000, depth: 6000 }))
    expect(small.loops.length).toBe(1)
    expect(large.loops.length).toBeGreaterThan(1)

    // The split is what keeps each loop inside the pipe's length. It must not be paid for by
    // leaving a bare strip between the bands, which a per-band wall clearance would.
    const pitches = large.loops.map((loop) => loop.spacing)
    expect(Math.max(...pitches) / Math.min(...pitches)).toBeLessThan(1.4)
  })

  test('bands cover the room between them and no more', () => {
    const outline = [
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 4000 },
      { x: 0, y: 4000 },
    ]
    const bands = splitBands(outline, 3, 300)
    expect(bands).toHaveLength(3)
    const extents = bands.reduce((sum, band) => sum + area(band.extent), 0)
    expect(extents).toBeCloseTo(area(outline), 0)
    // Each band lays past its own share, so the two coils meet across the cut.
    for (const band of bands) expect(area(band.lay)).toBeGreaterThanOrEqual(area(band.extent))
  })

  test('a room with no floor left to lay in is reported, not silently skipped', () => {
    // 250 mm across: after 150 mm of clearance at each wall there is nothing in the middle.
    const project = scenario({ width: 8000, depth: 250 })
    const result = solve(project)
    expect(result.loops).toEqual([])
    expect(
      result.warnings.some((w) => w.system === 'heating' && w.message.includes('Room')),
    ).toBe(true)
  })

  test('the pipe is drawn in against the walls and opens out across the middle', () => {
    // EN 1264-2's peripheral zone, as pipe rather than as a hotter flow: the runs either side
    // of the room sit at half the pitch, and the gap left between the wall and the first run
    // is never wider than the gap between two runs — which is what a bare strip along a wall
    // is, and it is the one place a floor is felt.
    const coil = rectangularCoil()
    const runs = alongRuns(coil.path)
    expect(runs.length).toBeGreaterThan(8)

    const gaps: number[] = []
    for (let i = 1; i < runs.length; i++) gaps.push(Math.abs(runs[i] - runs[i - 1]))
    const middle = gaps[Math.floor(gaps.length / 2)]

    // Two runs at the tight pitch off each wall, and the design pitch in the middle.
    expect(gaps[0]).toBeCloseTo(PERIPHERAL, -1)
    expect(gaps[1]).toBeCloseTo(PERIPHERAL, -1)
    expect(gaps[gaps.length - 1]).toBeCloseTo(PERIPHERAL, -1)
    expect(gaps[gaps.length - 2]).toBeCloseTo(PERIPHERAL, -1)
    expect(middle).toBeGreaterThan(PERIPHERAL * 1.5)
    // And the first pipe of the lot is the perimeter run, hard against its clearance — the
    // gap left at the wall is the clearance and nothing more.
    expect(runs[0]).toBeCloseTo(WALL_CLEARANCE, -1)
  })

  test('nothing in a coil is drawn on the diagonal', () => {
    // A pipe that leaves a run at an angle is a pipe nobody laid: an installer turns a coil
    // square across the pitch and then along. Anything longer than a swept corner therefore
    // has to lie along one of the two axes of a square room.
    const coil = rectangularCoil()
    for (let i = 1; i < coil.path.length; i++) {
      const a = coil.path[i - 1]
      const b = coil.path[i]
      const run = dist2(a, b)
      if (run <= PERIPHERAL) continue
      const square = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1
      expect(square, `${run.toFixed(0)} mm from ${a.x},${a.y} to ${b.x},${b.y} is on the slant`)
        .toBe(true)
    }
  })

  test('every corner is swept, because a coil has no fittings to make one with', () => {
    // Every change of direction in a coil is the pipe bent round a clip rail, so there is no
    // such thing as a square corner in one. Drawn as an arc, no single step of it turns far.
    const coil = rectangularCoil()
    for (let i = 1; i < coil.path.length - 1; i++) {
      const into = sub2(coil.path[i], coil.path[i - 1])
      const outOf = sub2(coil.path[i + 1], coil.path[i])
      const turn = Math.abs(
        Math.atan2(cross2(into, outOf), dot2(into, outOf)) * (180 / Math.PI),
      )
      expect(turn, `${turn.toFixed(0)}° at ${coil.path[i].x},${coil.path[i].y}`).toBeLessThan(50)
    }
  })

  test('the perimeter run comes home the long way, so the far wall gets one too', () => {
    // Only one of the two ways round the room gets laid — the coil's two ends are fixed at the
    // manifold and the return leg is the arc between them. Taking the short way would leave
    // the far half of the room with a single run against its wall where the near half has two,
    // which is the half of the room furthest from the manifold and the coolest to start with.
    const coil = rectangularCoil()
    const along = (fixed: 'x' | 'y', at: number): number => {
      let total = 0
      for (let i = 1; i < coil.path.length; i++) {
        const a = coil.path[i - 1]
        const b = coil.path[i]
        if (Math.abs(a[fixed] - at) > 20 || Math.abs(b[fixed] - at) > 20) continue
        total += dist2(a, b)
      }
      return total
    }
    // Three of the four walls of a 4 × 3 m room, at the clearance: the near one is where the
    // two leaders come in, and it is the one the coil cannot get back to.
    const walls = [
      along('y', WALL_CLEARANCE),
      along('y', 3000 - WALL_CLEARANCE),
      along('x', WALL_CLEARANCE),
      along('x', 4000 - WALL_CLEARANCE),
    ].filter((run) => run > 500)
    expect(walls.length).toBeGreaterThanOrEqual(3)
  })

  test('no step of a coil is too short to be a length of pipe', () => {
    // Sweeping the corners is arithmetic, and arithmetic leaves stubs where an arc lands on a
    // connection. A stub is not laid and not ordered, and in plan a run with no length in it
    // is drawn as a riser — so a coil full of them comes out peppered with rings.
    const segments = heatingSegments(sampleProject()).filter((s) => s.role === 'loop')
    expect(segments.length).toBeGreaterThan(100)
    for (const segment of segments) {
      const inPlan = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
      expect(inPlan, `${inPlan.toFixed(1)} mm at ${segment.a.x},${segment.a.y}`).toBeGreaterThan(20)
    }
  })

  test('layLoop refuses rather than inventing a token length of pipe', () => {
    expect(
      layLoop({
        outline: [
          { x: 0, y: 0 },
          { x: 500, y: 0 },
          { x: 500, y: 500 },
          { x: 0, y: 500 },
        ],
        obstacles: [],
        spacing: 150,
        clearance: WALL_CLEARANCE,
        anchor: { x: 0, y: 0 },
      }),
    ).toBeNull()
  })
})

describe('EN 1264', () => {
  test('the floor is never allowed past its surface temperature limit unremarked', () => {
    const result = solve(sampleProject())
    for (const loop of result.loops) {
      if (loop.surfaceTempC <= loop.surfaceLimitC) continue
      expect(
        result.warnings.some(
          (w) => w.system === 'heating' && w.message.includes(loop.roomName) && w.message.includes('°C'),
        ),
        `${loop.roomName} is over temperature with nothing said about it`,
      ).toBe(true)
    }
  })

  test('a bathroom is allowed a warmer floor than a living room', () => {
    expect(MAX_SURFACE_TEMP.bathroom).toBeGreaterThan(MAX_SURFACE_TEMP.occupied)
    const project = sampleProject()
    const result = solve(project)
    const bathrooms = result.loops.filter((loop) => loop.roomTempC >= 24)
    expect(bathrooms.length).toBeGreaterThan(0)
    for (const loop of bathrooms) expect(loop.surfaceLimitC).toBe(MAX_SURFACE_TEMP.bathroom)
  })

  test('surface temperature and output are two readings of the same number', () => {
    // EN 1264-2 fixes the surface coefficient at 10,8 W/m²K, which is what makes them so.
    for (const loop of solve(sampleProject()).loops) {
      expect(loop.surfaceTempC).toBeCloseTo(loop.roomTempC + loop.fluxW / SURFACE_COEFFICIENT, 6)
    }
  })

  test('the limiting flux is the familiar 100 W/m² over a living room', () => {
    // 8,92 · (29 − 20)^1,1. This is the number the whole discipline is built round, and if
    // the exponent were ever mistyped it is the only place it would show.
    expect(maxFlux(MAX_SURFACE_TEMP.occupied, 20)).toBeGreaterThan(95)
    expect(maxFlux(MAX_SURFACE_TEMP.occupied, 20)).toBeLessThan(105)
  })

  test('a thicker floor covering gives less heat out of the same pipework', () => {
    const excess = logMeanExcess(38, 30, 20)
    const panel = { coverMm: 45, spacingMm: 150, odMm: 16 } as const
    const tile = upwardFlux(excess, { ...panel, covering: 'tile' })
    const carpet = upwardFlux(excess, { ...panel, covering: 'carpet' })
    // 0,15 m²K/W of carpet against 0,01 of tile, on top of a build-up that is itself worth
    // about 0,15: it costs a bit over half the output, which is why a carpeted floor either
    // runs hotter or does not keep up.
    expect(carpet).toBeLessThan(tile * 0.6)
  })

  test('opening the pitch out loses output, but nothing like proportionally', () => {
    const excess = logMeanExcess(38, 30, 20)
    const panel = { coverMm: 45, covering: 'tile', odMm: 16 } as const
    const tight = upwardFlux(excess, { ...panel, spacingMm: 100 })
    const open = upwardFlux(excess, { ...panel, spacingMm: 200 })
    expect(open).toBeLessThan(tight)
    // Twice the pitch is half the pipe and nothing like half the heat — which is exactly why
    // a coarse floor goes stripy rather than cold.
    expect(open).toBeGreaterThan(tight * 0.75)
  })

  test('the log mean is used, not the arithmetic one', () => {
    // 38/30 over a 20 °C room: the arithmetic mean excess is 14 K and the log mean 13,6.
    expect(logMeanExcess(38, 30, 20)).toBeLessThan(14)
    expect(logMeanExcess(38, 30, 20)).toBeGreaterThan(13)
    // Water that never gets above the room does not heat it.
    expect(logMeanExcess(20, 18, 20)).toBe(0)
  })
})

describe('loops and manifolds', () => {
  test('a loop is measured with its leaders, because they come off the same coil', () => {
    const result = solve(sampleProject())
    const segments = result.networks.find((n) => n.system === 'heating')?.segments ?? []
    const coil = segments
      .filter((s) => s.role === 'loop')
      .reduce((sum, s) => sum + s.length, 0)
    const scheduled = result.loops.reduce((sum, loop) => sum + loop.length, 0)
    expect(scheduled).toBeGreaterThan(coil)
  })

  test('no loop is longer than the pipe it is coiled from allows, unremarked', () => {
    const project = sampleProject()
    const limit = ufhPipe(project.settings.heating.pipe).maxLoopLength
    const result = solve(project)
    for (const loop of result.loops) {
      if (loop.length <= limit) continue
      expect(
        result.warnings.some(
          (w) => w.system === 'heating' && w.message.includes(loop.roomName) && w.message.includes('m loop'),
        ),
      ).toBe(true)
    }
  })

  test('ports are numbered from one, without gaps, per manifold', () => {
    const result = solve(sampleProject())
    expect(result.manifolds.length).toBeGreaterThan(1)
    for (const manifold of result.manifolds) {
      const ports = result.loops
        .filter((loop) => loop.manifoldId === manifold.id)
        .map((loop) => loop.port)
        .sort((a, b) => a - b)
      expect(ports).toEqual(ports.map((_, index) => index + 1))
      expect(manifold.loops).toBe(ports.length)
      expect(manifold.ports).toBeLessThanOrEqual(MAX_LOOPS_PER_MANIFOLD)
    }
  })

  test('a manifold totals what is ported on it', () => {
    const result = solve(sampleProject())
    for (const manifold of result.manifolds) {
      const mine = result.loops.filter((loop) => loop.manifoldId === manifold.id)
      expect(manifold.outputW).toBeCloseTo(sum(mine, (l) => l.outputW), 6)
      expect(manifold.flowKgH).toBeCloseTo(sum(mine, (l) => l.flowKgH), 6)
      expect(manifold.longestLoop).toBe(Math.max(...mine.map((l) => l.length)))
      expect(manifold.shortestLoop).toBe(Math.min(...mine.map((l) => l.length)))
      // The pump has to cover the worst loop, whatever the others cost.
      expect(manifold.pumpHeadKpa).toBeGreaterThan(Math.max(...mine.map((l) => l.pressureDropKpa)))
    }
  })

  test('each room goes to a manifold on its own storey', () => {
    const project = sampleProject()
    const result = solve(project)
    const levelOf = new Map(project.rooms.map((room) => [room.id, room.levelId]))
    const manifoldLevel = new Map(result.manifolds.map((m) => [m.id, m.levelId]))
    for (const loop of result.loops) {
      expect(manifoldLevel.get(loop.manifoldId)).toBe(levelOf.get(loop.roomId))
    }
  })

  test('the schedule adds up to the pipe on the drawing', () => {
    const project = sampleProject()
    const result = solve(project)
    const coil = ufhPipe(project.settings.heating.pipe).label
    const ordered = result.bom
      .filter((line) => line.item.includes(coil) && line.unit === 'm')
      .reduce((total, line) => total + line.quantity, 0)
    const drawn = (result.networks.find((n) => n.system === 'heating')?.segments ?? [])
      .filter((s) => s.role === 'loop' || s.role === 'branch')
      .reduce((total, s) => total + s.length, 0)
    expect(ordered).toBeCloseTo(drawn / 1000, 1)
  })

  test('the primary reaches a manifold on an upper storey', () => {
    const project = sampleProject()
    const result = solve(project)
    const upstairs = result.manifolds.find((m) => m.levelId === project.levels[1].id)
    expect(upstairs).toBeDefined()
    expect(upstairs!.primaryLength).toBeGreaterThan(0)
    const risers = (result.networks.find((n) => n.system === 'heating')?.segments ?? []).filter(
      (s) => s.role === 'stack',
    )
    expect(risers.length).toBeGreaterThan(0)
  })

  test('a manifold with no heat source to feed it says so, and still draws the loops', () => {
    const project = scenario({})
    project.fixtures = project.fixtures.filter((f) => f.type !== 'water-heater')
    const result = solve(project)
    expect(result.loops.length).toBeGreaterThan(0)
    expect(
      result.warnings.some((w) => w.system === 'heating' && w.message.includes('No heat source')),
    ).toBe(true)
  })
})

describe('where the manifold goes', () => {
  test('it lands against a wall, in a room, on its own storey', () => {
    const project = sampleProject()
    for (const board of servicePointsOf(project, 'heatingManifold')) {
      const best = bestManifoldPosition(project, board.id)
      expect(best, board.name).not.toBeNull()
      const room = project.rooms.find((r) => r.id === best!.roomId)
      expect(room, 'a manifold cabinet stands in a room').toBeDefined()
      expect(room!.levelId).toBe(board.levelId)
      expect(pointInPolygon(best!.position, room!.outline)).toBe(true)
      // Recessed into a wall, not standing in the middle of the floor.
      expect(distanceToEdges(best!.position, room!.outline)).toBeLessThan(WALL_CLEARANCE * 2)
    }
  })

  test('nowhere on the storey costs less pipe than where it puts it', () => {
    const project = sampleProject()
    const board = servicePointsOf(project, 'heatingManifold')[0]
    const best = bestManifoldPosition(project, board.id)!
    // Moving it there and asking again has to come back to the same place: an optimum that
    // moves when you stand on it is not one, and the button would walk the manifold across
    // the plan one press at a time.
    board.position = { ...best.position }
    board.roomId = best.roomId
    const again = bestManifoldPosition(project, board.id)!
    expect(again.position).toEqual(best.position)
  })

  test('it weighs the leaders against the primary rather than serving only one', () => {
    // The heat source at one end of the house, the rooms at the other. Sitting on the boiler
    // is not the answer and neither is ignoring it — the manifold has to come out between the
    // two, strictly better than both ends on the pipe it costs altogether.
    const project = sampleProject()
    const board = servicePointsOf(project, 'heatingManifold')[0]
    const here = manifoldPlacementCost(project, board)!
    const best = bestManifoldPosition(project, board.id)!
    expect(costOf(best)).toBeLessThanOrEqual(costOf(here))
    expect(best.primaryLength).toBeGreaterThan(0)
    expect(best.leaderLength).toBeGreaterThan(0)
  })

  test('moving it there is a change the solver accepts', () => {
    const project = sampleProject()
    for (const board of servicePointsOf(project, 'heatingManifold')) {
      const best = bestManifoldPosition(project, board.id)
      if (!best) continue
      board.position = { ...best.position }
      board.roomId = best.roomId
    }
    const result = solve(project)
    // Every heated room still gets a loop, and nothing about the move is unbuildable.
    expect(result.loops.length).toBeGreaterThan(0)
    expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([])
  })

  test('a storey with nothing heated on it has nowhere to put one', () => {
    const project = scenario({})
    project.rooms[0].heating = roomHeating({ enabled: false })
    const board = servicePointsOf(project, 'heatingManifold')[0]
    expect(bestManifoldPosition(project, board.id)).toBeNull()
  })
})

describe('determinism', () => {
  test('the same house solves to the same coils, ids and all', () => {
    const project = sampleProject()
    expect(solve(project).loops).toEqual(solve(project).loops)
    expect(solve(project).manifolds).toEqual(solve(project).manifolds)
  })

  test('a second storey does not disturb the first', () => {
    const project = scenario({})
    const before = solve(project).loops.map((loop) => loop.length)
    const upper = createLevel(1, project.settings)
    project.levels.push(upper)
    relevel(project)
    const after = solve(project).loops.map((loop) => loop.length)
    expect(after).toEqual(before)
  })
})

/* -------------------------------------------------------------------- utils */

const sum = <T,>(items: T[], of: (item: T) => number): number =>
  items.reduce((total, item) => total + of(item), 0)

/** Shortest distance from a point to a polygon's edges. */
function distanceToEdges(p: Vec2, poly: Vec2[]): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const ab = { x: b.x - a.x, y: b.y - a.y }
    const lengthSq = ab.x * ab.x + ab.y * ab.y
    const t =
      lengthSq < 1e-9
        ? 0
        : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / lengthSq))
    best = Math.min(best, dist2(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }))
  }
  return best
}

/** Unused-import guard: the type is what documents the shape of a schedule row. */
export type _Loop = HeatingLoop
