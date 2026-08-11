/**
 * Gravity drainage, across any number of storeys.
 *
 * Drainage is designed in plan and given levels afterwards, and this solver works the same
 * way: route the tree across each storey's floor plane, then walk out from the outlet
 * assigning invert levels. Searching in 3-D with a slope constraint baked in would be both
 * slower and worse, because the fall is a consequence of the route, not a choice the search
 * gets to make.
 *
 * With more than one storey the invert of a node is
 *
 *     z = outlet.z + (storey elevation rise to that node) + design fall × horizontal run
 *
 * The two terms separate cleanly because the storey rises telescope along any path, so every
 * floor gets the same headroom budget under its own slab and the constraint is identical to
 * the single-storey one. Only the horizontal run buys fall; dropping down a stack is free.
 *
 * The stack itself is not placed anywhere. Crossing a slab is expensive and only possible
 * inside a wall that exists on both storeys, so the Steiner tree's reuse discount pulls every
 * upstairs branch onto one riser — which is exactly what a soil stack is.
 *
 * What the solver will not do is emit a pipe that runs uphill. Where the geometry cannot be
 * made to work it says so, with a position, instead of drawing a lie.
 */

import { fixtureDef } from '../catalog/fixtures.ts'
import { dist3, to3, type Vec2, type Vec3 } from '../geometry/vec.ts'
import {
  connectionAnchor,
  findLevel,
  portsOfSystem,
  servicePointOf,
  sortedLevels,
  type ConnectionAnchor,
  type ResolvedPort,
} from '../model.ts'
import {
  branchDiameter,
  maxUnventedTrapDistance,
  slopeLimits,
  stackDiameter,
} from '../standards/en12056.ts'
import type { Level, Network, Project, RoutingWarning, Segment } from '../types.ts'
import { sweepCorners, sweepJunctions } from './bends.ts'
import { deriveFittings, mergeCollinear } from './fittings.ts'
import { RouteGraph } from './graph.ts'
import {
  buildPlaneGrid,
  addVisibilityEdges,
  linkStoreys,
  planLines,
  visibilityPoints,
  type Layer,
  type LevelShapes,
} from './layers.ts'
import { buildTree, treeLinks, type RouteTree, type Terminal } from './steiner.ts'

/** Minimum vertical drop from a fixture outlet into the branch — the trap seal plus fall. */
const MIN_TRAP_DROP = 75

/** How far below the finished floor a branch invert has to stay to be covered by screed. */
const MIN_INVERT_DEPTH = 60

/** Clearance a wall needs over the pipe bore before a back-entry drop will hide inside it. */
const WALL_PIPE_CLEARANCE = 40

/**
 * Cost multiplier for punching through a slab.
 *
 * High enough that the search consolidates crossings into a single stack rather than
 * dropping each fixture straight down, but not so high that it would rather run drainage
 * halfway across the building to avoid one.
 */
const SLAB_CROSSING_WEIGHT = 14

export interface SystemSolution {
  network: Network
  warnings: RoutingWarning[]
  graphNodes: number
  graphEdges: number
}

