/**
 * Swept corners for drainage.
 *
 * A square corner in a soil or waste pipe is not built with a 90° elbow. Solids stall in the
 * sharp inside of one, and there is no way to get a rod round it, so the fitting schedules
 * pair two 45° bends with a short leg between them. That is a geometric fact about the pipe,
 * not a drawing convention — the run really does cut the corner — so it belongs in the model
 * rather than in the renderers.
 *
 * This pass takes the routed and merged segments and chamfers every square corner: both legs
 * are pulled back and a 45° piece is dropped in between. Invert levels come along for the
 * ride because the pull-back interpolates along the original run, which also means the
 * chamfer is very slightly steeper than the runs either side — as a real cut corner is.
 */

import { dist3, type Vec3 } from '../geometry/vec.ts'
import type { Segment } from '../types.ts'

const pointKey = (p: Vec3): string =>
  `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`

/** Only a turn near enough to a right angle needs splitting into two. */
const SQUARE_MIN = 60
const SQUARE_MAX = 120

/** Face-to-face leg of a 45° bend, near enough, in millimetres. */
const legFor = (dn: number): number => Math.max(70, dn * 1.2)

interface Trim {
  a: number
  b: number
}

const unit = (from: Vec3, to: Vec3): Vec3 => {
  const length = dist3(from, to)
  if (length < 1e-9) return { x: 0, y: 0, z: 0 }
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length, z: (to.z - from.z) / length }
}

const along = (from: Vec3, dir: Vec3, distance: number): Vec3 => ({
  x: from.x + dir.x * distance,
  y: from.y + dir.y * distance,
  z: from.z + dir.z * distance,
})

/** Degrees between two unit vectors. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))
  return (Math.acos(dot) * 180) / Math.PI
}

/**
 * Replace square corners with a pair of 45° bends.
 *
 * `nextId` is used for the inserted pieces so the result stays deterministic.
 */
export function sweepCorners(segments: Segment[], nextId: () => string): Segment[] {
  const trims = new Map<string, Trim>(segments.map((s) => [s.id, { a: 0, b: 0 }]))

  const incident = new Map<string, { point: Vec3; segments: Segment[] }>()
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      const key = pointKey(end)
      const entry = incident.get(key)
      if (entry) entry.segments.push(segment)
      else incident.set(key, { point: end, segments: [segment] })
    }
  }

  const inserted: Segment[] = []

  // Sorted so the output does not depend on Map insertion order.
  const corners = [...incident.entries()].sort(([l], [r]) => l.localeCompare(r))

  for (const [key, { point, segments: touching }] of corners) {
    // Only a plain corner: a tee is a swept branch fitting, not two elbows.
    if (touching.length !== 2) continue
    const [first, second] = touching
    if (first.role === 'bend' || second.role === 'bend') continue

    // Directions leading away from the corner, along each leg.
    const firstFar = pointKey(first.a) === key ? first.b : first.a
    const secondFar = pointKey(second.a) === key ? second.b : second.a
    const d1 = unit(point, firstFar)
    const d2 = unit(point, secondFar)

    // The turn the water makes is the supplement of the angle between the two outgoing legs.
    const turn = 180 - angleBetween(d1, d2)
    if (turn < SQUARE_MIN || turn > SQUARE_MAX) continue

    const trim1 = trims.get(first.id) as Trim
    const trim2 = trims.get(second.id) as Trim
    const available1 = dist3(first.a, first.b) - trim1.a - trim1.b
    const available2 = dist3(second.a, second.b) - trim2.a - trim2.b

    const leg = Math.min(
      legFor(Math.max(first.size, second.size)),
      available1 * 0.4,
      available2 * 0.4,
    )
    if (leg < 20) continue

    if (pointKey(first.a) === key) trim1.a += leg
    else trim1.b += leg
    if (pointKey(second.a) === key) trim2.a += leg
    else trim2.b += leg

    const p1 = along(point, d1, leg)
    const p2 = along(point, d2, leg)
    // Oriented so it runs downhill, matching the child -> parent convention elsewhere.
    const [from, to] = p1.z >= p2.z ? [p1, p2] : [p2, p1]
    inserted.push({
      id: nextId(),
      system: first.system,
      a: from,
      b: to,
      size: Math.max(first.size, second.size),
      load: Math.max(first.load, second.load),
      length: dist3(from, to),
      role: 'bend',
    })
  }

  const output: Segment[] = []
  for (const segment of segments) {
    const trim = trims.get(segment.id) as Trim
    const length = dist3(segment.a, segment.b)
    if (trim.a + trim.b >= length) continue // fully consumed by its own corners

    const dir = unit(segment.a, segment.b)
    const a = trim.a > 0 ? along(segment.a, dir, trim.a) : segment.a
    const b = trim.b > 0 ? along(segment.b, dir, -trim.b) : segment.b
    output.push({ ...segment, a, b, length: dist3(a, b) })
  }

  return [...output, ...inserted]
}
