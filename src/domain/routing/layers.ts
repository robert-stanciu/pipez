/**
 * Graph builders.
 *
 * Two shapes cover everything the three systems need:
 *
 *  - a **plane grid** — a Hanan grid in one horizontal plane, clipped to the building
 *    footprint. Used for drainage under the floor and for supply in the ceiling void, where
 *    a run may legitimately cross open floor.
 *
 *  - a **wall graph** — a one-dimensional network following wall centrelines at a given
 *    height. Used for cables, which are only allowed inside the wall installation zones.
 *
 * A Hanan grid, rather than a uniform voxel field, is what keeps this fast: lines are drawn
 * only through coordinates that matter (fixture ports, service points, wall faces), and an
 * optimal rectilinear route is guaranteed to exist on that much smaller lattice.
 *
 * Builders write into a caller-supplied graph so several layers can be stitched into one
 * search space — the electrical solver needs wall zones and the ceiling plane together.
 */

import {
  bounds,
  expandBounds,
  pointInPolygon,
  unionBounds,
  type Bounds,
} from '../geometry/polygon.ts'
import { closestPointOnSegment, dist2, type Vec2 } from '../geometry/vec.ts'
import {
  centrelineOutline,
  outerOutline,
  roomsOnLevel,
  sortedLevels,
  wallsOf,
  type WallGeometry,
} from '../model.ts'
import type { Level, Opening, Project, Room } from '../types.ts'
import { coordinateLines, type RouteGraph } from './graph.ts'

/** Above this the grid is coarsened rather than allowed to blow up the search. */
const MAX_GRID_NODES = 24_000

export interface BuildingShape {
  /** Inner faces, per room. */
  interiors: Vec2[][]
  /** Outer faces, per room — interior plus the wall thickness. */
  envelopes: Vec2[][]
  centrelines: Vec2[][]
  walls: WallGeometry[]
  bounds: Bounds
}

/** Plan geometry for a set of rooms — normally one storey's worth. */
export function buildingShape(project: Project, rooms: Room[] = project.rooms): BuildingShape {
  const interiors = rooms.map((r) => r.outline)
  const envelopes = rooms.map(outerOutline)
  const centrelines = rooms.map(centrelineOutline)
  const walls = rooms.flatMap(wallsOf)
  return {
    interiors,
    envelopes,
    centrelines,
    walls,
    bounds: unionBounds(envelopes.map(bounds)),
  }
}

/** One shape per storey, in storey order, plus the whole building for bounds. */
export interface LevelShapes {
  levels: Level[]
  byLevelId: Map<string, BuildingShape>
  whole: BuildingShape
}

export function levelShapes(project: Project): LevelShapes {
  const levels = sortedLevels(project)
  const byLevelId = new Map<string, BuildingShape>()
  for (const level of levels) {
    byLevelId.set(level.id, buildingShape(project, roomsOnLevel(project, level.id)))
  }
  return { levels, byLevelId, whole: buildingShape(project) }
}

/** Inside the building envelope — either open room or the thickness of a wall. */
const insideEnvelope = (shape: BuildingShape, p: Vec2): boolean =>
  shape.envelopes.some((poly) => pointInPolygon(p, poly))

/** Inside a room proper, as opposed to buried in a wall. */
const insideRoom = (shape: BuildingShape, p: Vec2): boolean =>
  shape.interiors.some((poly) => pointInPolygon(p, poly))

/** The wall whose thickness contains this point, if any. */
export function wallContaining(shape: BuildingShape, p: Vec2): WallGeometry | null {
  for (const wall of shape.walls) {
    const { point } = closestPointOnSegment(p, wall.centerA, wall.centerB)
    if (dist2(p, point) <= wall.thickness / 2 + 1) return wall
  }
  return null
}

/** A set of nodes sitting in one plane, with lookup helpers. */
export interface Layer {
  z: number
  nodes: number[]
  /** Node exactly at this plan position, or null. */
  at(graph: RouteGraph, p: Vec2): number | null
  /** Nearest node in the layer, or null when the layer is empty. */
  nearest(graph: RouteGraph, p: Vec2): number | null
}

function makeLayer(z: number, nodes: number[]): Layer {
  const set = new Set(nodes)
  return {
    z,
    nodes,
    at(graph, p) {
      const index = graph.find({ x: p.x, y: p.y, z })
      return index !== undefined && set.has(index) ? index : null
    },
    nearest(graph, p) {
      let best: number | null = null
      let bestDist = Infinity
      for (const index of nodes) {
        const q = graph.position(index)
        const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y)
        if (d < bestDist) {
          bestDist = d
          best = index
        }
      }
      return best
    },
  }
}

