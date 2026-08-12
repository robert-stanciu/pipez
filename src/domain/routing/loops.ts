/**
 * Setting out an underfloor heating coil inside a room.
 *
 * This is a covering problem rather than a routing one — there is no destination to reach,
 * only a floor to fill evenly with one unbroken pipe — so it does not use the graph at all.
 *
 * The pattern is a **serpentine with a perimeter return**: the pipe leaves the manifold side
 * of the room, meanders across the interior in parallel runs at the design pitch, and comes
 * back to where it started round the outside of the room. That gets three things at once:
 *
 *  - both ends of the loop finish at the same corner, so the flow and return leaders leave
 *    the room together instead of one of them crossing the coil to get home;
 *  - the perimeter leg puts a second run of pipe along the external walls, where the losses
 *    are — the peripheral zone EN 1264-2 allows a warmer surface in;
 *  - nothing crosses anything, which a counterflow (bifilar) meander cannot manage: its end
 *    turns interleave, and on a plan they intersect however they are drawn.
 *
 * A room too big for one loop is cut into bands across the run direction, and each band gets
 * the same treatment. Cutting the *room* rather than dividing the *field* is what keeps each
 * loop's perimeter leg on real wall.
 */

import {
  area as polygonArea,
  bounds,
  clipToHalfPlane,
  edgesOf,
  offsetPolygon,
  pointInPolygon,
  signedArea,
} from '../geometry/polygon.ts'
import { add2, dist2, dot2, norm2, perp2, scale2, sub2, type Vec2 } from '../geometry/vec.ts'

/** Shortest run worth laying: anything less is a stub in a corner, not a length of floor. */
const MIN_RUN = 400

/** Gap left in the perimeter ring where the two leaders pass through, mm. */
const CONNECTION_GAP = 200

export interface LoopLayout {
  /** The coil, as one plan polyline from the flow connection to the return connection. */
  path: Vec2[]
  /** Pipe laid inside the room, mm. */
  length: number
  /** Floor area this loop covers, m². */
  area: number
  /**
   * Floor area per metre of pipe, mm — the pitch the coil actually achieves once the
   * perimeter leg and anything it had to lay round are counted. This, rather than the pitch
   * that was asked for, is what the output is calculated from.
   */
  effectivePitch: number
}

export interface LoopOptions {
  /**
   * The polygon to lay pipe in — inner faces. For one loop in one room that is the room; for
   * one of several it reaches a little past its share, so the coils of neighbouring loops
   * meet at the design pitch instead of leaving a bare strip down the middle of the floor.
   */
  outline: Vec2[]
  /** The floor this loop is credited with, when that is not the polygon it lays in. */
  extent?: Vec2[]
  /** Footprints the coil may not pass under: a WC, a bath, a floor drain. */
  obstacles: Vec2[][]
  /** Design pipe pitch, mm. */
  spacing: number
  /** How close to the wall the perimeter run may be laid, mm. */
  clearance: number
  /** Where the manifold is, in plan — the loop starts and ends at the nearest point to it. */
  anchor: Vec2
}

/* ------------------------------------------------------------------- the ring */

/** A closed polyline with cumulative arc lengths, walkable by distance. */
interface Ring {
  points: Vec2[]
  /** Cumulative length at each vertex; the last entry is the perimeter. */
  cumulative: number[]
  length: number
}

function makeRing(points: Vec2[]): Ring {
  const cumulative: number[] = [0]
  let total = 0
  for (let i = 0; i < points.length; i++) {
    total += dist2(points[i], points[(i + 1) % points.length])
    cumulative.push(total)
  }
  return { points, cumulative, length: total }
}

/** The point at an arc-length parameter, wrapped into the ring. */
function ringPoint(ring: Ring, at: number): Vec2 {
  const t = ((at % ring.length) + ring.length) % ring.length
  for (let i = 0; i < ring.points.length; i++) {
    if (t <= ring.cumulative[i + 1]) {
      const span = ring.cumulative[i + 1] - ring.cumulative[i]
      const k = span < 1e-9 ? 0 : (t - ring.cumulative[i]) / span
      const a = ring.points[i]
      const b = ring.points[(i + 1) % ring.points.length]
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    }
  }
  return { ...ring.points[0] }
}

