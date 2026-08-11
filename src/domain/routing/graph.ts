/**
 * The routing graph.
 *
 * Nodes are 3-D points quantised to the millimetre; edges are axis-aligned and carry both a
 * physical length and a weighted cost, so a route can be discouraged from somewhere (a wall
 * penetration, an awkward layer) without lying about how much pipe it uses.
 */

import type { Vec3 } from '../geometry/vec.ts'

/**
 * Direction encoding.
 *
 * A direction is the sign triple of the step, packed into one number — 27 combinations, of
 * which the all-zero one never occurs. Signs rather than axes because the diagonal routing
 * strategy needs to distinguish "north-east" from "north", and the search charges for a
 * change of direction: with an axis-only encoding a 45° turn would look free.
 *
 * Every diagonal edge the builders create is at exactly 45°, so a sign triple identifies a
 * direction unambiguously.
 */
export const DIR_NONE = 27
export const DIR_COUNT = 28

const signOf = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0)

export function directionIndex(from: Vec3, to: Vec3): number {
  const sx = signOf(Math.round(to.x - from.x))
  const sy = signOf(Math.round(to.y - from.y))
  const sz = signOf(Math.round(to.z - from.z))
  return (sx + 1) * 9 + (sy + 1) * 3 + (sz + 1)
}

export function dirVector(dir: number): Vec3 {
  if (dir < 0 || dir >= 27) return { x: 0, y: 0, z: 0 }
  return { x: ((dir / 9) | 0) - 1, y: (((dir / 3) | 0) % 3) - 1, z: (dir % 3) - 1 }
}

/** True when two directions lie on the same line, whichever way each points. */
export function sameAxis(a: number, b: number): boolean {
  const va = dirVector(a)
  const vb = dirVector(b)
  return (
    (va.x === vb.x && va.y === vb.y && va.z === vb.z) ||
    (va.x === -vb.x && va.y === -vb.y && va.z === -vb.z)
  )
}

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
    // True length, not Manhattan: a 45° diagonal has to be cheaper than the two legs it
    // replaces, or the diagonal strategy would never prefer one.
    const length = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)
    if (length === 0) return -1
    const id = this.edgeSeq++
    const cost = length * weight
    this.adj[a].push({ to: b, cost, length, dir: directionIndex(pa, pb), id })
    this.adj[b].push({ to: a, cost, length, dir: directionIndex(pb, pa), id })
    return id
  }

  /**
   * A free edge with no geometry of its own.
   *
   * Used to tie several real roots — three drain outlets, two consumer units — to one virtual
   * root, so a single tree search can decide which of them each terminal should belong to
   * rather than the caller guessing. Zero cost and zero length, so it never shows up in a
   * route's price or its measured run.
   */
  connectVirtual(a: number, b: number): number {
    if (a === b) return -1
    const id = this.edgeSeq++
    this.adj[a].push({ to: b, cost: 0, length: 0, dir: DIR_NONE, id })
    this.adj[b].push({ to: a, cost: 0, length: 0, dir: DIR_NONE, id })
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