export interface PlanLines {
  xs: number[]
  ys: number[]
}

/**
 * The coordinate lattice, computed once from the **whole building** and shared by every
 * storey's grid.
 *
 * Sharing it is what makes vertical alignment free: a plan position that exists on the
 * ground floor exists at the same x and y upstairs, so a riser is a single edge between two
 * nodes rather than a search for a near-match.
 */
export function planLines(
  project: Project,
  attachAt: Vec2[] = [],
  /**
   * Overlay a square lattice at this pitch on top of the geometry lines.
   *
   * Only the diagonal strategy needs it. A Hanan grid has cells of every shape, so a
   * corner-to-corner edge across one would be at an arbitrary angle and unbuildable; a square
   * cell gives an edge at exactly 45°, which is a fitting you can actually buy.
   */
  uniformPitch?: number,
): PlanLines {
  const xSeed: number[] = []
  const ySeed: number[] = []
  const push = (p: Vec2) => {
    xSeed.push(p.x)
    ySeed.push(p.y)
  }

  for (const p of attachAt) push(p)
  for (const room of project.rooms) {
    for (const poly of [room.outline, outerOutline(room), centrelineOutline(room)]) {
      for (const p of poly) push(p)
    }
  }
  for (const point of project.servicePoints) push(point.position)

  if (uniformPitch && uniformPitch > 0 && project.rooms.length > 0) {
    const box = expandBounds(unionBounds(project.rooms.map((r) => bounds(outerOutline(r)))), uniformPitch)
    // Anchored on the origin, so the lattice is the same wherever the building sits.
    const from = (v: number) => Math.floor(v / uniformPitch) * uniformPitch
    for (let x = from(box.min.x); x <= box.max.x; x += uniformPitch) xSeed.push(x)
    for (let y = from(box.min.y); y <= box.max.y; y += uniformPitch) ySeed.push(y)
  }

  // Coarsen until one storey's lattice fits the budget. Attachment points are seeded first,
  // and merging only ever drops a coordinate already within tolerance of a kept one.
  let tolerance = 5
  let xs = coordinateLines(xSeed, tolerance)
  let ys = coordinateLines(ySeed, tolerance)
  while (xs.length * ys.length > MAX_GRID_NODES && tolerance < 2000) {
    tolerance *= 2
    xs = coordinateLines(xSeed, tolerance)
    ys = coordinateLines(ySeed, tolerance)
  }
  return { xs, ys }
}

export interface PlaneGridOptions {
  /** Elevation of the plane. */
  z: number
  /** The shared lattice. Computed from this level alone when omitted. */
  lines?: PlanLines
  /** Extra plan points to draw grid lines through — usually terminal positions. */
  attachAt?: Vec2[]
  /** Cost multiplier for a span that passes through a wall. */
  penetrationWeight?: number
  /** When false, a run may not pass through a load-bearing wall at all. */
  allowLoadBearingPenetration?: boolean
  /** Restrict the layer to points inside a wall — used for in-wall horizontal runs. */
  wallsOnly?: boolean
}

