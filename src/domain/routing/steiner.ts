/**
 * Connecting N fixtures to one source is a Steiner tree problem, which is NP-hard. We use
 * the classic shortest-path heuristic: grow the tree one terminal at a time, always taking
 * the cheapest route to *anything already in the tree*, with a heavy discount on edges the
 * tree already occupies so branches bundle into shared trunks.
 *
 * Terminals are attached furthest-first. Doing the long hauls early establishes the trunk,
 * and the short ones then have something to join; the reverse order tends to produce a star.
 */

import type { RouteGraph } from './graph.ts'
import { shortestPathToSet, type SearchOptions } from './search.ts'

export interface Terminal {
  /** Caller's handle — a fixture id, a port id, whatever it needs back. */
  ref: string
  node: number
  /** Load this terminal contributes: DU, LU or amps depending on the system. */
  load: number
  /** Minimum size the connection must be, regardless of load. */
  minSize: number
}

export interface RouteTree {
  root: number
  /** parent[n] = parent node, -1 for the root, -2 when n is not in the tree. */
  parent: Int32Array
  /** Graph edge joining n to its parent, or -1. Lets a caller ask what kind of edge it was. */
  edgeToParent: Int32Array
  /** Nodes in breadth-first order from the root. */
  order: number[]
  /** Load carried by the edge from n up to its parent. */
  loadToParent: Float64Array
  /** Largest minimum-size demand travelling over the edge from n up to its parent. */
  minSizeToParent: Float64Array
  /** Path length from n back to the root, following the tree. */
  distToRoot: Float64Array
  /** Terminals the search could not connect. */
  unreached: Terminal[]
  /** Terminals that were connected, with the node they landed on. */
  connected: Terminal[]
  usedEdges: Set<number>
}

const DEFAULT_OPTIONS: Omit<SearchOptions, 'usedEdges'> = {
  turnPenalty: 250,
  reuseDiscount: 0.15,
}

export function buildTree(
  graph: RouteGraph,
  root: number,
  terminals: Terminal[],
  options: Partial<Omit<SearchOptions, 'usedEdges'>> = {},
): RouteTree {
  const search: SearchOptions = { ...DEFAULT_OPTIONS, ...options, usedEdges: new Set<number>() }

  const inTree = new Uint8Array(graph.nodeCount)
  inTree[root] = 1

  const rootPos = graph.position(root)
  const ordered = [...terminals].sort((a, b) => {
    const pa = graph.position(a.node)
    const pb = graph.position(b.node)
    const da = Math.abs(pa.x - rootPos.x) + Math.abs(pa.y - rootPos.y) + Math.abs(pa.z - rootPos.z)
    const db = Math.abs(pb.x - rootPos.x) + Math.abs(pb.y - rootPos.y) + Math.abs(pb.z - rootPos.z)
    return db - da
  })

  const unreached: Terminal[] = []
  const connected: Terminal[] = []

  for (const terminal of ordered) {
    if (inTree[terminal.node]) {
      connected.push(terminal)
      continue
    }
    const result = shortestPathToSet(graph, terminal.node, (n) => inTree[n] === 1, search)
    if (!result) {
      unreached.push(terminal)
      continue
    }
    for (const node of result.path) inTree[node] = 1
    for (const id of result.edgeIds) search.usedEdges.add(id)
    connected.push(terminal)
  }

  return finaliseTree(graph, root, search.usedEdges, connected, unreached)
}

/** Turn the used-edge set into a rooted tree and push terminal loads up to the root. */
function finaliseTree(
  graph: RouteGraph,
  root: number,
  usedEdges: Set<number>,
  connected: Terminal[],
  unreached: Terminal[],
): RouteTree {
  const parent = new Int32Array(graph.nodeCount).fill(-2)
  const edgeToParent = new Int32Array(graph.nodeCount).fill(-1)
  const distToRoot = new Float64Array(graph.nodeCount)
  const loadToParent = new Float64Array(graph.nodeCount)
  const minSizeToParent = new Float64Array(graph.nodeCount)
  const order: number[] = []

  // Breadth-first over the used edges. The construction only ever attaches a path at a
  // single existing node, so the used-edge subgraph is acyclic and this is a real tree.
  parent[root] = -1
  const queue = [root]
  const seen = new Uint8Array(graph.nodeCount)
  seen[root] = 1
  while (queue.length > 0) {
    const node = queue.shift() as number
    order.push(node)
    for (const edge of graph.adj[node]) {
      if (!usedEdges.has(edge.id) || seen[edge.to]) continue
      seen[edge.to] = 1
      parent[edge.to] = node
      edgeToParent[edge.to] = edge.id
      distToRoot[edge.to] = distToRoot[node] + edge.length
      queue.push(edge.to)
    }
  }

  // Seed each terminal's own demand, then sum up the tree from the leaves inward.
  for (const terminal of connected) {
    if (parent[terminal.node] === -2) continue
    loadToParent[terminal.node] += terminal.load
    minSizeToParent[terminal.node] = Math.max(minSizeToParent[terminal.node], terminal.minSize)
  }
  for (let i = order.length - 1; i > 0; i--) {
    const node = order[i]
    const up = parent[node]
    if (up < 0) continue
    loadToParent[up] += loadToParent[node]
    minSizeToParent[up] = Math.max(minSizeToParent[up], minSizeToParent[node])
  }

  const stillUnreached = [...unreached]
  const reallyConnected: Terminal[] = []
  for (const terminal of connected) {
    if (parent[terminal.node] === -2) stillUnreached.push(terminal)
    else reallyConnected.push(terminal)
  }

  return {
    root,
    parent,
    edgeToParent,
    order,
    loadToParent,
    minSizeToParent,
    distToRoot,
    unreached: stillUnreached,
    connected: reallyConnected,
    usedEdges,
  }
}

/** Every (child -> parent) link in the tree, leaves first. */
export function treeLinks(tree: RouteTree): Array<{ child: number; parent: number }> {
  const links: Array<{ child: number; parent: number }> = []
  for (let i = tree.order.length - 1; i > 0; i--) {
    const child = tree.order[i]
    const up = tree.parent[child]
    if (up >= 0) links.push({ child, parent: up })
  }
  return links
}