/** Arc-length parameter of the ring point closest to `p`. */
function ringParamNear(ring: Ring, p: Vec2): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < ring.points.length; i++) {
    const a = ring.points[i]
    const b = ring.points[(i + 1) % ring.points.length]
    const ab = sub2(b, a)
    const lengthSq = dot2(ab, ab)
    const k = lengthSq < 1e-9 ? 0 : Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / lengthSq))
    const point = add2(a, scale2(ab, k))
    const distance = dist2(p, point)
    if (distance < bestDistance) {
      bestDistance = distance
      best = ring.cumulative[i] + k * Math.sqrt(lengthSq)
    }
  }
  return best
}

/**
 * Points along the ring from one parameter to another, in the given direction, including
 * every corner passed and the destination itself.
 */
function walkRing(ring: Ring, from: number, to: number, forward: boolean): Vec2[] {
  const out: Vec2[] = []
  const span = forward
    ? (((to - from) % ring.length) + ring.length) % ring.length
    : (((from - to) % ring.length) + ring.length) % ring.length

  // Corner parameters, in the order the walk meets them.
  const corners = ring.cumulative.slice(0, ring.points.length)
  const offsets = corners
    .map((c) => (forward ? c - from : from - c))
    .map((d) => ((d % ring.length) + ring.length) % ring.length)
    .filter((d) => d > 1 && d < span - 1)
    .sort((a, b) => a - b)

  for (const d of offsets) out.push(ringPoint(ring, forward ? from + d : from - d))
  out.push(ringPoint(ring, to))
  return out
}

/* ------------------------------------------------------------- the line field */

interface Span {
  a: Vec2
  b: Vec2
  length: number
}

/** Where an infinite line crosses a polygon, as parameters along `u`. */
function crossings(poly: Vec2[], origin: Vec2, u: Vec2, n: Vec2): number[] {
  const out: number[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const sa = dot2(sub2(a, origin), n)
    const sb = dot2(sub2(b, origin), n)
    if (sa > 0 === sb > 0) continue
    const k = sa / (sa - sb)
    const point = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    out.push(dot2(sub2(point, origin), u))
  }
  return out.sort((l, r) => l - r)
}

/** Intervals of `spans` with `holes` taken out of them. */
function subtract(
  spans: Array<[number, number]>,
  holes: Array<[number, number]>,
): Array<[number, number]> {
  let result = spans
  for (const [hi, ho] of holes) {
    const next: Array<[number, number]> = []
    for (const [lo, up] of result) {
      if (ho <= lo || hi >= up) {
        next.push([lo, up])
        continue
      }
      if (hi > lo) next.push([lo, hi])
      if (ho < up) next.push([ho, up])
    }
    result = next
  }
  return result
}

/**
 * Parallel runs across a polygon at a pitch no coarser than `spacing`.
 *
 * The pitch is the width of the field divided by a whole number of runs, so the coil is
 * evenly spread rather than leaving a wide bare strip against the last wall — and it is only
 * ever tighter than what was asked for, never looser.
 */