export function buildPlaneGrid(
  graph: RouteGraph,
  project: Project,
  shape: BuildingShape,
  options: PlaneGridOptions,
): Layer {
  const {
    z,
    penetrationWeight = 3,
    allowLoadBearingPenetration = false,
    wallsOnly = false,
  } = options

  const { xs, ys } = options.lines ?? planLines(project, options.attachAt ?? [])

  const nodeAt: Array<Array<number | null>> = []
  const planPos = new Map<number, Vec2>()
  const created: number[] = []

  for (let ix = 0; ix < xs.length; ix++) {
    const column: Array<number | null> = []
    for (let iy = 0; iy < ys.length; iy++) {
      const p = { x: xs[ix], y: ys[iy] }
      const usable = insideEnvelope(shape, p) && (!wallsOnly || !insideRoom(shape, p))
      if (!usable) {
        column.push(null)
        continue
      }
      const index = graph.node({ x: p.x, y: p.y, z })
      planPos.set(index, p)
      created.push(index)
      column.push(index)
    }
    nodeAt.push(column)
  }

  const spanWeight = (a: Vec2, b: Vec2): number | null => {
    // Sample the span; a straight grid edge can leave the envelope between its endpoints.
    const steps = Math.max(2, Math.min(12, Math.ceil(dist2(a, b) / 200)))
    let crossesWall = false
    for (let s = 1; s < steps; s++) {
      const t = s / steps
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (!insideEnvelope(shape, p)) return null
      if (!insideRoom(shape, p)) {
        const wall = wallContaining(shape, p)
        if (wall?.loadBearing && !allowLoadBearingPenetration) return null
        crossesWall = true
      } else if (wallsOnly) {
        return null
      }
    }
    return crossesWall && !wallsOnly ? penetrationWeight : 1
  }

  for (let ix = 0; ix < xs.length; ix++) {
    for (let iy = 0; iy < ys.length; iy++) {
      const from = nodeAt[ix][iy]
      if (from === null) continue
      const neighbours = [
        ix + 1 < xs.length ? nodeAt[ix + 1][iy] : null,
        iy + 1 < ys.length ? nodeAt[ix][iy + 1] : null,
      ]
      for (const to of neighbours) {
        if (to === null) continue
        const weight = spanWeight(planPos.get(from) as Vec2, planPos.get(to) as Vec2)
        if (weight !== null) graph.connect(from, to, weight)
      }

    }
  }

  return makeLayer(z, created)
}

/* --------------------------------------------------------- visibility graph */

/** Above this the pairwise visibility test gets expensive; the candidate set is trimmed. */
const MAX_VISIBILITY_NODES = 220

/**
 * What a diagonal costs in fittings, expressed as the length of pipe it has to save to be
 * worth taking. Two bend pairs and the labour of setting them out, near enough.
 */
const DIAGONAL_FITTING_COST = 900

/**
 * Candidate waypoints for any-bearing routing, gathered from the **whole building**.
 *
 * Wall-centreline corners are the useful ones: they sit inside the envelope by construction,
 * they let a run hug a wall when that is shortest, and they give it somewhere to turn when a
 * straight line would leave the building. Taking them from every storey rather than just one
 * means a candidate exists at the same plan position upstairs and down, which is what lets a
 * stack find a place to drop.
 */
export function visibilityPoints(project: Project, attachAt: Vec2[] = []): Vec2[] {
  const seen = new Set<string>()
  const points: Vec2[] = []
  const add = (p: Vec2) => {
    const key = `${Math.round(p.x)},${Math.round(p.y)}`
    if (seen.has(key)) return
    seen.add(key)
    points.push({ x: Math.round(p.x), y: Math.round(p.y) })
  }

  // Terminals first: if the budget bites, these are the ones that must survive.
  for (const p of attachAt) add(p)
  for (const point of project.servicePoints) add(point.position)
  for (const room of project.rooms) {
    for (const p of centrelineOutline(room)) add(p)
  }
  return points.slice(0, MAX_VISIBILITY_NODES)
}

export interface VisibilityOptions {
  /** Shared candidate set, so the same plan positions exist on every storey. */
  points: Vec2[]
  penetrationWeight?: number
  allowLoadBearingPenetration?: boolean
}

/**
 * Overlay straight, any-bearing runs between mutually visible points on an existing layer.
 *
 * This is what the diagonal drainage strategy adds. A horizontal drain needs no fitting to
 * travel at 37° — it is simply a straight pipe pointing that way, and the only fittings
 * involved are the 45° pairs where it leaves and rejoins the vertical. So the plan geometry
 * does not have to sit on a lattice.
 *
 * It is an overlay rather than a replacement because the two do different jobs. The straight
 * edges give short hauls between the points that matter; the grid underneath gives the tree
 * somewhere to branch. On its own, a visibility graph can only join branches at its handful
 * of candidate points, which pushes the solver towards a star of separate runs — more pipe in
 * total, even though each individual run is shorter.
 */
