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

import { fixtureDef, trapHeight } from '../catalog/fixtures.ts'
import { dist3, to3, type Vec2, type Vec3 } from '../geometry/vec.ts'
import {
  connectionAnchor,
  findLevel,
  portsOfSystem,
  servicePointsOf,
  sortedLevels,
  type ConnectionAnchor,
  type ResolvedPort,
} from '../model.ts'
import {
  branchDiameter,
  collectorDiameter,
  flowFromDu,
  partFullFlow,
  slopeLimits,
  stackDiameter,
  unventedBranchLimits,
  MAX_COLLECTOR_FILLING,
  TRAP_SEAL_DEPTH,
  VELOCITY_LIMITS,
} from '../standards/en12056.ts'
import type {
  Fitting,
  FixtureType,
  Level,
  Network,
  Project,
  RoutingWarning,
  Segment,
  ServicePoint,
} from '../types.ts'
import { absorbOffsets, sweepCorners, sweepJunctions } from './bends.ts'
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

/**
 * Vertical clearance a fixture needs between its outlet and the branch invert.
 *
 * What has to fit there is the trap *body*, which the catalogue carries per appliance, and
 * never less than the water seal the standard asks for. The two are easy to confuse and are
 * an order of magnitude apart: a bottle trap under a basin is 200 mm deep, its seal 50.
 */
const trapClearance = (type: FixtureType): number =>
  Math.max(TRAP_SEAL_DEPTH, trapHeight(type))

/**
 * How far the air admittance valve sits above the highest thing it protects.
 *
 * It has to be clear of the flood level of the highest fixture, or a blocked branch would
 * push water into the valve instead of air through it.
 */