function lineField(
  poly: Vec2[],
  obstacles: Vec2[][],
  u: Vec2,
  n: Vec2,
  spacing: number,
): Span[] {
  const offsets = poly.map((p) => dot2(p, n))
  const low = Math.min(...offsets)
  const high = Math.max(...offsets)
  const width = high - low
  if (width < 1) return []

  const count = Math.max(1, Math.ceil(width / spacing))
  const pitch = width / count
  const spans: Span[] = []

  for (let k = 0; k < count; k++) {
    const offset = low + (k + 0.5) * pitch
    // A point on this line, and the frame to measure along it.
    const origin = scale2(n, offset)
    const hits = crossings(poly, origin, u, n)
    if (hits.length < 2) continue

    let intervals: Array<[number, number]> = []
    for (let i = 0; i + 1 < hits.length; i += 2) intervals.push([hits[i], hits[i + 1]])
    for (const obstacle of obstacles) {
      const blocked = crossings(obstacle, origin, u, n)
      const holes: Array<[number, number]> = []
      for (let i = 0; i + 1 < blocked.length; i += 2) holes.push([blocked[i], blocked[i + 1]])
      intervals = subtract(intervals, holes)
    }

    // One run per line: the coil is continuous, so a line broken by a bath contributes the
    // longer of the two pieces rather than both with a jump across the bath between them.
    let best: [number, number] | null = null
    for (const interval of intervals) {
      if (!best || interval[1] - interval[0] > best[1] - best[0]) best = interval
    }
    if (!best || best[1] - best[0] < MIN_RUN) continue
    spans.push({
      a: add2(origin, scale2(u, best[0])),
      b: add2(origin, scale2(u, best[1])),
      length: best[1] - best[0],
    })
  }

  return spans
}

/* ---------------------------------------------------------------- the pattern */

/** Longest edge of the outline — the direction the runs are laid in. */
function runDirection(outline: Vec2[]): Vec2 {
  let best = { x: 1, y: 0 }
  let bestLength = -1
  for (const edge of edgesOf(outline)) {
    if (edge.length > bestLength) {
      bestLength = edge.length
      best = edge.dir
    }
  }
  return norm2(best)
}

/** An inward offset that is still a real polygon inside the original. */
function inset(outline: Vec2[], distance: number): Vec2[] | null {
  if (distance <= 0) return [...outline]
  const result = offsetPolygon(outline, -distance)
  if (result.length < 3) return null
  // Offsetting a room in by more than half its width turns the polygon inside out, and an
  // inside-out rectangle still has a perfectly plausible area and vertices that still test as
  // inside the room. The winding is what gives it away: it reverses.
  if (Math.sign(signedArea(result)) !== Math.sign(signedArea(outline))) return null
  if (!result.every((p) => pointInPolygon(p, outline))) return null
  return polygonArea(result) > 1000 ? result : null
}

export interface Band {
  /** The polygon to lay in — the band, grown across its cuts so the coils meet. */
  lay: Vec2[]
  /** The band's own share of the floor, which is what its output is credited against. */
  extent: Vec2[]
}

/**
 * Cut a room into `count` bands, each of which becomes one loop.
 *
 * The cut runs **across the long axis**, so the bands come out as square as the room allows.
 * Cutting the other way would slice a 1,8 m bathroom into two 900 mm ribbons, and after the
 * clearance at each wall there would be almost nothing left in the middle of either to lay
 * pipe in.
 *
 * Each band is then grown by the width of the dead border either side of a cut, so that after
 * both are set out their outermost runs sit one pitch apart across it rather than leaving a
 * cold strip down the middle of the room. The band's *extent* — its true, un-grown share — is
 * carried alongside, because that is the floor area it heats.
 */
export function splitBands(outline: Vec2[], count: number, overlap: number): Band[] {
  if (count <= 1) return [{ lay: outline, extent: outline }]
  // Across the long axis: the normal of the cut is the direction the room is longest in.
  const n = runDirection(outline)
  const offsets = outline.map((p) => dot2(p, n))
  const low = Math.min(...offsets)
  const high = Math.max(...offsets)

  const bands: Band[] = []
  for (let k = 0; k < count; k++) {
    const from = low + ((high - low) * k) / count
    const to = low + ((high - low) * (k + 1)) / count
    const strip = (lower: number, upper: number): Vec2[] => {
      const clipped = clipToHalfPlane(outline, scale2(n, upper), n)
      return clipToHalfPlane(clipped, scale2(n, lower), scale2(n, -1))
    }
    const extent = strip(from, to)
    // Only internal cuts are grown; the outer edges are real wall and keep their clearance.
    const lay = strip(k === 0 ? from : from - overlap, k === count - 1 ? to : to + overlap)
    if (extent.length >= 3 && lay.length >= 3) bands.push({ lay, extent })
  }
  return bands.length === count ? bands : [{ lay: outline, extent: outline }]
}

