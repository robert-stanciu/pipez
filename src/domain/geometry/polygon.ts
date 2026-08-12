/** Polygon helpers for room outlines. Outlines are closed, non-self-intersecting, in mm. */

import {
  add2,
  cross2,
  dist2,
  lineIntersection,
  norm2,
  perp2,
  scale2,
  sub2,
  type Vec2,
} from './vec.ts'

export interface Edge {
  index: number
  a: Vec2
  b: Vec2
  /** Unit vector from a to b. */
  dir: Vec2
  /** Unit normal pointing **out** of the polygon. */
  normal: Vec2
  length: number
  midpoint: Vec2
}

export function signedArea(poly: Vec2[]): number {
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    sum += cross2(a, b)
  }
  return sum / 2
}

export const isCounterClockwise = (poly: Vec2[]): boolean => signedArea(poly) > 0

/** Normalise winding to counter-clockwise so outward normals are computed consistently. */
export const ensureCounterClockwise = (poly: Vec2[]): Vec2[] =>
  isCounterClockwise(poly) ? poly : [...poly].reverse()

export const area = (poly: Vec2[]): number => Math.abs(signedArea(poly))

export function perimeter(poly: Vec2[]): number {
  let total = 0
  for (let i = 0; i < poly.length; i++) total += dist2(poly[i], poly[(i + 1) % poly.length])
  return total
}

export function centroid(poly: Vec2[]): Vec2 {
  const a = signedArea(poly)
  if (Math.abs(a) < 1e-9) {
    // Degenerate polygon — fall back to the average of the vertices.
    const sum = poly.reduce((acc, p) => add2(acc, p), { x: 0, y: 0 })
    return scale2(sum, 1 / Math.max(1, poly.length))
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const w = cross2(p, q)
    cx += (p.x + q.x) * w
    cy += (p.y + q.y) * w
  }
  return { x: cx / (6 * a), y: cy / (6 * a) }
}

export interface Bounds {
  min: Vec2
  max: Vec2
}

export function bounds(points: Vec2[]): Bounds {
  if (points.length === 0) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } }
}

export function unionBounds(list: Bounds[]): Bounds {
  if (list.length === 0) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }
  return bounds(list.flatMap((b) => [b.min, b.max]))
}

export function expandBounds(b: Bounds, by: number): Bounds {
  return { min: { x: b.min.x - by, y: b.min.y - by }, max: { x: b.max.x + by, y: b.max.y + by } }
}

/**
 * Edges of a CCW polygon with outward normals.
 *
 * For a CCW ring the interior lies to the left of each edge direction, so the outward
 * normal is the *clockwise* perpendicular of `dir`.
 */
export function edgesOf(poly: Vec2[]): Edge[] {
  const ring = ensureCounterClockwise(poly)
  const out: Edge[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const delta = sub2(b, a)
    const dir = norm2(delta)
    out.push({
      index: i,
      a,
      b,
      dir,
      normal: { x: dir.y, y: -dir.x },
      length: dist2(a, b),
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    })
  }
  return out
}

/**
 * Offset every edge outward by `distance` and re-intersect neighbouring edge lines.
 *
 * Adequate for the rectilinear and mildly convex room outlines this app produces; it does
 * not handle self-intersection from over-offsetting a deep notch, which rooms don't have.
 */
export function offsetPolygon(poly: Vec2[], distance: number): Vec2[] {
  const edges = edgesOf(poly)
  if (edges.length < 3) return [...poly]

  const result: Vec2[] = []
  for (let i = 0; i < edges.length; i++) {
    const prev = edges[(i - 1 + edges.length) % edges.length]
    const curr = edges[i]
    const prevPoint = add2(prev.a, scale2(prev.normal, distance))
    const currPoint = add2(curr.a, scale2(curr.normal, distance))
    const hit = lineIntersection(prevPoint, prev.dir, currPoint, curr.dir)
    // Parallel neighbours (a straight-through vertex) — the offset vertex is just the shift.
    result.push(hit ?? currPoint)
  }
  return result
}

/**
 * The part of a polygon on the inner side of a line — Sutherland–Hodgman against one
 * half-plane.
 *
 * "Inner" is the side the normal points away from: a vertex is kept when
 * `(p − origin) · normal ≤ 0`. Two clips with opposite normals cut a strip, which is how a
 * room too big for one heating loop is divided into the bands each loop covers.
 *
 * Clipping a concave polygon against a half-plane can leave the result touching itself along
 * the cut. That is harmless for the areas and offsets it is used for here, and rooms are
 * rectangles and L-shapes rather than combs.
 */
