/**
 * Pressurised water supply — cold and hot, routed independently but by the same method.
 *
 * Supply is much freer than drainage: it is pumped, so it can climb, and the practical
 * arrangement is a distribution run in each storey's ceiling void with a drop to every
 * fixture, plus a rising main between storeys. That is what this builds — one horizontal
 * tree per floor, joined vertically — which keeps each search two-dimensional and the result
 * buildable.
 *
 * Like the soil stack, the rising main is not placed. Crossing a slab is expensive and only
 * allowed inside a wall present on both storeys, so the reuse discount collects the upstairs
 * branches onto one riser.
 *
 * Where a water heater is present it becomes the *source* of the hot network rather than a
 * consumer of it, and its own cold feed joins the cold tree.
 */

import { fixtureDef } from '../catalog/fixtures.ts'
import { dist3, to3, type Vec2, type Vec3 } from '../geometry/vec.ts'
import {
  fixturePorts,
  portsOfSystem,
  servicePointOf,
  sortedLevels,
  type ResolvedPort,
} from '../model.ts'
import { MAX_HOT_DEAD_LEG, supplyDiameter } from '../standards/en806.ts'
import type { Project, RoutingWarning, Segment, SystemKind } from '../types.ts'
import { deriveFittings, mergeCollinear } from './fittings.ts'
import { RouteGraph } from './graph.ts'
import {
  attachTerminal,
  buildPlaneGrid,
  linkStoreys,
  planLines,
  type Layer,
  type LevelShapes,
} from './layers.ts'
import { buildTree, treeLinks, type Terminal } from './steiner.ts'
import type { SystemSolution } from './waste.ts'

/** Height of a storey's distribution plane below its own ceiling. */
const DISTRIBUTION_DROP = 150

/** Slab crossings are dear, so the branches gather onto one rising main. */
const SLAB_CROSSING_WEIGHT = 10

