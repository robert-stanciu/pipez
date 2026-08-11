/**
 * More than one root.
 *
 * A house does not have to leave the ground in one place, and it does not have to be fed from
 * one board. Both are the same shape of problem — several roots, and a design decision about
 * which fixture belongs to which — and both are answered by the router rather than asked of
 * the user. These cases pin down that the answer is a real one: the networks come apart into
 * separate pieces, each piece is complete, and nothing is quietly left hanging.
 */

import { describe, expect, test } from 'vitest'

import { createServicePoint, relevel, sampleProject } from '../project.ts'
import { sortedLevels } from '../model.ts'
import type { Vec3 } from '../geometry/vec.ts'
import type { Network, Project } from '../types.ts'
import { solve } from './index.ts'

const key = (p: Vec3) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`

/** The separate pieces of a drawn network, as lists of their points. */
function pieces(network: Network): Vec3[][] {
  const points = new Map<string, Vec3>()
  const adjacent = new Map<string, string[]>()
  for (const segment of network.segments) {
    const [a, b] = [key(segment.a), key(segment.b)]
    points.set(a, segment.a)
    points.set(b, segment.b)
    adjacent.set(a, [...(adjacent.get(a) ?? []), b])
    adjacent.set(b, [...(adjacent.get(b) ?? []), a])
  }

  const seen = new Set<string>()
  const found: Vec3[][] = []
  for (const start of points.keys()) {
    if (seen.has(start)) continue
    const piece: Vec3[] = []
    const queue = [start]
    seen.add(start)
    while (queue.length > 0) {
      const at = queue.pop() as string
      piece.push(points.get(at) as Vec3)
      for (const next of adjacent.get(at) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    found.push(piece)
  }
  return found
}

/** The sample house with a second place for the drainage to leave, at the far corner. */
function twoOutlets(): Project {
  const project = sampleProject()
  const ground = sortedLevels(project)[0]
  // The far corner from the boiler-room outlet: under the kitchen, at the other end of the
  // house. The eastern half of the plan is genuinely closer to this than to the first.
  const kitchen = project.rooms.find((r) => r.name === 'Bucătărie')
  const second = createServicePoint('wasteOutlet', { x: 13500, y: 9500 }, ground, kitchen?.id ?? null)
  second.name = 'Waste outlet 2'
  second.z = ground.elevation - 450
  project.servicePoints.push(second)
  return relevel(project)
}

/** The sample house with a board of its own on the upper storey. */
function twoBoards(): Project {
  const project = sampleProject()
  const upper = sortedLevels(project)[1]
  const bedroom = project.rooms.find((r) => r.name === 'Dormitor 1')
  const second = createServicePoint('electricalPanel', { x: 7000, y: 2200 }, upper, bedroom?.id ?? null)
  second.name = 'Consumer unit 2'
  project.servicePoints.push(second)
  return relevel(project)
}

const wasteOf = (project: Project) =>
  solve(project).networks.find((n) => n.system === 'waste') as Network

describe('more than one waste outlet', () => {
  test('the drainage comes apart into one piece per outlet, and both are used', () => {
    const project = twoOutlets()
    const outlets = project.servicePoints.filter((s) => s.kind === 'wasteOutlet')
    expect(outlets.length).toBe(2)

    const parts = pieces(wasteOf(project))
    expect(parts.length).toBe(2)

    // Each piece falls to an outlet of its own. Positions are compared loosely because the
    // router snaps an outlet to the nearest node on its grid.
    const claimed = new Set<string>()
    for (const part of parts) {
      const low = part.reduce((best, p) => (p.z < best.z ? p : best))
      const outlet = outlets.find(
        (s) => !claimed.has(s.id) && Math.hypot(s.position.x - low.x, s.position.y - low.y) < 700,
      )
      expect(outlet, `no outlet near ${key(low)}`).toBeDefined()
      claimed.add((outlet as { id: string }).id)
    }
  })

  test('every fixture still reaches an outlet', () => {
    const waste = wasteOf(twoOutlets())
    expect(waste.unreachedFixtureIds).toEqual([])
  })

  test('splitting the outfall shortens the drainage rather than lengthening it', () => {
    // A second outlet can only ever be ignored, so the router must never come out worse for
    // having been offered one.
    const one = wasteOf(sampleProject()).totalLength
    const two = wasteOf(twoOutlets()).totalLength
    expect(two).toBeLessThanOrEqual(one)
  })

  test('a project with no outlet at all draws no drainage and says why', () => {
    const project = sampleProject()
    project.servicePoints = project.servicePoints.filter((s) => s.kind !== 'wasteOutlet')
    const result = solve(relevel(project))
    const waste = result.networks.find((n) => n.system === 'waste')
    expect(waste?.segments ?? []).toEqual([])
    expect(result.warnings.some((w) => w.system === 'waste')).toBe(true)
  })
})

describe('the air admittance valve', () => {
  test('every piece of drainage gets exactly one, at its own high point', () => {
    for (const project of [sampleProject(), twoOutlets()]) {
      const waste = wasteOf(project)
      const valves = waste.fittings.filter((f) => f.kind === 'aav')
      const parts = pieces(waste)
      expect(valves.length).toBe(parts.length)

      for (const valve of valves) {
        // Above everything, so air is admitted over the highest connection and not below it.
        const under = parts.find((part) =>
          part.some((p) => Math.round(p.x) === Math.round(valve.position.x) &&
            Math.round(p.y) === Math.round(valve.position.y)),
        )
        expect(under).toBeDefined()
        const highest = (under as Vec3[]).reduce((best, p) => (p.z > best.z ? p : best))
        expect(valve.position.z).toBeGreaterThan(highest.z - 1e-6)
      }
    }
  })

  test('the stub that carries it is drawn, is vertical, and hangs off the pipework', () => {
    const waste = wasteOf(sampleProject())
    const stubs = waste.segments.filter((s) => s.role === 'vent')
    expect(stubs.length).toBeGreaterThan(0)

    const elsewhere = waste.segments.filter((s) => s.role !== 'vent')
    for (const stub of stubs) {
      expect(Math.hypot(stub.b.x - stub.a.x, stub.b.y - stub.a.y)).toBeLessThan(1)
      expect(stub.a.z).toBeGreaterThan(stub.b.z)
      // The bottom of the stub is a point the drainage actually reaches.
      expect(elsewhere.some((s) => key(s.a) === key(stub.b) || key(s.b) === key(stub.b))).toBe(true)
    }
  })

  test('it is the size of the pipe it sits on, so the schedule has no phantom reducer', () => {
    const waste = wasteOf(sampleProject())
    for (const stub of waste.segments.filter((s) => s.role === 'vent')) {
      const below = waste.segments.filter(
        (s) => s.role !== 'vent' && (key(s.a) === key(stub.b) || key(s.b) === key(stub.b)),
      )
      expect(below.length).toBeGreaterThan(0)
      expect(stub.size).toBe(Math.max(...below.map((s) => s.size)))
    }
  })
})

describe('more than one board', () => {
  test('a board is designed for each, and exactly one of them is the main', () => {
    const project = twoBoards()
    const result = solve(project)
    expect(result.panels.length).toBe(2)
    expect(result.panels.filter((p) => p.isMain).length).toBe(1)

    // The main board is the one on the lowest storey — that is where the supply arrives.
    expect(result.panels.find((p) => p.isMain)?.levelId).toBe(sortedLevels(project)[0].id)
  })

  test('no circuit spans two boards', () => {
    const result = solve(twoBoards())
    const boardOf = new Map(
      result.panels.flatMap((panel) => panel.ways.map((way) => [way.circuit.id, panel.id])),
    )
    for (const circuit of result.circuits) {
      expect(circuit.panelId).toBeTruthy()
      // A circuit appears on the schedule of the board it hangs off, and only that one.
      expect(boardOf.get(circuit.id)).toBe(circuit.panelId)
    }
  })

  test('a sub-board is fed by a submain sized for it', () => {
    const result = solve(twoBoards())
    for (const panel of result.panels.filter((p) => !p.isMain)) {
      expect(panel.submainMm2).toBeGreaterThan(0)
      expect(panel.submainLength).toBeGreaterThan(0)
    }
    expect(result.panels.find((p) => p.isMain)?.submainMm2).toBeNull()
  })

  test('a second board takes load off the first', () => {
    const one = solve(sampleProject())
    const two = solve(twoBoards())
    const ways = (r: typeof one) => r.panels.reduce((sum, p) => sum + p.ways.length, 0)
    // The same circuits, dealt between two boards rather than crammed into one.
    expect(ways(two)).toBeGreaterThanOrEqual(ways(one))
    const mainWays = two.panels.find((p) => p.isMain)?.ways.length ?? 0
    expect(mainWays).toBeLessThan(ways(two))
  })
})

describe('where the cables run', () => {
  const heightsOf = (project: Project) => {
    const power = solve(project).networks.find((n) => n.system === 'power') as Network
    return power.segments
      // Only the distribution runs: the drops to each point cross the whole wall either way.
      .filter((s) => Math.abs(s.a.z - s.b.z) < 1 && s.role !== 'stack')
      .map((s) => s.a.z)
  }

  test('under the floor keeps the distribution low; along the ceiling keeps it high', () => {
    const low = sampleProject()
    low.settings.electrical.cableRoute = 'floor'
    const high = sampleProject()
    high.settings.electrical.cableRoute = 'ceiling'

    const lowest = heightsOf(relevel(low))
    const highest = heightsOf(relevel(high))
    expect(lowest.length).toBeGreaterThan(0)
    expect(highest.length).toBeGreaterThan(0)

    // Compared as averages: both layouts still have to reach every point, so the difference
    // is in where the horizontal runs sit, not in every single segment.
    const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length
    expect(mean(lowest)).toBeLessThan(mean(highest))
  })

  test('the choice changes the wiring but not the schedule', () => {
    const low = relevel(sampleProject())
    low.settings.electrical.cableRoute = 'floor'
    const high = relevel(sampleProject())
    high.settings.electrical.cableRoute = 'ceiling'

    const kinds = (project: Project) =>
      solve(project)
        .circuits.map((c) => `${c.kind}:${c.fixtureIds.length}`)
        .sort()
    expect(kinds(low)).toEqual(kinds(high))
  })
})
