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
 * Three more things keep the drawing honest about what gets laid on site:
 *
 *  - **The pitch is graded.** The outer runs are drawn in to the peripheral pitch and open
 *    back out to the design pitch across the middle of the room, so the pipe is densest where
 *    the heat is lost. A uniform field leaves a wider gap at the wall than it leaves between
 *    its own runs, which is the one place a floor cannot afford one.
 *  - **The turns are square.** A run is entered from the run before it across the pitch and
 *    then along, never on the diagonal, and a run broken by a bath is picked up on the side
 *    the coil is already on rather than jumped to across the obstacle.
 *  - **The corners are bent, not mitred.** Every turn is swept at the radius the pipe is
 *    actually bent to, which is both what is installed and what the length is measured along.
 *
 * A room too big for one loop is cut into bands across the run direction, and each band gets
 * the same treatment. Cutting the *room* rather than dividing the *field* is what keeps each
 * loop's perimeter leg on real wall.
 */

import {
  area as polygonArea,
  bounds,
  clipToHalfPlane,
  distanceToBoundary,
  edgesOf,
  offsetPolygon,
  pointInPolygon,
  signedArea,
} from '../geometry/polygon.ts'
import { add2, dist2, dot2, len2, norm2, perp2, scale2, sub2, type Vec2 } from '../geometry/vec.ts'

/** Shortest run worth laying: anything less is a stub in a corner, not a length of floor. */
const MIN_RUN = 400

/** Gap left in the perimeter ring where the two leaders pass through, mm. */
const CONNECTION_GAP = 200

/**
 * How many runs at each side of the room are drawn in to the peripheral pitch.
 *
 * Two is what EN 1264-2's one-metre peripheral zone comes to at any pitch a house is laid at,
 * and it is what a floor is set out to in practice — the fitter pulls the first two runs in
 * tight against the wall and then works across the room on the clips.
 */
const PERIPHERAL_RUNS = 2

/**
 * Longest chord a swept corner is drawn with, mm.
 *
 * Short enough that a bend reads as a bend at plan scale, long enough that a coil does not
 * turn into ten thousand millimetre-long segments the 3D view has to draw one at a time.
 */
const ARC_CHORD = 50

/** Most chords in one swept corner — a right angle is fine with two. */
const MAX_ARC_CHORDS = 4

/**
 * Shortest step worth putting in the geometry, mm.
 *
 * A coil comes off a long path with a lot of arithmetic in it, and rounding leaves stubs a
 * millimetre or two long wherever a corner lands on a connection point. They are not lengths
 * of pipe: they are not laid, not ordered, and on a plan they collapse to a dot that reads as
 * a riser rather than as a coil. Anything shorter than this is folded into its neighbour.
 */
const MIN_STEP = 25

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
  /** Design pipe pitch, mm — what the middle of the room is laid at. */
  spacing: number
  /**
   * Pitch for the outer runs against each wall, mm. Left out, the field is laid at one pitch
   * throughout, which is only ever right for a room that is all peripheral zone anyway.
   */
  peripheral?: number
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
    .filter((d) => d > MIN_STEP && d < span - MIN_STEP)
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
 * Where the runs go across the room, as offsets along the field normal.
 *
 * The two outer runs at each side sit at the peripheral pitch and the rest of the room is
 * divided evenly at a pitch no coarser than `spacing`. Measured from the *ring*, so the gap
 * between the perimeter run and the first run of the field is the peripheral pitch too —
 * there is no bare strip along the wall, which is where a bare strip is felt.
 *
 * A room not much wider than its own two peripheral bands is laid tight throughout, which is
 * the right answer for it: a 1,2 m shower room is peripheral zone from wall to wall.
 */
function runOffsets(low: number, high: number, spacing: number, peripheral: number): number[] {
  const width = high - low
  if (width < 1) return []
  const edge = Math.max(1, Math.min(peripheral, spacing))

  const near: number[] = []
  const far: number[] = []
  for (let k = 1; k <= PERIPHERAL_RUNS; k++) {
    near.push(low + k * edge)
    far.push(high - k * edge)
  }
  const a = near[near.length - 1]
  const b = far[far.length - 1]

  if (b - a < edge) {
    const count = Math.max(1, Math.round(width / edge))
    if (count < 2) return [low + width / 2]
    const pitch = width / count
    return Array.from({ length: count - 1 }, (_, k) => low + (k + 1) * pitch)
  }

  // An even number of runs is worth a slightly tighter pitch. A serpentine finishes at the far
  // side of the room whatever it does, but with an even count it finishes at the *same end* of
  // that side as it started — so the perimeter return comes home the long way round three
  // walls instead of cutting across two. The pitch only ever tightens for it.
  let count = Math.max(1, Math.ceil((b - a) / spacing))
  if ((count + 2 * PERIPHERAL_RUNS - 1) % 2 !== 0) count += 1

  const pitch = (b - a) / count
  const middle = Array.from({ length: count - 1 }, (_, j) => a + (j + 1) * pitch)
  return [...near, ...middle, ...far.reverse()]
}

