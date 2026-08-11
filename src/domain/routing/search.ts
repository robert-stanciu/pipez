/**
 * Shortest-path search over the routing graph.
 *
 * The search state is (node, direction-of-arrival) rather than just (node). That extra
 * dimension is what lets us charge for a change of direction: without it the cheapest path
 * is a staircase of tiny jogs that costs the same as a straight run but needs a dozen
 * elbows. With it, routes come out as long straight runs — which is both cheaper to install
 * and what a person would have drawn.
 */

import { DIR_COUNT, DIR_NONE, type RouteGraph } from './graph.ts'

class MinHeap {
  private cost: number[] = []
  private item: number[] = []

  get size(): number {
    return this.item.length
  }

  push(cost: number, item: number): void {
    this.cost.push(cost)
    this.item.push(item)
    let i = this.item.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.cost[parent] <= this.cost[i]) break
      this.swap(parent, i)
      i = parent
    }
  }

  pop(): { cost: number; item: number } | undefined {
    if (this.item.length === 0) return undefined
    const top = { cost: this.cost[0], item: this.item[0] }
    const lastCost = this.cost.pop() as number
    const lastItem = this.item.pop() as number
    if (this.item.length > 0) {
      this.cost[0] = lastCost
      this.item[0] = lastItem
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        if (left < this.item.length && this.cost[left] < this.cost[smallest]) smallest = left
        if (right < this.item.length && this.cost[right] < this.cost[smallest]) smallest = right
        if (smallest === i) break
        this.swap(smallest, i)
        i = smallest
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    const c = this.cost[a]
    this.cost[a] = this.cost[b]
    this.cost[b] = c
    const it = this.item[a]
    this.item[a] = this.item[b]
    this.item[b] = it
  }
}

export interface SearchOptions {
  /** Cost added for every change of axis, in mm-equivalent. */
  turnPenalty: number
  /**
   * Multiplier applied to edges the tree already occupies. Well below 1, so a new branch
   * prefers to join an existing trunk and run alongside it rather than take its own path —
   * this is what turns a star of independent routes into a real, bundled network.
   */
  reuseDiscount: number
  /** Edge ids the tree already uses. */
  usedEdges: Set<number>
}

export interface PathResult {
  /** Node indices from source to the target that was reached. */
  path: number[]
  /** Edge ids traversed, in order. */
  edgeIds: number[]
  cost: number
  length: number
}

/**
 * Dijkstra from `source`, stopping at the first node for which `isTarget` holds.
 *
 * Returns null when no target is reachable.
 */
export function shortestPathToSet(
  graph: RouteGraph,
  source: number,
  isTarget: (node: number) => boolean,
  options: SearchOptions,
): PathResult | null {
  const stateCount = graph.nodeCount * DIR_COUNT
  const dist = new Float64Array(stateCount).fill(Infinity)
  const prevState = new Int32Array(stateCount).fill(-1)
  const prevEdge = new Int32Array(stateCount).fill(-1)
  const visited = new Uint8Array(stateCount)

  const startState = source * DIR_COUNT + DIR_NONE
  dist[startState] = 0
  const heap = new MinHeap()
  heap.push(0, startState)

  let goalState = -1

  while (heap.size > 0) {
    const top = heap.pop()
    if (!top) break
    const state = top.item
    if (visited[state]) continue
    visited[state] = 1

    const node = (state / DIR_COUNT) | 0
    const arrivedFrom = state % DIR_COUNT

    if (node !== source && isTarget(node)) {
      goalState = state
      break
    }

    for (const edge of graph.adj[node]) {
      const reused = options.usedEdges.has(edge.id)
      let step = reused ? edge.cost * options.reuseDiscount : edge.cost
      // Turning costs, but not when joining a run that already exists.
      if (arrivedFrom !== DIR_NONE && arrivedFrom !== edge.dir && !reused) {
        step += options.turnPenalty
      }
      const nextState = edge.to * DIR_COUNT + edge.dir
      const candidate = top.cost + step
      if (candidate < dist[nextState]) {
        dist[nextState] = candidate
        prevState[nextState] = state
        prevEdge[nextState] = edge.id
        heap.push(candidate, nextState)
      }
    }
  }

  if (goalState < 0) return null

  const path: number[] = []
  const edgeIds: number[] = []
  let state = goalState
  while (state >= 0) {
    path.push((state / DIR_COUNT) | 0)
    const edge = prevEdge[state]
    if (edge >= 0) edgeIds.push(edge)
    state = prevState[state]
  }
  path.reverse()
  edgeIds.reverse()

  let length = 0
  for (let i = 1; i < path.length; i++) {
    const a = graph.position(path[i - 1])
    const b = graph.position(path[i])
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }

  return { path, edgeIds, cost: dist[goalState], length }
}