const AAV_ABOVE_HIGHEST = 300

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

  const outlets = servicePointsOf(project, 'wasteOutlet')
  const ports = portsOfSystem(project, 'waste')
  if (ports.length === 0) return empty()
  if (outlets.length === 0) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'waste',
      message: 'No waste outlet placed. Drop one on the plan to route drainage to it.',
    })
    return empty()
  }

  const levels = sortedLevels(project)
  if (levels.length === 0) return empty()

  /* ------------------------------------------------------- one plane per storey */

  const diagonal = project.settings.drainage.strategy === 'diagonal'

  const graph = new RouteGraph()
  const attachAt: Vec2[] = [
    ...ports.map((p) => ({ x: p.position.x, y: p.position.y })),
    ...outlets.map((o) => o.position),
  ]

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

  /**
   * Every outlet hangs off one virtual root.
   *
   * With more than one place for the drainage to leave, which fixture uses which outlet is a
   * design decision, not something to ask for. Tying them all to a costless virtual root lets
   * the same tree search answer it: each branch grows to whichever outlet is cheapest to
   * reach, and the tree falls apart into one real network per outlet.
   */
  const superRoot = graph.node({ x: -1e6, y: -1e6, z: -1e6 })
  const virtualEdges = new Set<number>()
  const outletAtNode = new Map<number, ServicePoint>()

  for (const outlet of outlets) {
    const level = findLevel(project, outlet.levelId) ?? levels[0]
    const plane = planeOf.get(level.id)
    const node = plane
      ? (plane.at(graph, outlet.position) ?? plane.nearest(graph, outlet.position))
      : null
    if (node === null || node === undefined) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `${outlet.name} is outside the building footprint.`,
        position: to3(outlet.position, outlet.z),
      })
      continue
    }
    outletAtNode.set(node, outlet)
    virtualEdges.add(graph.connectVirtual(superRoot, node))
  }
  if (outletAtNode.size === 0) return empty()
  const root = superRoot

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

  const { rise, horizontal, drainsTo } = splitPath(graph, tree, slabEdges, virtualEdges)

  /**
   * Two more things the tree has to carry up to the root alongside its load.
   *
   * WCs, because EN 12056-2 limits them by count and not by discharge unit — a DN70 branch may
   * take none however light the load on it, and a DN90 at most two. And appliance counts,
   * because they are what tells a single branch discharge pipe apart from a collector branch,
   * and the two have different application limits.
   */
  const wcToParent = new Float64Array(graph.nodeCount)
  const applianceCount = new Int32Array(graph.nodeCount)
  for (const terminal of tree.connected) {
    applianceCount[terminal.node] += 1
    if (fixtureTypeOf(project, terminal.ref) === 'wc') wcToParent[terminal.node] += 1
  }
  for (let i = tree.order.length - 1; i > 0; i--) {
    const node = tree.order[i]
    const up = tree.parent[node]
    if (up < 0) continue
    wcToParent[up] += wcToParent[node]
    applianceCount[up] += applianceCount[node]
  }

  const collectorEdges = classifyCollector(tree, slabEdges, virtualEdges, drainsTo, applianceCount)

  const settings = project.settings.drainage

  /** The outlet a node's water ends up at. */
  const outletOf = (node: number): ServicePoint | null => {
    const at = drainsTo[node]
    return at >= 0 ? (outletAtNode.get(at) ?? null) : null
  }
  const outletLevelOf = (outlet: ServicePoint) => findLevel(project, outlet.levelId) ?? levels[0]

  // The headroom budget is per storey and identical on each, because the storey rise term
  // cancels against that storey's own floor level. Only the horizontal run eats into it.
  //
  // With several outlets the tightest one governs: one fall is used across the installation,
  // so a shared branch is never asked for two different gradients at once.
  let maxHorizontal = 0
  let slopeCap = Infinity
  for (const node of tree.order) {
    const outlet = outletOf(node)
    if (!outlet || horizontal[node] <= 0) continue
    maxHorizontal = Math.max(maxHorizontal, horizontal[node])
    slopeCap = Math.min(
      slopeCap,
      (outletLevelOf(outlet).elevation - MIN_INVERT_DEPTH - outlet.z) / horizontal[node],
    )
  }

  // `maxSlope` is the project's own ceiling on how steep pipework may be laid — EN 12056-2 sets
  // no maximum gradient of its own, and the standard's ceiling is a velocity, checked per run
  // below. Clamping the design fall here is what makes the setting mean something.
  let slope = Math.min(settings.designSlope, settings.maxSlope, slopeCap)
  if (slope < settings.minSlope) {
    slope = settings.minSlope
    const over = slope * maxHorizontal - Math.min(
      ...outlets.map((o) => outletLevelOf(o).elevation - MIN_INVERT_DEPTH - o.z),
    )
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'waste',
      message: `The drainage cannot stay under the floor: over ${(maxHorizontal / 1000).toFixed(1)} m of horizontal run, even the minimum ${(settings.minSlope * 100).toFixed(1)}% fall rises ${Math.round(over)} mm too high. Lower an outlet, add one nearer, or move the furthest fixture closer.`,
    })
  } else if (slope < Math.min(settings.designSlope, settings.maxSlope) - 1e-9) {
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'waste',
      message: `Fall eased to ${(slope * 100).toFixed(2)}% (from ${(settings.designSlope * 100).toFixed(1)}%) so the longest run still clears the floor.`,
    })
  }

  for (const outlet of outlets) {
    const depth = outletLevelOf(outlet).elevation - outlet.z
    if (depth <= project.settings.floorBuildUp) continue
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'waste',
      message: `${outlet.name} sits ${Math.round(depth)} mm below the floor, deeper than the ${project.settings.floorBuildUp} mm build-up — the connection has to break through the slab.`,
      position: to3(outlet.position, outlet.z),
    })
  }

  const invert = new Map<number, number>()
  for (const node of tree.order) {
    const outlet = outletOf(node)
    if (outlet) invert.set(node, outlet.z + rise[node] + slope * horizontal[node])
  }

  const at = (node: number): Vec3 => {
    const p = graph.position(node)
    return { x: p.x, y: p.y, z: invert.get(node) ?? p.z }
  }

  /* ----------------------------------------------------------------- segments */

  const segments: Segment[] = []
  /**
   * The vent stubs are kept out of `segments` on purpose.
   *
   * Everything in `segments` is gravity pipe, and the passes that follow — merging, swinging
   * junctions downstream, sweeping corners — all reason about the direction water flows. A
   * stub that carries air the other way is not a corner to be chamfered or a branch to be
   * swung, and feeding it through those passes would rewrite the drainage around it.
   */
  const ventStubs: Segment[] = []
  const ventValves: Fitting[] = []
  let stackCount = 0

  /** What each edge was drawn at, so the branch checks below read back the pipe on the drawing. */
  const sizeToParent = new Map<number, number>()
  /**
   * The largest stack in each outlet's tree so far.
   *
   * `treeLinks` runs leaves first, so every stack is sized before the collector it lands on,
   * and the collector can be held to at least the stack's own width. Nothing downstream of a
   * pipe may be narrower than it.
   */
  const stackSizeTo = new Map<number, number>()
  /** One depth warning per storey and size — the same run arrives as a hundred grid edges. */
  const shallowRuns = new Set<string>()

  for (const { child, parent } of treeLinks(tree)) {
    // The join to the shared root is bookkeeping, not pipe.
    if (virtualEdges.has(tree.edgeToParent[child])) continue
    const load = tree.loadToParent[child]
    const wcs = wcToParent[child]
    const isStack = slabEdges.has(tree.edgeToParent[child])
    const isCollector = !isStack && collectorEdges.has(child)
    const outletNode = drainsTo[child]

    const size = isStack
      ? // A stack is sized by the flow it can carry vertically, not by branch capacity.
        stackDiameter(load, Math.max(70, tree.minSizeToParent[child]), wcs)
      : isCollector
        ? // Below the stack foot the drain stops being a branch: the gradient sizes it, and it
          // is never smaller than DN100 whatever the load works out at.
          collectorDiameter(
            load,
            slope,
            Math.max(tree.minSizeToParent[child], stackSizeTo.get(outletNode) ?? 0),
          )
        : branchDiameter(load, tree.minSizeToParent[child], wcs)

    if (isStack) {
      stackCount += 1
      stackSizeTo.set(outletNode, Math.max(stackSizeTo.get(outletNode) ?? 0, size))
    }
    sizeToParent.set(child, size)

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
      role: isStack ? 'stack' : isCollector ? 'collector' : 'branch',
      slope: run > 0 ? fall : 1,
    })

    if (run <= 0) continue
    const noun = isCollector ? 'collector' : 'branch'
    const limits = slopeLimits(size, false, isCollector)
    if (fall < limits.min - 1e-9) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `DN${size} ${noun} falls at only ${(fall * 100).toFixed(2)}%, below the ${(limits.min * 100).toFixed(1)}% minimum${size > 56 ? ` (1:${size} for this diameter)` : ''}.`,
        position: a,
      })
    }

    // EN 12056-2 has no maximum gradient — what it caps is the velocity, because that is what
    // actually scours or scars the pipe. Both figures come from the filling the run settles at.
    const { velocity, filling } = partFullFlow(flowFromDu(load), size, fall)
    if (velocity > VELOCITY_LIMITS.max) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'waste',
        message: `DN${size} ${noun} runs at ${velocity.toFixed(1)} m/s, above the ${VELOCITY_LIMITS.max} m/s EN 12056-2 allows for sewage pipe. Ease the fall or step the pipe up a size.`,
        position: a,
      })
    }
    if (isCollector && filling > MAX_COLLECTOR_FILLING) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'waste',
        message: `DN${size} collector runs ${Math.round(filling * 100)}% full at ${(fall * 100).toFixed(1)}%, past the ${Math.round(MAX_COLLECTOR_FILLING * 100)}% filling EN 12056-2 allows. Steepen it or step it up a size.`,
        position: a,
      })
    }

    // A bigger pipe needs more depth than the invert alone. Where a run's crown would come up
    // through the finished floor the design has stopped being buildable, and saying so beats
    // drawing a pipe that is half in the room.
    const floor = levels.find((level) => level.elevation >= Math.max(a.z, b.z) - 1)
    const cover = floor ? floor.elevation - Math.max(a.z, b.z) : Infinity
    if (floor && cover < size) {
      const key = `${floor.id}|${size}|${noun}`
      if (!shallowRuns.has(key)) {
        shallowRuns.add(key)
        warnings.push({
          id: nextId(),
          severity: 'warning',
          system: 'waste',
          message: `A DN${size} ${noun} under ${floor.name} sits only ${Math.round(cover)} mm below the finished floor, so the top of the pipe would break through it. Deepen the outlet, shorten the run, or allow more than the ${project.settings.floorBuildUp} mm floor build-up.`,
          position: a,
        })
      }
    }
  }

  /**
   * One nominal width for the whole stack.
   *
   * DIN 1986-100 does not let a stack change size over its height, and for good reason: a
   * reducer inside a stack is a ledge for everything coming down it. Sizing each slab crossing
   * from its own accumulated load produces exactly that, so the sections sharing a shaft are
   * levelled up to the largest of them before anything downstream reads their size.
   */
  const stackColumn = (segment: Segment) => `${Math.round(segment.a.x)},${Math.round(segment.a.y)}`
  const widestInColumn = new Map<string, number>()
  for (const segment of segments) {
    if (segment.role !== 'stack') continue
    const column = stackColumn(segment)
    widestInColumn.set(column, Math.max(widestInColumn.get(column) ?? 0, segment.size))
  }
  for (const segment of segments) {
    if (segment.role !== 'stack') continue
    segment.size = widestInColumn.get(stackColumn(segment)) ?? segment.size
  }

  if (stackCount > 0) {
    // Report the stack as built, not a recomputed figure: a WC forces a minimum diameter
    // regardless of what its discharge units alone would have asked for.
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

    const type = fixtureTypeOf(project, terminal.ref)
    const clearance = type ? trapClearance(type) : TRAP_SEAL_DEPTH
    if (drop < clearance) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'waste',
        message: `${port.fixtureName} cannot drain: its outlet is ${Math.round(drop)} mm above the branch, and its trap needs ${clearance} mm of that — the ${TRAP_SEAL_DEPTH} mm water seal EN 12056-2 asks for has to sit inside a fitting that is deeper still. Lower the waste outlet or move the fixture closer to it.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
      continue
    }

    const size = Math.max(
      port.dn,
      branchDiameter(terminal.load, port.dn, type === 'wc' ? 1 : 0),
    )
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

    /*
     * Application limits for a branch with no ventilation of its own.
     *
     * They are measured over the branch, which ends at the stack or where the run becomes the
     * collector — not all the way to the outlet. Past a stack the trap is no longer what the
     * pressure swings act on, and counting the collector against a basin's branch condemns
     * layouts that are entirely conventional.
     */
    const branch = branchToStack(graph, tree, terminal.node, {
      slabEdges,
      virtualEdges,
      collectorEdges,
      applianceCount,
      sizeToParent,
    })
    const limits = unventedBranchLimits(branch.singleDn, false)
    const said = (message: string) => {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'waste',
        message,
        position: port.position,
        fixtureId: port.fixtureId,
      })
    }

    if (branch.singleLength > limits.maxLength) {
      said(
        `${port.fixtureName} is ${(branch.singleLength / 1000).toFixed(1)} m of branch on its own before it joins anything, past the ${(limits.maxLength / 1000).toFixed(0)} m EN 12056-2 allows without ventilation — this branch needs its own vent.`,
      )
    }
    if (branch.sharedLength > 0) {
      const shared = unventedBranchLimits(branch.sharedDn, true)
      if (branch.sharedLength > shared.maxLength) {
        said(
          `The DN${branch.sharedDn} collector branch carrying ${port.fixtureName} runs ${(branch.sharedLength / 1000).toFixed(1)} m to the stack, past the ${(shared.maxLength / 1000).toFixed(0)} m EN 12056-2 allows without ventilation.`,
        )
      }
    }

    // The drop from the appliance connection down to the branch invert at the stack. Too much
    // of it and the discharge arrives with enough energy to pull the seals off the traps
    // sharing the branch, which is why the standard caps it independently of the length.
    const fallToStack = port.position.z - (invert.get(branch.endNode) ?? branchZ)
    if (fallToStack > limits.maxDrop) {
      said(
        `${port.fixtureName} drops ${Math.round(fallToStack)} mm between its connection and the branch invert at the stack, past the ${limits.maxDrop} mm EN 12056-2 allows on an unventilated branch.`,
      )
    }
    if (branch.turn > limits.maxTurn + 1e-6) {
      said(
        `The branch from ${port.fixtureName} turns through ${Math.round(branch.turn)}° on its way to the stack, past the ${limits.maxTurn}° — three right angles — EN 12056-2 allows without ventilation.`,
      )
    }
  }

  // Merge first so the corners are real corners. Branch connections are swung downstream
  // before the corners are swept, because sliding a junction along the trunk changes what the
  // corners either side of it look like. Fittings are read off the finished geometry, so the
  // bends counted are the bends drawn.
  const swept = sweepCorners(
    sweepJunctions(absorbOffsets(mergeCollinear(segments), nextId), nextId),
    nextId,
  )

  /**
   * An air admittance valve at the top of every network.
   *
   * Discharging a stack drags air behind it, and with nowhere for that air to come from it is
   * pulled through the nearest trap instead — which empties the seal and lets the drain into
   * the room. The valve lets air in and shuts against anything trying to leave, so the
   * pressure equalises without venting through the roof.
   *
   * The valve is placed on the *finished* geometry rather than on the routed tree. Sweeping
   * moves points around — that is its job — so a stub hung off a node the tree knew about can
   * find itself attached to a place that no longer exists. Each drainage tree is its own
   * connected piece of the drawing once the virtual root is gone, so walking the drawing finds
   * both the outfall and the high point, and the stub lands somewhere that is certainly there.
   */
  for (const network of connectedPieces(swept)) {
    const top = network.reduce((best, p) => (p.z > best.z ? p : best))
    const size = Math.max(
      ...swept
        .filter((s) => samePoint(s.a, top) || samePoint(s.b, top))
        .map((s) => s.size),
    )
    const valveZ = top.z + AAV_ABOVE_HIGHEST

    ventStubs.push({
      id: nextId(),
      system: 'waste',
      a: { x: top.x, y: top.y, z: valveZ },
      b: { x: top.x, y: top.y, z: top.z },
      size,
      load: 0,
      length: AAV_ABOVE_HIGHEST,
      role: 'vent',
      slope: 1,
    })
    ventValves.push({
      id: nextId(),
      kind: 'aav',
      system: 'waste',
      position: { x: top.x, y: top.y, z: valveZ },
      size,
    })
  }

  const drawn = [...swept, ...ventStubs]
  const fittings = [...deriveFittings(swept, 'waste', nextId), ...ventValves]

  return {
    network: {
      system: 'waste',
      segments: drawn,
      fittings,
      totalLength: drawn.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: tree.unreached.map((t) => t.ref),
    },
    warnings,
    graphNodes: graph.nodeCount,
    graphEdges: graph.edgeCount,
  }
}

const samePoint = (a: Vec3, b: Vec3): boolean =>
  Math.round(a.x) === Math.round(b.x) &&
  Math.round(a.y) === Math.round(b.y) &&
  Math.round(a.z) === Math.round(b.z)

/**
 * The separate pieces of drawn pipework, as lists of their points.
 *
 * With more than one outlet the drainage is a forest, and each tree is drawn as its own
 * unconnected piece. Flooding the geometry itself — rather than the tree the router built —
 * means the answer holds however much the sweeping passes have moved things about.
 */
function connectedPieces(segments: Segment[]): Vec3[][] {
  const key = (p: Vec3) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
  const points = new Map<string, Vec3>()
  const adjacent = new Map<string, string[]>()
  for (const segment of segments) {
    const [a, b] = [key(segment.a), key(segment.b)]
    points.set(a, segment.a)
    points.set(b, segment.b)
    adjacent.set(a, [...(adjacent.get(a) ?? []), b])
    adjacent.set(b, [...(adjacent.get(b) ?? []), a])
  }

  const seen = new Set<string>()
  const pieces: Vec3[][] = []
  // Sorted so the pieces, and the valves that follow from them, come out in the same order
  // every time.
  for (const start of [...points.keys()].sort()) {
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
    pieces.push(piece)
  }
  return pieces
}

/**
 * For every node, how much of its path back to the root was a storey rise and how much was
 * horizontal run. Only the horizontal part consumes fall.
 */
function splitPath(
  graph: RouteGraph,
  tree: RouteTree,
  slabEdges: Set<number>,
  virtualEdges: Set<number>,
): { rise: Float64Array; horizontal: Float64Array; drainsTo: Int32Array } {
  const rise = new Float64Array(graph.nodeCount)
  const horizontal = new Float64Array(graph.nodeCount)
  /** Which outlet node each node's water reaches, or -1 for the virtual root itself. */
  const drainsTo = new Int32Array(graph.nodeCount).fill(-1)

  // `order` is breadth-first from the root, so a parent is always resolved before its child.
  for (const node of tree.order) {
    const parent = tree.parent[node]
    if (parent < 0) continue

    // A virtual edge is the join to the shared root: the node on the far side of it is an
    // outlet, and everything past it measures its fall from there, not from the root.
    if (virtualEdges.has(tree.edgeToParent[node])) {
      rise[node] = 0
      horizontal[node] = 0
      drainsTo[node] = node
      continue
    }

    drainsTo[node] = drainsTo[parent]
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
  return { rise, horizontal, drainsTo }
}

/**
 * The edges that are collector rather than branch.
 *
 * A collector is everything downstream of a stack foot: it is sized from its gradient, floored
 * at DN100, and it is the pipe that actually leaves the building. Where a storey has no stack
 * at all the collector still exists — it starts where the last appliance branch joins, because
 * from there on the run is carrying the whole installation to the outlet.
 *
 * The set holds the *child* node of each collector edge, matching how the tree names its edges.
 */
function classifyCollector(
  tree: RouteTree,
  slabEdges: Set<number>,
  virtualEdges: Set<number>,
  drainsTo: Int32Array,
  applianceCount: Int32Array,
): Set<number> {
  const collector = new Set<number>()
  /** Outlets a stack drops into, which take the first rule rather than the second. */
  const stacked = new Set<number>()

  for (const node of tree.order) {
    if (!slabEdges.has(tree.edgeToParent[node])) continue
    const outlet = drainsTo[node]
    if (outlet < 0) continue
    stacked.add(outlet)
    // Walk from this crossing down to the outlet. Further slab crossings on the way are the
    // rest of the same stack and are skipped, so what is left is the run below the lowest foot.
    for (let at = tree.parent[node]; at >= 0 && at !== outlet; at = tree.parent[at]) {
      if (!slabEdges.has(tree.edgeToParent[at])) collector.add(at)
    }
  }

  for (const node of tree.order) {
    const outlet = drainsTo[node]
    if (outlet < 0 || node === outlet || stacked.has(outlet)) continue
    if (virtualEdges.has(tree.edgeToParent[node])) continue
    // Every appliance draining to this outlet is already upstream, so nothing else joins below.
    if (applianceCount[node] > 0 && applianceCount[node] === applianceCount[outlet]) {
      collector.add(node)
    }
  }

  return collector
}

interface UnventedRun {
  /** Horizontal run serving this appliance alone, mm. */
  singleLength: number
  singleDn: number
  /** Horizontal run shared with other appliances before the stack, mm; zero when there is none. */
  sharedLength: number
  sharedDn: number
  /** Total change of direction along the whole run, degrees. */
  turn: number
  /** Where the run ends: the stack, the head of the collector, or the outlet. */
  endNode: number
}

/**
 * Measure an appliance's unventilated run down to the stack.
 *
 * EN 12056-2 treats the pipe serving one appliance and the pipe collecting several as separate
 * things with separate limits, so the walk keeps the two lengths apart at the point another
 * appliance joins. The turn is accumulated over the whole run because the standard's budget of
 * three right angles — or 270° spent in shallower turns — applies to the branch as a whole.
 */
function branchToStack(
  graph: RouteGraph,
  tree: RouteTree,
  from: number,
  context: {
    slabEdges: Set<number>
    virtualEdges: Set<number>
    collectorEdges: Set<number>
    applianceCount: Int32Array
    sizeToParent: Map<number, number>
  },
): UnventedRun {
  const run: UnventedRun = {
    singleLength: 0,
    singleDn: 0,
    sharedLength: 0,
    sharedDn: 0,
    turn: 0,
    endNode: from,
  }
  let heading: Vec2 | null = null

  for (let node = from; ; ) {
    const parent = tree.parent[node]
    const edge = tree.edgeToParent[node]
    if (parent < 0) break
    if (context.slabEdges.has(edge) || context.virtualEdges.has(edge)) break
    if (context.collectorEdges.has(node)) break

    const a = graph.position(node)
    const b = graph.position(parent)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length > 1e-6) {
      const size = context.sizeToParent.get(node) ?? 0
      if (context.applianceCount[node] > 1) {
        run.sharedLength += length
        run.sharedDn = Math.max(run.sharedDn, size)
      } else {
        run.singleLength += length
        run.singleDn = Math.max(run.singleDn, size)
      }
      const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
      if (heading) {
        const dot = Math.max(-1, Math.min(1, heading.x * direction.x + heading.y * direction.y))
        run.turn += (Math.acos(dot) * 180) / Math.PI
      }
      heading = direction
    }
    node = parent
    run.endNode = node
  }
  return run
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

const fixtureTypeOf = (project: Project, fixtureId: string): FixtureType | null =>
  project.fixtures.find((f) => f.id === fixtureId)?.type ?? null

const labelOf = (project: Project, fixtureId: string): string =>
  project.fixtures.find((f) => f.id === fixtureId)?.name ?? 'a fixture'
