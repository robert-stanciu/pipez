/**
 * Editing operations on room geometry.
 *
 * Kept in the domain layer, and pure: each takes an outline and returns a new one. The store
 * owns *when* a change happens and how it is undone; this file owns what the change means.
 */

import { edgesOf, ensureCounterClockwise } from './geometry/polygon.ts'
import { add2, dist2, scale2, snapTo, type Vec2 } from './geometry/vec.ts'
import { outerOutline, roomsOnLevel } from './model.ts'
import type { Project, Room } from './types.ts'

export const wallLength = (room: Room, wallIndex: number): number => {
  const edge = edgesOf(room.outline)[wallIndex]
  return edge ? edge.length : 0
}

export const translateOutline = (outline: Vec2[], delta: Vec2): Vec2[] =>
  outline.map((p) => add2(p, delta))

/**
 * Push a wall perpendicular to itself, taking its two vertices with it.
 *
 * Positive distance moves the wall outward, making the room bigger.
 */
export function offsetWall(outline: Vec2[], wallIndex: number, distance: number): Vec2[] {
  const ring = ensureCounterClockwise(outline)
  const edge = edgesOf(ring)[wallIndex]
  if (!edge) return ring
  const shift = scale2(edge.normal, distance)
  const next = (wallIndex + 1) % ring.length
  return ring.map((p, i) => (i === wallIndex || i === next ? add2(p, shift) : p))
}

/**
 * Set a wall's length by sliding the far end of it along the wall direction.
 *
 * The vertex after the far end moves too, which is what keeps a rectilinear outline
 * rectilinear — otherwise setting one dimension would shear the room.
 */
export function setWallLength(outline: Vec2[], wallIndex: number, length: number): Vec2[] {
  const ring = ensureCounterClockwise(outline)
  const edge = edgesOf(ring)[wallIndex]
  if (!edge || length < 100) return ring

  const delta = scale2(edge.dir, length - edge.length)
  const far = (wallIndex + 1) % ring.length
  const beyond = (wallIndex + 2) % ring.length
  return ring.map((p, i) => (i === far || i === beyond ? add2(p, delta) : p))
}

/* ------------------------------------------------------------------ snapping */

export interface SnapLines {
  xs: number[]
  ys: number[]
}

/**
 * Candidate alignment lines from every other room: both inner and outer faces.
 *
 * Snapping a new room's inner face onto a neighbour's *outer* face is what makes the two
 * share one wall — their centrelines then coincide exactly, and the router sees a single
 * wall rather than two that nearly touch.
 */
export function snapLines(project: Project, excludeRoomId?: string): SnapLines {
  const xs: number[] = []
  const ys: number[] = []
  // Rooms on *every* storey are snap targets, not just the active one: lining a wall up with
  // the one below is precisely what gives a vertical stack somewhere to run.
  for (const room of project.rooms) {
    if (room.id === excludeRoomId) continue
    for (const poly of [room.outline, outerOutline(room)]) {
      for (const p of poly) {
        xs.push(Math.round(p.x))
        ys.push(Math.round(p.y))
      }
    }
  }
  return { xs: [...new Set(xs)], ys: [...new Set(ys)] }
}

export interface Snapped {
  value: number
  /** The line it locked onto, when it did. */
  line: number | null
}

/** Snap to the nearest candidate line, falling back to the grid. */
export function snapAxis(
  value: number,
  candidates: number[],
  gridPitch: number,
  tolerance: number,
): Snapped {
  let best: number | null = null
  let bestDist = tolerance
  for (const candidate of candidates) {
    const d = Math.abs(candidate - value)
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return best !== null ? { value: best, line: best } : { value: snapTo(value, gridPitch), line: null }
}

export function snapPoint(
  p: Vec2,
  lines: SnapLines,
  gridPitch: number,
  tolerance: number,
): { point: Vec2; guides: { x: number | null; y: number | null } } {
  const x = snapAxis(p.x, lines.xs, gridPitch, tolerance)
  const y = snapAxis(p.y, lines.ys, gridPitch, tolerance)
  return { point: { x: x.value, y: y.value }, guides: { x: x.line, y: y.line } }
}

/* --------------------------------------------------------- fixture placement */

export interface WallHit {
  roomId: string
  wallIndex: number
  /** Distance along the wall from its start vertex. */
  offset: number
  distance: number
  point: Vec2
}

/** Nearest wall to a plan point, within `maxDistance`, on one storey. */
export function nearestWall(
  project: Project,
  p: Vec2,
  maxDistance = 600,
  levelId?: string | null,
): WallHit | null {
  let best: WallHit | null = null
  for (const room of roomsOnLevel(project, levelId ?? null)) {
    for (const edge of edgesOf(room.outline)) {
      const ab = { x: edge.b.x - edge.a.x, y: edge.b.y - edge.a.y }
      const lengthSq = ab.x * ab.x + ab.y * ab.y
      if (lengthSq < 1) continue
      const t = Math.max(
        0,
        Math.min(1, ((p.x - edge.a.x) * ab.x + (p.y - edge.a.y) * ab.y) / lengthSq),
      )
      const point = { x: edge.a.x + ab.x * t, y: edge.a.y + ab.y * t }
      const distance = dist2(p, point)
      if (distance < maxDistance && (best === null || distance < best.distance)) {
        best = { roomId: room.id, wallIndex: edge.index, offset: t * edge.length, distance, point }
      }
    }
  }
  return best
}