export function routeWaste(
  project: Project,
  shapes: LevelShapes,
  nextId: () => string,
): SystemSolution {
  const warnings: RoutingWarning[] = []
  const empty = (): SystemSolution => ({
    network: { system: 'waste', segments: [], fittings: [], totalLength: 0, unreachedFixtureIds: [] },
    warnings,
    graphNodes: 0,
    graphEdges: 0,
  })

  const outlet = servicePointOf(project, 'wasteOutlet')
  const ports = portsOfSystem(project, 'waste')
  if (ports.length === 0) return empty()
  if (!outlet) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'waste',
      message: 'No waste outlet placed. Drop one on the plan to route drainage to it.',
    })
    return empty()
  }

  const levels = sortedLevels(project)
  const outletLevel = findLevel(project, outlet.levelId) ?? levels[0]
  if (!outletLevel) return empty()

  /* ------------------------------------------------------- one plane per storey */

  const diagonal = project.settings.drainage.strategy === 'diagonal'

  const graph = new RouteGraph()
  const attachAt: Vec2[] = [...ports.map((p) => ({ x: p.position.x, y: p.position.y })), outlet.position]

  const lines = planLines(project, attachAt)
  // The diagonal strategy adds straight runs at any bearing on top of the grid, between the
  // points worth running straight between.
  const points = diagonal ? visibilityPoints(project, attachAt) : []

  // Each storey's drainage plane sits just under its own floor. The elevation is nominal —
  // real inverts are assigned below — but it fixes how far a stack drops between storeys.
  const planeOf = new Map<string, Layer>()
  for (const level of levels) {
    const shape = shapes.byLevelId.get(level.id)
    if (!shape || shape.walls.length === 0) continue

    const plane = buildPlaneGrid(graph, project, shape, {
      z: level.elevation - MIN_INVERT_DEPTH,
      lines,
      // Below a floor a pipe crosses walls freely; the penalty discourages weaving.
      penetrationWeight: 1.5,
      allowLoadBearingPenetration: true,
    })
    if (diagonal) {
      addVisibilityEdges(graph, shape, plane, {
        points,
        penetrationWeight: 1.5,
        allowLoadBearingPenetration: true,
      })
    }
    planeOf.set(level.id, plane)
  }

  const slabEdges = new Set<number>()
  for (let i = 1; i < levels.length; i++) {
    const below = levels[i - 1]
    const above = levels[i]
    const lower = planeOf.get(below.id)
    const upper = planeOf.get(above.id)
    const lowerShape = shapes.byLevelId.get(below.id)
    const upperShape = shapes.byLevelId.get(above.id)
    if (!lower || !upper || !lowerShape || !upperShape) continue

    const created = linkStoreys(
      graph,
      { layer: lower, shape: lowerShape },
      { layer: upper, shape: upperShape },
      SLAB_CROSSING_WEIGHT,
    )
    for (const id of created) slabEdges.add(id)

    if (created.length === 0) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `No soil stack is possible between ${below.name} and ${above.name}: a stack may only drop through a wall that exists on both storeys, and none line up. Align a wall between the two floors.`,
      })
    }
  }

  const groundPlane = planeOf.get(outletLevel.id)
  if (!groundPlane) return empty()

  const root = groundPlane.at(graph, outlet.position) ?? groundPlane.nearest(graph, outlet.position)
  if (root === null) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'waste',
      message: 'The waste outlet is outside the building footprint.',
      position: to3(outlet.position, outlet.z),
    })
    return empty()
  }

  /* ---------------------------------------------------------------- terminals */

  const terminals: Terminal[] = []
  const terminalPorts = new Map<number, ResolvedPort>()
  const anchorOf = new Map<number, ConnectionAnchor>()
  for (const port of ports) {
    const level = levelOfPort(project, port, levels)
    const plane = level ? planeOf.get(level.id) : null
    const fixture = project.fixtures.find((f) => f.id === port.fixtureId)
    // Back entry turns the pipe vertical inside the wall behind the appliance rather than
    // directly beneath it, so that is where the branch has to come up to meet it.
    const anchor = fixture
      ? connectionAnchor(project, fixture, port)
      : { plan: { x: port.position.x, y: port.position.y }, wall: null, fellBack: false }
    const node = plane ? (plane.at(graph, anchor.plan) ?? plane.nearest(graph, anchor.plan)) : null
    if (node === null || node === undefined) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `${port.fixtureName} sits outside the building footprint.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
      continue
    }
    terminals.push({ ref: port.fixtureId, node, load: duOf(project, port), minSize: port.dn })
    terminalPorts.set(node, port)
    anchorOf.set(node, anchor)

    if (anchor.fellBack) {
      warnings.push({
        id: nextId(),
        severity: 'info',
        system: 'waste',
        message: `${port.fixtureName} is set to connect from the back but is not against a wall, so it drains from underneath instead.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
    }
    if (anchor.wall && anchor.wall.thickness < port.dn + WALL_PIPE_CLEARANCE) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'waste',
        message: `${port.fixtureName} drops a DN${port.dn} inside a ${anchor.wall.thickness} mm wall. That will not conceal — thicken the wall to at least ${port.dn + WALL_PIPE_CLEARANCE} mm, box the pipe out, or connect from underneath.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
    }
  }

  const tree = buildTree(graph, root, terminals, { turnPenalty: 400, reuseDiscount: 0.12 })

  for (const missed of tree.unreached) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'waste',
      message: `No drainage route from ${labelOf(project, missed.ref)} to the outlet. Check that the rooms connect, and that a wall lines up between storeys for the stack.`,
      fixtureId: missed.ref,
    })
  }

  /* ------------------------------------- split the path into rise and horizontal run */

  const { rise, horizontal } = splitPath(graph, tree, slabEdges)

  const settings = project.settings.drainage
  const maxHorizontal = Math.max(0, ...tree.order.map((n) => horizontal[n]))

  // The headroom budget is per storey and identical on each, because the storey rise term
  // cancels against that storey's own floor level. Only the horizontal run eats into it.
  const headroom = outletLevel.elevation - MIN_INVERT_DEPTH - outlet.z
  const slopeCap = maxHorizontal > 0 ? headroom / maxHorizontal : Infinity

  let slope = Math.min(settings.designSlope, slopeCap)
  if (slope < settings.minSlope) {
    slope = settings.minSlope
    const over = outlet.z + slope * maxHorizontal - (outletLevel.elevation - MIN_INVERT_DEPTH)
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'waste',
      message: `The drainage cannot stay under the floor: over ${(maxHorizontal / 1000).toFixed(1)} m of horizontal run, even the minimum ${(settings.minSlope * 100).toFixed(1)}% fall rises ${Math.round(over)} mm too high. Lower the waste outlet, or move the furthest fixture closer to it.`,
      position: to3(outlet.position, outlet.z),
    })
  } else if (slope < settings.designSlope - 1e-9) {
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'waste',
      message: `Fall eased to ${(slope * 100).toFixed(2)}% (from ${(settings.designSlope * 100).toFixed(1)}%) so the longest run still clears the floor.`,
    })
  }

  if (outletLevel.elevation - outlet.z > project.settings.floorBuildUp) {
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'waste',
      message: `The outlet invert is ${Math.round(outletLevel.elevation - outlet.z)} mm below the floor, deeper than the ${project.settings.floorBuildUp} mm build-up — the connection has to break through the slab.`,
      position: to3(outlet.position, outlet.z),
    })
  }

  const invert = new Map<number, number>()
  for (const node of tree.order) {
    invert.set(node, outlet.z + rise[node] + slope * horizontal[node])
  }

  const at = (node: number): Vec3 => {
    const p = graph.position(node)
    return { x: p.x, y: p.y, z: invert.get(node) ?? p.z }
  }

  /* ----------------------------------------------------------------- segments */

  const segments: Segment[] = []
  let stackCount = 0

  for (const { child, parent } of treeLinks(tree)) {
    const load = tree.loadToParent[child]
    const isStack = slabEdges.has(tree.edgeToParent[child])
    const size = isStack
      ? // A stack is sized by the flow it can carry vertically, not by branch capacity.
        stackDiameter(load, Math.max(70, tree.minSizeToParent[child]))
      : branchDiameter(load, tree.minSizeToParent[child])
    if (isStack) stackCount += 1

    const a = at(child)
    const b = at(parent)
    const run = Math.hypot(b.x - a.x, b.y - a.y)
    const fall = run > 0 ? (a.z - b.z) / run : 0

    segments.push({
      id: nextId(),
      system: 'waste',
      a,
      b,
      size,
      load,
      length: dist3(a, b),
      role: isStack ? 'stack' : 'branch',
      slope: run > 0 ? fall : 1,
    })

    if (run <= 0) continue
    const limits = slopeLimits(size)
    if (fall > limits.max + 1e-9) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'waste',
        message: `DN${size} branch falls at ${(fall * 100).toFixed(1)}%, steeper than the ${(limits.max * 100).toFixed(0)}% limit — the water will outrun the solids.`,
        position: a,
      })
    }
    if (fall < limits.min - 1e-9) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `DN${size} branch falls at only ${(fall * 100).toFixed(2)}%, below the ${(limits.min * 100).toFixed(1)}% minimum.`,
        position: a,
      })
    }
  }

  if (stackCount > 0) {
    // Report the stack as built, not a recomputed figure: a WC forces DN100 regardless of
    // what its discharge units alone would have asked for.
    const stackRuns = segments.filter((s) => s.role === 'stack')
    const carried = Math.max(0, ...stackRuns.map((s) => s.load))
    const size = Math.max(...stackRuns.map((s) => s.size))
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'waste',
      message: `Soil stack: DN${size} carrying ${carried.toFixed(1)} DU down to the outlet.`,
    })
  }

  /* ------------------------------------- drops from each fixture into the branch */

  for (const terminal of tree.connected) {
    const port = terminalPorts.get(terminal.node)
    if (!port) continue
    const branchZ = invert.get(terminal.node)
    if (branchZ === undefined) continue
    const drop = port.position.z - branchZ

    if (drop < MIN_TRAP_DROP) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `${port.fixtureName} cannot drain: its outlet is ${Math.round(drop)} mm above the branch, and a trap needs at least ${MIN_TRAP_DROP} mm. Lower the waste outlet or move the fixture closer to it.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
      continue
    }

    const size = Math.max(port.dn, branchDiameter(terminal.load, port.dn))
    const anchor = anchorOf.get(terminal.node)?.plan ?? {
      x: port.position.x,
      y: port.position.y,
    }
    const node = graph.position(terminal.node)

    /** A horizontal piece at the given level, skipped when the two ends coincide. */
    const tail = (from: Vec2, to: Vec2, z: number) => {
      const length = Math.hypot(to.x - from.x, to.y - from.y)
      if (length <= 1) return
      segments.push({
        id: nextId(),
        system: 'waste',
        a: { x: from.x, y: from.y, z },
        b: { x: to.x, y: to.y, z },
        size,
        load: terminal.load,
        length,
        role: 'branch',
        slope: 0,
      })
    }

    // Back entry: run horizontally off the appliance into the wall before turning down.
    tail({ x: port.position.x, y: port.position.y }, anchor, port.position.z)

    segments.push({
      id: nextId(),
      system: 'waste',
      a: { x: anchor.x, y: anchor.y, z: port.position.z },
      b: { x: anchor.x, y: anchor.y, z: branchZ },
      size,
      load: terminal.load,
      length: drop,
      role: 'drop',
      slope: 1,
    })

    // The branch node is not always exactly under the drop — with any-bearing routing the
    // lattice may put it a cell away — so close the gap rather than leaving the drop hanging
    // next to the network.
    tail(anchor, { x: node.x, y: node.y }, branchZ)

    // Only the horizontal part of the run counts against the unvented limit — a stack does
    // not siphon a trap the way a long flat branch does.
    const runToStack = horizontal[terminal.node]
    const limit = maxUnventedTrapDistance(port.dn)
    if (runToStack > limit) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'waste',
        message: `${port.fixtureName} is ${(runToStack / 1000).toFixed(1)} m of flat branch from the outlet, past the ${(limit / 1000).toFixed(1)} m unvented limit for DN${port.dn} — this branch needs its own vent.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
    }
  }

  // Merge first so the corners are real corners. Branch connections are swung downstream
  // before the corners are swept, because sliding a junction along the trunk changes what the
  // corners either side of it look like. Fittings are read off the finished geometry, so the
  // bends counted are the bends drawn.
  const swept = sweepCorners(sweepJunctions(mergeCollinear(segments), nextId), nextId)
  const fittings = deriveFittings(swept, 'waste', nextId)

  return {
    network: {
      system: 'waste',
      segments: swept,
      fittings,
      totalLength: swept.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: tree.unreached.map((t) => t.ref),
    },
    warnings,
    graphNodes: graph.nodeCount,
    graphEdges: graph.edgeCount,
  }
}

/**
 * For every node, how much of its path back to the root was a storey rise and how much was
 * horizontal run. Only the horizontal part consumes fall.
 */
function splitPath(
  graph: RouteGraph,
  tree: RouteTree,
  slabEdges: Set<number>,
): { rise: Float64Array; horizontal: Float64Array } {
  const rise = new Float64Array(graph.nodeCount)
  const horizontal = new Float64Array(graph.nodeCount)

  // `order` is breadth-first from the root, so a parent is always resolved before its child.
  for (const node of tree.order) {
    const parent = tree.parent[node]
    if (parent < 0) continue
    const a = graph.position(node)
    const b = graph.position(parent)
    if (slabEdges.has(tree.edgeToParent[node])) {
      rise[node] = rise[parent] + (a.z - b.z)
      horizontal[node] = horizontal[parent]
    } else {
      rise[node] = rise[parent]
      horizontal[node] = horizontal[parent] + Math.hypot(a.x - b.x, a.y - b.y)
    }
  }
  return { rise, horizontal }
}

/** The storey a port belongs to, via its fixture's room. */
function levelOfPort(project: Project, port: ResolvedPort, levels: Level[]): Level | null {
  const room = project.rooms.find((r) => r.id === port.roomId)
  if (!room) return levels[0] ?? null
  return findLevel(project, room.levelId) ?? levels[0] ?? null
}

function duOf(project: Project, port: ResolvedPort): number {
  const fixture = project.fixtures.find((f) => f.id === port.fixtureId)
  return fixture ? (fixtureDef(fixture.type).loads.drainageDu ?? 0) : 0
}

const labelOf = (project: Project, fixtureId: string): string =>
  project.fixtures.find((f) => f.id === fixtureId)?.name ?? 'a fixture'
