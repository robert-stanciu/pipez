/**
 * The routing graph.
 *
 * Nodes are 3-D points quantised to the millimetre; edges are axis-aligned and carry both a
 * physical length and a weighted cost, so a route can be discouraged from somewhere (a wall
 * penetration, an awkward layer) without lying about how much pipe it uses.
 */

import type { Vec3 } from '../geometry/vec.ts'

/** Axis directions, indexed. 6 means "no direction yet" — the start of a path. */
export const DIR_COUNT = 7
export const DIR_NONE = 6

const AXIS_DIRS: ReadonlyArray<Vec3> = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

export function directionIndex(from: Vec3, to: Vec3): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const az = Math.abs(dz)
  if (ax >= ay && ax >= az) return dx >= 0 ? 0 : 1
  if (ay >= az) return dy >= 0 ? 2 : 3
  return dz >= 0 ? 4 : 5
}

export const axisOf = (dir: number): number => (dir >= 6 ? -1 : dir >> 1)

export const dirVector = (dir: number): Vec3 => AXIS_DIRS[dir] ?? { x: 0, y: 0, z: 0 }

export interface GraphEdge {
  to: number
  /** Weighted cost used by the search. */
  cost: number
  /** True physical length in mm. */
  length: number
  dir: number
  /** Shared with the reverse edge, so "already used" is direction-agnostic. */
  id: number
}

const keyOf = (p: Vec3): string =>
  `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`

export class RouteGraph {
  readonly nodes: Vec3[] = []
  readonly adj: GraphEdge[][] = []
  private readonly keys = new Map<string, number>()
  private edgeSeq = 0

  get nodeCount(): number {
    return this.nodes.length
  }

  get edgeCount(): number {
    return this.edgeSeq
  }

  /** Look up a node without creating it. */
  find(p: Vec3): number | undefined {
    return this.keys.get(keyOf(p))
  }

  /** Get the node at this point, creating it if needed. */
  node(p: Vec3): number {
    const key = keyOf(p)
    const existing = this.keys.get(key)
    if (existing !== undefined) return existing
    const index = this.nodes.length
    this.nodes.push({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) })
    this.adj.push([])
    this.keys.set(key, index)
    return index
  }

  /**
   * Add a bidirectional edge, returning its id — or -1 when the edge is degenerate.
   *
   * `weight` scales the cost above the physical length — 1 is neutral, higher makes the
   * router avoid this edge unless it saves a comparable amount of pipe elsewhere.
   */
  connect(a: number, b: number, weight = 1): number {
    if (a === b) return -1
    const pa = this.nodes[a]
    const pb = this.nodes[b]
    const length = Math.abs(pb.x - pa.x) + Math.abs(pb.y - pa.y) + Math.abs(pb.z - pa.z)
    if (length === 0) return -1
    const id = this.edgeSeq++
    const cost = length * weight
    this.adj[a].push({ to: b, cost, length, dir: directionIndex(pa, pb), id })
    this.adj[b].push({ to: a, cost, length, dir: directionIndex(pb, pa), id })
    return id
  }

  position(index: number): Vec3 {
    return this.nodes[index]
  }
}

/** Sorted, de-duplicated coordinate lines — the skeleton of a Hanan grid. */
export function coordinateLines(values: number[], tolerance = 5): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const value of sorted) {
    const rounded = Math.round(value)
    if (out.length === 0 || rounded - out[out.length - 1] > tolerance) out.push(rounded)
  }
  return out
}