/** One line of the field, with every piece of it a run could be laid in. */
interface Line {
  offset: number
  options: Span[]
}

/**
 * The field, line by line, with every candidate piece of each line kept.
 *
 * A line broken by a bath comes back with a piece either side of it. Which one is laid is not
 * a decision this function can make — it depends on where the coil already is, and picking the
 * longer piece regardless is what makes a coil jump across a bath on the diagonal. So both are
 * offered and `layLoop` chooses, run by run.
 *
 * Every piece is pulled back by the peripheral pitch at each end, which is what keeps the end
 * turns off the perimeter run and off whatever cut the line short.
 */
function lineField(
  poly: Vec2[],
  obstacles: Vec2[][],
  u: Vec2,
  n: Vec2,
  spacing: number,
  peripheral: number,
): Line[] {
  const offsets = poly.map((p) => dot2(p, n))
  const low = Math.min(...offsets)
  const high = Math.max(...offsets)
  const trim = Math.max(1, Math.min(peripheral, spacing))
  const lines: Line[] = []

  for (const offset of runOffsets(low, high, spacing, peripheral)) {
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

    const options: Span[] = []
    for (const [lo, up] of intervals) {
      const from = lo + trim
      const to = up - trim
      if (to - from < MIN_RUN) continue
      options.push({
        a: add2(origin, scale2(u, from)),
        b: add2(origin, scale2(u, to)),
        length: to - from,
      })
    }
    if (options.length > 0) lines.push({ offset, options })
  }

  return lines
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
 * Each band is then grown across the cut, by enough that after both are set out their two
 * perimeter runs sit one peripheral pitch apart across it rather than leaving a cold strip
 * down the middle of the room. Grown any further and the two bands would be laying pipe in
 * the same floor: a band's perimeter run is its outermost pipe, so two bands that overlap at
 * all overlap there first. The band's *extent* — its true, un-grown share — is carried
 * alongside, because that is the floor area it heats.
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
  const peripheral = options.peripheral ?? spacing

  const ringOutline = inset(outline, clearance)
  if (!ringOutline) return null
  const ring = makeRing(ringOutline)
  if (ring.length < 1000) return null

  const u = runDirection(outline)
  const n = perp2(u)
  const lines = lineField(ringOutline, obstacles, u, n, spacing, peripheral)

  const credited = options.extent ?? outline
  const bend = Math.min(spacing, peripheral) / 2
  const sweep = (path: Vec2[]): Vec2[] => round(path, bend, outline, clearance, obstacles)

  if (lines.length === 0) {
    // Nothing to meander: a single run round the room, which is what a WC compartment or a
    // lobby gets in practice.
    const flowParam = ringParamNear(ring, anchor)
    const returnParam = flowParam + CONNECTION_GAP
    const path = [ringPoint(ring, flowParam), ...walkRing(ring, flowParam, returnParam, false)]
    return finish(sweep(path), credited)
  }

  // Start at whichever end of the field is nearer the manifold, so the first run is the one
  // closest to home and the coil works away from it.
  const ordered =
    dist2(anchor, midpoint(lines[0].options[0])) <=
    dist2(anchor, midpoint(lines[lines.length - 1].options[0]))
      ? lines
      : [...lines].reverse()

  const meander: Vec2[] = []
  let run: Span | null = null
  let cursor: Vec2 | null = null
  for (const line of ordered) {
    const chosen = pick(line.options, run, u, cursor ?? anchor)
    const at: Vec2 = cursor ?? anchor
    const headFirst = dist2(at, chosen.a) <= dist2(at, chosen.b)
    const entry: Vec2 = headFirst ? chosen.a : chosen.b
    const exit: Vec2 = headFirst ? chosen.b : chosen.a
    if (cursor) meander.push(...turn(cursor, entry, u, n, ringOutline, obstacles))
    meander.push(entry, exit)
    run = chosen
    cursor = exit
  }
  if (!cursor) return null

  // The coil is picked up off the perimeter run directly outside where it starts, so the
  // leader comes in square through the gap in the ring rather than cutting across the corner.
  const flowParam = ringParamNear(ring, meander[0])
  const exitParam = ringParamNear(ring, cursor)

  // Back to the manifold round the outside, the long way round. Only one of the two arcs
  // between the coil's two ends gets laid — the walk stops short of the flow connection rather
  // than running over it, so which side of it the return comes back on is the same choice as
  // which way round the room the pipe goes — and the perimeter run is the second pipe along
  // the external walls, so it is worth having as much of as the room will give. The short way
  // round would leave the far half of the room with one run against the wall instead of two.
  const ahead = wrap(exitParam - flowParam, ring.length)
  const forward = ahead * 2 < ring.length
  const returnParam = forward ? flowParam - CONNECTION_GAP : flowParam + CONNECTION_GAP

  const path = [
    ringPoint(ring, flowParam),
    ...meander,
    ringPoint(ring, exitParam),
    ...walkRing(ring, exitParam, returnParam, forward),
  ]
  return finish(sweep(path), credited)
}