export function clipToHalfPlane(poly: Vec2[], origin: Vec2, normal: Vec2): Vec2[] {
  if (poly.length < 3) return []
  const side = (p: Vec2): number => (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y

  const out: Vec2[] = []
  for (let i = 0; i < poly.length; i++) {
    const current = poly[i]
    const previous = poly[(i - 1 + poly.length) % poly.length]
    const dCurrent = side(current)
    const dPrevious = side(previous)

    if (dCurrent <= 0) {
      if (dPrevious > 0) {
        const t = dPrevious / (dPrevious - dCurrent)
        out.push(lerp(previous, current, t))
      }
      out.push({ ...current })
    } else if (dPrevious <= 0) {
      const t = dPrevious / (dPrevious - dCurrent)
      out.push(lerp(previous, current, t))
    }
  }
  return out.length >= 3 ? out : []
}

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/**
 * The same offset applied to an **open** polyline: a second pipe running alongside the first
 * at a fixed distance, which is what a flow-and-return pair is.
 *
 * Interior vertices are mitred by intersecting the two offset legs, so a right-angled turn
 * comes out as a right-angled turn rather than as two lines with a notch between them. The
 * two ends simply shift sideways, there being nothing to mitre against.
 */
export function offsetPolyline(points: Vec2[], distance: number): Vec2[] {
  if (points.length < 2) return points.map((p) => ({ ...p }))
  const out: Vec2[] = []
  for (let i = 0; i < points.length; i++) {
    const inbound = i > 0 ? norm2(sub2(points[i], points[i - 1])) : null
    const outbound = i + 1 < points.length ? norm2(sub2(points[i + 1], points[i])) : null
    const shift = (dir: Vec2) => add2(points[i], scale2(perp2(dir), distance))
    if (!inbound && outbound) out.push(shift(outbound))
    else if (inbound && !outbound) out.push(shift(inbound))
    else if (inbound && outbound) {
      const a = shift(inbound)
      const b = shift(outbound)
      out.push(lineIntersection(a, inbound, b, outbound) ?? b)
    }
  }
  return out
}

/** Even-odd ray cast. Points exactly on the boundary may return either result. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    const straddles = a.y > p.y !== b.y > p.y
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Shortest distance from a point to the polygon boundary (always positive). */
export function distanceToBoundary(p: Vec2, poly: Vec2[]): number {
  let best = Infinity
  for (const edge of edgesOf(poly)) {
    const ab = sub2(edge.b, edge.a)
    const lengthSq = ab.x * ab.x + ab.y * ab.y
    let t = 0
    if (lengthSq > 1e-9) {
      const ap = sub2(p, edge.a)
      t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / lengthSq))
    }
    const closest = add2(edge.a, scale2(ab, t))
    best = Math.min(best, dist2(p, closest))
  }
  return best
}

/** Axis-aligned rectangle outline, CCW, with its lower-left corner at `origin`. */
export function rectangle(origin: Vec2, width: number, depth: number): Vec2[] {
  return [
    { x: origin.x, y: origin.y },
    { x: origin.x + width, y: origin.y },
    { x: origin.x + width, y: origin.y + depth },
    { x: origin.x, y: origin.y + depth },
  ]
}

/** True when two segments are collinear and overlap — i.e. the rooms share a wall. */
export function segmentsOverlap(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2, tol = 20): boolean {
  const dirA = norm2(sub2(a2, a1))
  const dirB = norm2(sub2(b2, b1))
  const parallel = Math.abs(cross2(dirA, dirB)) < 1e-3
  if (!parallel) return false

  // Perpendicular offset of b1 from line a.
  const n = perp2(dirA)
  const offset = Math.abs(n.x * (b1.x - a1.x) + n.y * (b1.y - a1.y))
  if (offset > tol) return false

  // Project onto dirA and test 1-D interval overlap.
  const project = (p: Vec2) => dirA.x * (p.x - a1.x) + dirA.y * (p.y - a1.y)
  const [aMin, aMax] = [0, project(a2)].sort((x, y) => x - y)
  const [bMin, bMax] = [project(b1), project(b2)].sort((x, y) => x - y)
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) > tol
}