export function addVisibilityEdges(
  graph: RouteGraph,
  shape: BuildingShape,
  layer: Layer,
  options: VisibilityOptions,
): number {
  const { points, penetrationWeight = 1.5, allowLoadBearingPenetration = false } = options

  const usable: Array<{ node: number; p: Vec2 }> = []
  for (const p of points) {
    if (!insideEnvelope(shape, p)) continue
    const node = layer.at(graph, p)
    if (node !== null) usable.push({ node, p })
  }

  /** Cost of running straight between two points, or null when the line leaves the building. */
  const spanWeight = (a: Vec2, b: Vec2): number | null => {
    const distance = dist2(a, b)
    // Sample proportionally to length; a long span crossing a courtyard has to be caught.
    const steps = Math.max(4, Math.min(48, Math.ceil(distance / 150)))
    let crossesWall = false
    for (let s = 1; s < steps; s++) {
      const t = s / steps
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (!insideEnvelope(shape, p)) return null
      if (!insideRoom(shape, p)) {
        const wall = wallContaining(shape, p)
        if (wall?.loadBearing && !allowLoadBearingPenetration) return null
        crossesWall = true
      }
    }
    return crossesWall ? penetrationWeight : 1
  }

  let added = 0
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      // Axis-aligned pairs already have a grid path of the same length; a duplicate edge
      // would only give the search two identical options to churn over.
      const a = usable[i].p
      const b = usable[j].p
      if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) continue
      const weight = spanWeight(a, b)
      if (weight === null) continue

      // Leaving the grid and coming back costs a pair of bends at each end. Charging for
      // that — as a fixed sum folded into the multiplier, since cost is length × weight —
      // is what stops the solver cutting a diagonal to save 80 mm. A long haul still wins
      // easily; a short hop is left to join the branch its neighbours are already on.
      const length = dist2(a, b)
      const surcharge = length > 0 ? 1 + DIAGONAL_FITTING_COST / length : 1
      if (graph.connect(usable[i].node, usable[j].node, weight * surcharge) >= 0) added += 1
    }
  }
  return added
}

/* ---------------------------------------------------------------- wall graph */

export interface WallGraphOptions {
  /** Height above each room's floor at which the horizontal run sits. */
  heightAboveFloor: number
  /** Sampling pitch along a wall. */
  step?: number
  /** Extra plan points to guarantee a node at — terminal projections. */
  attachAt?: Vec2[]
  /** Restrict to one storey's rooms. Defaults to the whole project. */
  rooms?: Room[]
}

/** Openings block a run at the height it would pass through them. */
function blockedByOpening(openings: Opening[], wall: WallGeometry, t: number, z: number): boolean {
  return openings.some((o) => {
    if (o.wallIndex !== wall.index) return false
    const half = o.width / 2
    const withinSpan = t >= o.offset - half && t <= o.offset + half
    const withinHeight = z >= o.sillHeight && z <= o.sillHeight + o.height
    return withinSpan && withinHeight
  })
}

/**
 * Wall-following network. Nodes sit on wall centrelines, so different rooms may put them at
 * different elevations — the returned Layer's `z` is only nominal.
 */
export function buildWallGraph(
  graph: RouteGraph,
  project: Project,
  options: WallGraphOptions,
): Layer {
  const { heightAboveFloor, step = 300 } = options
  const rooms = options.rooms ?? project.rooms
  const created: number[] = []
  const placed: Array<{ node: number; p: Vec2; z: number }> = []

  for (const room of rooms) {
    const openings = project.openings.filter((o) => o.roomId === room.id)
    const z = room.floorZ + heightAboveFloor

    for (const wall of wallsOf(room)) {
      const span = dist2(wall.centerA, wall.centerB)
      if (span < 1) continue

      // Node positions along the wall: both ends, a regular sample, and anything the caller
      // asked to attach to, so terminals land exactly on a node instead of near one.
      const stops = new Set<number>([0, Math.round(span)])
      for (let d = step; d < span; d += step) stops.add(Math.round(d))
      for (const target of options.attachAt ?? []) {
        const { point, t } = closestPointOnSegment(target, wall.centerA, wall.centerB)
        if (dist2(target, point) < wall.thickness * 2) stops.add(Math.round(t * span))
      }

      let previous: { node: number; t: number } | null = null
      for (const t of [...stops].sort((a, b) => a - b)) {
        const ratio = t / span
        const p = {
          x: wall.centerA.x + (wall.centerB.x - wall.centerA.x) * ratio,
          y: wall.centerA.y + (wall.centerB.y - wall.centerA.y) * ratio,
        }
        const node = graph.node({ x: p.x, y: p.y, z })
        created.push(node)
        placed.push({ node, p, z })
        if (previous && !blockedByOpening(openings, wall, (previous.t + t) / 2, heightAboveFloor)) {
          graph.connect(previous.node, node, 1)
        }
        previous = { node, t }
      }
    }
  }

  // Rooms drawn side by side normally share a centreline exactly, so their nodes merge on
  // the key. Bridge anything that only *nearly* lines up, at a small cost premium. The
  // height check keeps this from silently bridging one storey to the next.
  const threshold = Math.max(100, ...rooms.map((r) => r.wallThickness)) * 1.3
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]
      const b = placed[j]
      if (a.node === b.node || Math.abs(a.z - b.z) > 1) continue
      if (dist2(a.p, b.p) > threshold) continue
      graph.connect(a.node, b.node, 2)
    }
  }

  const nominalZ = placed[0]?.z ?? 0
  return makeLayer(nominalZ, [...new Set(created)])
}