/**
 * Which piece of a broken line to lay.
 *
 * Whichever piece the coil can reach without leaving the run it is on — that is, the one that
 * overlaps the previous run. A bath in the middle of a room leaves a piece either side of it,
 * and taking the longer one regardless is what sends the pipe across the bath on the diagonal
 * and back again. With nothing to go on, the longest piece is the best guess.
 */
function pick(options: Span[], previous: Span | null, u: Vec2, from: Vec2): Span {
  const along = (s: Span): [number, number] => {
    const a = dot2(s.a, u)
    const b = dot2(s.b, u)
    return a <= b ? [a, b] : [b, a]
  }
  const last = previous ? along(previous) : null
  let best = options[0]
  let bestScore = -Infinity
  for (const option of options) {
    const [lo, hi] = along(option)
    const overlap = last ? Math.min(hi, last[1]) - Math.max(lo, last[0]) : 0
    // Reaching the piece at all comes first, then how much floor it covers, and only then how
    // near it is — the last is the tie-break for the very first run of the coil.
    const score =
      (overlap > 0 ? 1e9 : 0) +
      option.length * 1000 -
      Math.min(dist2(from, option.a), dist2(from, option.b))
    if (score > bestScore) {
      bestScore = score
      best = option
    }
  }
  return best
}

/**
 * Getting from the end of one run to the start of the next.
 *
 * Across the pitch first and then along the run, so the turn is a pair of right angles rather
 * than a slant. In a square room the two coincide and the turn is the single hop across that
 * it looks like on any drawing of a heated floor; it is rooms out of square, and lines cut
 * short by something on the floor, that would otherwise be drawn on the diagonal.
 *
 * A corner that would put the pipe in the wall or under the bath is no use, so the other order
 * is tried, and if neither works the turn is left as it was — a straight line between two
 * points is at least still one continuous pipe.
 */
function turn(from: Vec2, to: Vec2, u: Vec2, n: Vec2, poly: Vec2[], obstacles: Vec2[][]): Vec2[] {
  const fu = dot2(from, u)
  const fn = dot2(from, n)
  const tu = dot2(to, u)
  const tn = dot2(to, n)
  if (Math.abs(fu - tu) < 1) return []

  const at = (alongU: number, alongN: number): Vec2 => add2(scale2(u, alongU), scale2(n, alongN))
  const across = at(fu, tn)
  const along = at(tu, fn)

  for (const corner of [across, along]) {
    if (clear(from, corner, poly, obstacles) && clear(corner, to, poly, obstacles)) return [corner]
  }
  return []
}

/** Is the straight line between two points laid in floor the pipe is allowed to be in? */
function clear(a: Vec2, b: Vec2, poly: Vec2[], obstacles: Vec2[][]): boolean {
  const steps = Math.max(2, Math.min(24, Math.ceil(dist2(a, b) / 100)))
  for (let i = 0; i <= steps; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }
    if (!pointInPolygon(p, poly)) return false
    if (obstacles.some((obstacle) => pointInPolygon(p, obstacle))) return false
  }
  return true
}

const wrap = (value: number, length: number): number => ((value % length) + length) % length

const midpoint = (span: Span): Vec2 => ({
  x: (span.a.x + span.b.x) / 2,
  y: (span.a.y + span.b.y) / 2,
})