/**
 * Lay one coil.
 *
 * Returns null where the band is too small or too obstructed to take one — which the caller
 * reports rather than papering over with a token length of pipe.
 */
export function layLoop(options: LoopOptions): LoopLayout | null {
  const { outline, obstacles, spacing, clearance, anchor } = options

  const ringOutline = inset(outline, clearance)
  if (!ringOutline) return null
  const ring = makeRing(ringOutline)
  if (ring.length < 1000) return null

  const u = runDirection(outline)
  const n = perp2(u)
  const field = inset(outline, clearance + spacing)
  const spans = field ? lineField(field, obstacles, u, n, spacing) : []

  const flowParam = ringParamNear(ring, anchor)
  const path: Vec2[] = [ringPoint(ring, flowParam)]

  const credited = options.extent ?? outline

  if (spans.length === 0) {
    // Nothing to meander: a single run round the room, which is what a WC compartment or a
    // lobby gets in practice.
    const returnParam = flowParam + CONNECTION_GAP
    path.push(...walkRing(ring, flowParam, returnParam, false))
    return finish(path, credited)
  }

  // Start at whichever end of the field is nearer the manifold, so the first run is the one
  // closest to home and the coil works away from it.
  const ordered =
    dist2(anchor, midpoint(spans[0])) <= dist2(anchor, midpoint(spans[spans.length - 1]))
      ? spans
      : [...spans].reverse()

  let cursor = path[0]
  for (const span of ordered) {
    const headFirst = dist2(cursor, span.a) <= dist2(cursor, span.b)
    const entry = headFirst ? span.a : span.b
    const exit = headFirst ? span.b : span.a
    path.push(entry, exit)
    cursor = exit
  }

  // Back to the manifold round the outside. The gap is put on whichever side makes that walk
  // the shorter one, so the return leg never doubles back past the flow connection.
  const exitParam = ringParamNear(ring, cursor)
  const forwardGap = wrap(exitParam - (flowParam + CONNECTION_GAP), ring.length)
  const backwardGap = wrap(flowParam - CONNECTION_GAP - exitParam, ring.length)
  const forward = backwardGap < forwardGap
  const returnParam = forward ? flowParam - CONNECTION_GAP : flowParam + CONNECTION_GAP

  path.push(ringPoint(ring, exitParam))
  path.push(...walkRing(ring, exitParam, returnParam, forward))
  return finish(path, credited)
}

const wrap = (value: number, length: number): number => ((value % length) + length) % length

const midpoint = (span: Span): Vec2 => ({
  x: (span.a.x + span.b.x) / 2,
  y: (span.a.y + span.b.y) / 2,
})

function finish(raw: Vec2[], credited: Vec2[]): LoopLayout | null {
  // Consecutive duplicates come out of the ring walk whenever a corner sits on a connection
  // point; they would show up as zero-length pipe on the schedule.
  const path: Vec2[] = []
  for (const point of raw) {
    const last = path[path.length - 1]
    if (!last || dist2(last, point) > 1) path.push(point)
  }
  if (path.length < 2) return null

  let length = 0
  for (let i = 1; i < path.length; i++) length += dist2(path[i - 1], path[i])
  if (length < 1000) return null

  const area = polygonArea(credited) / 1e6
  return {
    path,
    length,
    area,
    effectivePitch: (area * 1e6) / length,
  }
}

/** Rough plan extent of a room, for the movement-joint checks. */
export function longestSide(outline: Vec2[]): number {
  const box = bounds(outline)
  return Math.max(box.max.x - box.min.x, box.max.y - box.min.y)
}