/**
 * Link two layers with vertical runs wherever their nodes share a plan position.
 *
 * Used both within a storey — a cable leaving the wall zone to cross the ceiling to a light —
 * and between storeys, where `allow` restricts the crossing to somewhere it is structurally
 * possible.
 */
export function linkLayersVertically(
  graph: RouteGraph,
  lower: Layer,
  upper: Layer,
  weight = 1,
  tolerance = 1,
  allow?: (p: Vec2) => boolean,
): number[] {
  const byKey = new Map<string, number>()
  for (const node of lower.nodes) {
    const p = graph.position(node)
    byKey.set(`${Math.round(p.x / tolerance)},${Math.round(p.y / tolerance)}`, node)
  }
  const created: number[] = []
  for (const node of upper.nodes) {
    const p = graph.position(node)
    const match = byKey.get(`${Math.round(p.x / tolerance)},${Math.round(p.y / tolerance)}`)
    if (match === undefined) continue
    if (allow && !allow({ x: p.x, y: p.y })) continue
    const id = graph.connect(match, node, weight)
    if (id >= 0) created.push(id)
  }
  return created
}

/**
 * Vertical crossings between two storeys.
 *
 * A pipe or cable may only pass through a slab inside a wall that exists on **both** storeys
 * — that is where a builder puts a chase or a duct, and it is the difference between a soil
 * stack and a pipe hanging through the middle of someone's ceiling.
 *
 * The cost is deliberately steep. Crossing is not forbidden, but each crossing has to earn
 * itself, so the Steiner tree's reuse discount pulls every upstairs branch onto the same
 * riser instead of punching a separate hole for each fixture. The stack is not placed; it
 * falls out of the search.
 */
export function linkStoreys(
  graph: RouteGraph,
  lower: { layer: Layer; shape: BuildingShape },
  upper: { layer: Layer; shape: BuildingShape },
  weight: number,
): number[] {
  const insideBothWalls = (p: Vec2): boolean =>
    wallContaining(lower.shape, p) !== null && wallContaining(upper.shape, p) !== null
  return linkLayersVertically(graph, lower.layer, upper.layer, weight, 1, insideBothWalls)
}

/**
 * Attach a terminal point to a layer: a short spur across to the layer node's plan position,
 * then a vertical riser. Returns the graph node representing the terminal.
 *
 * The spur is broken into one move per axis. A single hop covering both would be a diagonal
 * at whatever angle the offset happens to be — not something anyone can fit — and the
 * coincident cases collapse to the same node, so the chain stays connected either way.
 */
export function attachTerminal(
  graph: RouteGraph,
  layer: Layer,
  point: { x: number; y: number; z: number },
  weight = 1,
  /**
   * Plan position the connection must pass through before turning vertical. Back entry uses
   * it to put the riser inside the wall behind the appliance instead of in front of it.
   */
  via?: Vec2,
): number | null {
  const search = via ?? point
  const layerNode = layer.at(graph, search) ?? layer.nearest(graph, search)
  if (layerNode === null) return null
  const layerPos = graph.position(layerNode)

  const terminal = graph.node(point)
  let cursor = terminal

  if (via && (Math.abs(via.x - point.x) > 1 || Math.abs(via.y - point.y) > 1)) {
    const back = graph.node({ x: via.x, y: via.y, z: point.z })
    graph.connect(cursor, back, weight)
    cursor = back
  }

  const from = graph.position(cursor)
  if (Math.abs(layerPos.x - from.x) < 1 && Math.abs(layerPos.y - from.y) < 1) {
    graph.connect(cursor, layerNode, weight)
    return terminal
  }

  const alongX = graph.node({ x: layerPos.x, y: from.y, z: point.z })
  const overhead = graph.node({ x: layerPos.x, y: layerPos.y, z: point.z })
  graph.connect(cursor, alongX, weight)
  graph.connect(alongX, overhead, weight)
  graph.connect(overhead, layerNode, weight)
  return terminal
}