/* ------------------------------------------------------------- swept corners */

/**
 * Replace every mitred corner with the arc the pipe is actually bent through.
 *
 * A coil has no fittings in it — every change of direction is the pipe itself bent round a
 * clip rail — so a square corner is not a simplification of what gets built, it is a drawing
 * of something that cannot be built. The radius is half the pitch, which is what an end turn
 * at the wall comes out as, and it is cut back further wherever the legs either side are too
 * short to give it away.
 *
 * The arc is checked before it is accepted: it may not bring the pipe nearer the wall than the
 * run it replaced, nor across anything screwed to the floor. Where it would, the corner stays
 * mitred rather than the coil quietly moving.
 */
function round(
  path: Vec2[],
  radius: number,
  outline: Vec2[],
  clearance: number,
  obstacles: Vec2[][],
): Vec2[] {
  if (path.length < 3 || radius <= 1) return path
  const laid = (p: Vec2): boolean =>
    distanceToBoundary(p, outline) >= clearance - 1 &&
    !obstacles.some((obstacle) => pointInPolygon(p, obstacle))

  const out: Vec2[] = [path[0]]
  for (let i = 1; i < path.length - 1; i++) {
    const arc = sweptCorner(path[i - 1], path[i], path[i + 1], radius)
    if (arc && arc.every(laid)) out.push(...arc)
    else out.push(path[i])
  }
  out.push(path[path.length - 1])
  return out
}

/** The points of one swept corner, or null where there is no corner to sweep. */
function sweptCorner(previous: Vec2, vertex: Vec2, next: Vec2, radius: number): Vec2[] | null {
  const back = sub2(previous, vertex)
  const on = sub2(next, vertex)
  const backLength = len2(back)
  const onLength = len2(on)
  if (backLength < 1 || onLength < 1) return null

  const d1 = scale2(back, 1 / backLength)
  const d2 = scale2(on, 1 / onLength)
  const cosine = Math.max(-1, Math.min(1, dot2(d1, d2)))
  // Straight through, or doubled back on itself: neither is a corner with an arc in it.
  if (cosine < -0.999 || cosine > 0.999) return null

  const half = Math.acos(cosine) / 2
  // The arc has to fit in the shorter of the two legs, with something left of it to draw.
  const tangent = Math.min(radius / Math.tan(half), 0.49 * Math.min(backLength, onLength))
  const effective = tangent * Math.tan(half)
  // A corner between two stubs has no room for an arc, and sweeping it anyway only puts two
  // more points a hair apart where there was one.
  if (tangent < MIN_STEP || effective < 1) return null

  const bisector = norm2(add2(d1, d2))
  if (len2(bisector) < 1e-6) return null
  const centre = add2(vertex, scale2(bisector, effective / Math.sin(half)))
  const from = sub2(add2(vertex, scale2(d1, tangent)), centre)
  const to = sub2(add2(vertex, scale2(d2, tangent)), centre)

  // Sweep the short way round, in whichever direction takes the arc past the corner.
  let swept = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x)
  while (swept > Math.PI) swept -= 2 * Math.PI
  while (swept < -Math.PI) swept += 2 * Math.PI

  const chords = Math.max(
    1,
    Math.min(MAX_ARC_CHORDS, Math.ceil((Math.abs(swept) * effective) / ARC_CHORD)),
  )
  const points: Vec2[] = []
  for (let k = 0; k <= chords; k++) {
    const angle = (swept * k) / chords
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    points.push({
      x: centre.x + from.x * cos - from.y * sin,
      y: centre.y + from.x * sin + from.y * cos,
    })
  }
  return points
}

/* -------------------------------------------------------------------- totals */

function finish(raw: Vec2[], credited: Vec2[]): LoopLayout | null {
  // Stubs come out of the ring walk whenever a corner sits on a connection point, and out of
  // the arcs wherever one lands next to the end of its leg. They would show up as pipe of no
  // length on the schedule, and as a dot rather than a run on the plan. The last point is
  // always kept: it is where the return leader picks the coil up.
  const path: Vec2[] = []
  for (const point of raw) {
    const last = path[path.length - 1]
    if (!last || dist2(last, point) > MIN_STEP) path.push(point)
  }
  const end = raw[raw.length - 1]
  if (path.length > 0 && dist2(path[path.length - 1], end) > 1e-6) path[path.length - 1] = end
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