export function routeSupply(
  project: Project,
  shapes: LevelShapes,
  system: 'cold' | 'hot',
  nextId: () => string,
): SystemSolution {
  const warnings: RoutingWarning[] = []
  const empty = (): SystemSolution => ({
    network: { system, segments: [], fittings: [], totalLength: 0, unreachedFixtureIds: [] },
    warnings,
    graphNodes: 0,
    graphEdges: 0,
  })

  const heater = project.fixtures.find((f) => f.type === 'water-heater') ?? null
  const heaterHotPort = heater
    ? (fixturePorts(project, heater).find((p) => p.kind === 'hot') ?? null)
    : null

  // The heater generates hot water, so it is the root of the hot tree, never a draw-off.
  const consumers = portsOfSystem(project, system).filter(
    (p) =>
      !(
        system === 'hot' &&
        heaterHotPort &&
        p.portId === heaterHotPort.portId &&
        p.fixtureId === heaterHotPort.fixtureId
      ),
  )
  if (consumers.length === 0) return empty()

  const entry = servicePointOf(project, 'waterEntry')
  const sourcePoint: Vec3 | null =
    system === 'hot' && heaterHotPort
      ? heaterHotPort.position
      : entry
        ? to3(entry.position, entry.z)
        : null

  if (!sourcePoint) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system,
      message:
        system === 'hot'
          ? 'No hot water source. Place a water heater, or a water entry to feed from.'
          : 'No water entry placed. Drop one on the plan to feed the cold network.',
    })
    return empty()
  }

  const levels = sortedLevels(project)
  const graph = new RouteGraph()
  const attachAt: Vec2[] = [
    ...consumers.map((p) => ({ x: p.position.x, y: p.position.y })),
    { x: sourcePoint.x, y: sourcePoint.y },
  ]
  const lines = planLines(project, attachAt)

  const planeOf = new Map<string, Layer>()
  for (const level of levels) {
    const shape = shapes.byLevelId.get(level.id)
    if (!shape || shape.walls.length === 0) continue
    planeOf.set(
      level.id,
      buildPlaneGrid(graph, project, shape, {
        z: level.elevation + level.height - DISTRIBUTION_DROP,
        lines,
        penetrationWeight: 4,
        allowLoadBearingPenetration: true,
      }),
    )
  }

  const slabEdges = new Set<number>()
  for (let i = 1; i < levels.length; i++) {
    const lower = planeOf.get(levels[i - 1].id)
    const upper = planeOf.get(levels[i].id)
    const lowerShape = shapes.byLevelId.get(levels[i - 1].id)
    const upperShape = shapes.byLevelId.get(levels[i].id)
    if (!lower || !upper || !lowerShape || !upperShape) continue
    for (const id of linkStoreys(
      graph,
      { layer: lower, shape: lowerShape },
      { layer: upper, shape: upperShape },
      SLAB_CROSSING_WEIGHT,
    )) {
      slabEdges.add(id)
    }
  }

  const planeFor = (z: number): Layer | null => {
    // Attach a point to the storey it physically sits on.
    let best: Layer | null = null
    let bestGap = Infinity
    for (const level of levels) {
      const plane = planeOf.get(level.id)
      if (!plane) continue
      const gap = z >= level.elevation ? z - level.elevation : Infinity
      if (gap < bestGap) {
        bestGap = gap
        best = plane
      }
    }
    return best ?? planeOf.get(levels[0]?.id ?? '') ?? null
  }

  const sourcePlane = planeFor(sourcePoint.z)
  const root = sourcePlane ? attachTerminal(graph, sourcePlane, sourcePoint) : null
  if (root === null) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system,
      message: 'The water source is outside the building footprint.',
      position: sourcePoint,
    })
    return empty()
  }

  const terminals: Terminal[] = []
  const byNode = new Map<number, ResolvedPort>()
  for (const port of consumers) {
    const plane = planeFor(port.position.z)
    const node = plane ? attachTerminal(graph, plane, port.position) : null
    if (node === null) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system,
        message: `${port.fixtureName} sits outside the building footprint.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
      continue
    }
    terminals.push({ ref: port.fixtureId, node, load: luOf(project, port, system), minSize: port.dn })
    byNode.set(node, port)
  }

  const tree = buildTree(graph, root, terminals, { turnPenalty: 300, reuseDiscount: 0.1 })

  for (const missed of tree.unreached) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system,
      message: `No ${system} water route to ${byNode.get(missed.node)?.fixtureName ?? 'a fixture'}. Check that the rooms connect, and that a wall lines up between storeys for the riser.`,
      fixtureId: missed.ref,
    })
  }

  const segments: Segment[] = []
  for (const { child, parent } of treeLinks(tree)) {
    const load = tree.loadToParent[child]
    const size = supplyDiameter(load, tree.minSizeToParent[child])
    const a = graph.position(child)
    const b = graph.position(parent)
    // Only an edge that actually crosses a slab is a rising main. A tall vertical run inside
    // one storey is just a drop from the ceiling void down to a low tap.
    const isRiser = slabEdges.has(tree.edgeToParent[child])
    const flat = Math.hypot(a.x - b.x, a.y - b.y)
    segments.push({
      id: nextId(),
      system,
      a: { ...a },
      b: { ...b },
      size,
      load,
      length: dist3(a, b),
      role: isRiser ? 'stack' : flat < 1 ? 'drop' : 'branch',
    })
  }

  if (system === 'hot') {
    for (const terminal of tree.connected) {
      const leg = tree.distToRoot[terminal.node]
      if (leg <= MAX_HOT_DEAD_LEG) continue
      const port = byNode.get(terminal.node)
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system,
        message: `${port?.fixtureName ?? 'A fixture'} is ${(leg / 1000).toFixed(1)} m of pipe from the heater, past the ${(MAX_HOT_DEAD_LEG / 1000).toFixed(0)} m dead-leg limit — it will run cold for a while and the standing water is a Legionella risk.`,
        position: port?.position,
        fixtureId: terminal.ref,
      })
    }
  }

  const merged = mergeCollinear(segments)
  const fittings = deriveFittings(merged, system, nextId)

  return {
    network: {
      system,
      segments: merged,
      fittings,
      totalLength: merged.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: tree.unreached.map((t) => t.ref),
    },
    warnings,
    graphNodes: graph.nodeCount,
    graphEdges: graph.edgeCount,
  }
}

function luOf(project: Project, port: ResolvedPort, system: SystemKind): number {
  const fixture = project.fixtures.find((f) => f.id === port.fixtureId)
  if (!fixture) return 0
  const loads = fixtureDef(fixture.type).loads
  return (system === 'hot' ? loads.supplyLuHot : loads.supplyLuCold) ?? 0
}
