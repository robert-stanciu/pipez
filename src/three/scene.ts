/**
 * Geometry shared by the 3D viewport and the glTF exporter.
 *
 * The domain works in millimetres with z up; three.js works in metres with y up. Everything
 * crosses that boundary here and nowhere else.
 *
 * Transforms are returned as real Vector3 / Euler objects rather than tuples: that is what
 * both TresJS props and three's own `Object3D` accept, so nothing has to be converted twice.
 */

import { Euler, Quaternion, Vector3 } from 'three'

import { fixtureDef } from '../domain/catalog/fixtures.ts'
import { edgesOf } from '../domain/geometry/polygon.ts'
import { dist2, type Vec2, type Vec3 } from '../domain/geometry/vec.ts'
import { fixtureFrame, wallsOf } from '../domain/model.ts'
import type { Fixture, Opening, Project, Room, Segment } from '../domain/types.ts'

/** Millimetres to metres. */
export const S = 0.001

/** Domain (x east, y north, z up) into three.js (x east, y up, z south). */
export const toScene = (p: Vec3): Vector3 => new Vector3(p.x * S, p.z * S, -p.y * S)

export const toScene2 = (p: Vec2, z: number): Vector3 => new Vector3(p.x * S, z * S, -p.y * S)

const UP = new Vector3(0, 1, 0)

export interface Transform {
  position: Vector3
  rotation: Euler
  scale: Vector3
}

export interface Placement {
  position: Vector3
  rotation: Euler
  /** Length along the local +y axis, in scene units. */
  length: number
}

/**
 * Position and orientation for a unit cylinder spanning a to b.
 *
 * The cylinder's own axis is +y, so we rotate that onto the segment direction. Sharing one
 * unit geometry and scaling per instance keeps a few hundred pipe runs cheap to draw.
 */
export function segmentPlacement(a: Vec3, b: Vec3): Placement {
  const from = toScene(a)
  const to = toScene(b)
  const delta = to.clone().sub(from)
  const length = delta.length()
  const mid = from.clone().add(to).multiplyScalar(0.5)

  if (length < 1e-9) return { position: mid, rotation: new Euler(), length: 0 }

  const quaternion = new Quaternion().setFromUnitVectors(UP, delta.normalize())
  return { position: mid, rotation: new Euler().setFromQuaternion(quaternion), length }
}

/** Pipe radius in scene units; cables are drawn at a legible minimum rather than to scale. */
export function segmentRadius(segment: Segment): number {
  if (segment.system === 'power') return 0.008
  return Math.max(0.006, (segment.size / 2) * S)
}

/* --------------------------------------------------------------------- walls */

export interface WallBox extends Transform {
  key: string
}

/**
 * A wall broken into boxes around its openings.
 *
 * Doors and windows are real holes, so the wall is emitted as the solid pieces either side
 * plus the lintel above and, for a window, the spandrel below. Boolean-subtracting a hole
 * from an extrusion would look the same and cost far more.
 */
export function wallBoxes(room: Room, openings: Opening[]): WallBox[] {
  const boxes: WallBox[] = []
  const innerEdges = edgesOf(room.outline)

  for (const wall of wallsOf(room)) {
    const span = dist2(wall.centerA, wall.centerB)
    if (span < 1) continue
    const innerLength = innerEdges[wall.index]?.length ?? span
    const angle = Math.atan2(wall.centerB.y - wall.centerA.y, wall.centerB.x - wall.centerA.x)

    const emit = (from: number, to: number, base: number, top: number, tag: string) => {
      const width = to - from
      const height = top - base
      if (width < 1 || height < 1) return
      const t = (from + to) / 2 / span
      const centre = {
        x: wall.centerA.x + (wall.centerB.x - wall.centerA.x) * t,
        y: wall.centerA.y + (wall.centerB.y - wall.centerA.y) * t,
      }
      boxes.push({
        key: `${room.id}-${wall.index}-${tag}-${Math.round(from)}`,
        position: toScene2(centre, room.floorZ + (base + top) / 2),
        // Rotating about three's y axis, which runs the opposite way to a plan angle.
        rotation: new Euler(0, -angle, 0),
        scale: new Vector3(width * S, height * S, room.wallThickness * S),
      })
    }

    // Opening offsets are measured along the inner face, so rescale them onto the centreline.
    const scale = innerLength > 0 ? span / innerLength : 1
    const holes = openings
      .filter((o) => o.wallIndex === wall.index)
      .map((o) => ({
        from: Math.max(0, (o.offset - o.width / 2) * scale),
        to: Math.min(span, (o.offset + o.width / 2) * scale),
        sill: o.sillHeight,
        head: o.sillHeight + o.height,
      }))
      .sort((a, b) => a.from - b.from)

    let cursor = 0
    for (const hole of holes) {
      emit(cursor, hole.from, 0, room.height, 'pier')
      if (hole.sill > 0) emit(hole.from, hole.to, 0, hole.sill, 'spandrel')
      if (hole.head < room.height) emit(hole.from, hole.to, hole.head, room.height, 'lintel')
      cursor = Math.max(cursor, hole.to)
    }
    emit(cursor, span, 0, room.height, 'pier')
  }

  return boxes
}

/* ------------------------------------------------------------------ fixtures */

/**
 * Proxy volume for a fixture.
 *
 * The anchor height means different things for different things — a basin hangs from its
 * rim, a WC stands on the floor, a socket is centred on its own height — so the box is
 * resolved from the catalogue's height rather than assumed.
 */
export function fixtureBox(project: Project, fixture: Fixture): Transform | null {
  const frame = fixtureFrame(project, fixture)
  if (!frame) return null
  const { width, depth, height } = fixtureDef(fixture.type).size

  const anchorZ = frame.origin.z - frame.room.floorZ
  let base: number
  if (height < 200) base = anchorZ - height / 2 // small plates and fittings centre on the anchor
  else if (anchorZ <= 0) base = 0 // floor-standing
  else base = Math.max(0, anchorZ - height) // hung from its rim

  // Push the box out from the wall face by half its depth so it sits in the room.
  const centre = {
    x: frame.origin.x + frame.out.x * (depth / 2),
    y: frame.origin.y + frame.out.y * (depth / 2),
  }

  return {
    position: toScene2(centre, frame.room.floorZ + base + height / 2),
    rotation: new Euler(0, -Math.atan2(frame.right.y, frame.right.x), 0),
    scale: new Vector3(width * S, height * S, depth * S),
  }
}

/* --------------------------------------------------------------------- floor */

/** Axis-aligned slab covering the room's footprint — enough to read the plan in 3D. */
export function floorPlate(room: Room): Transform {
  const xs = room.outline.map((p) => p.x)
  const ys = room.outline.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    position: toScene2({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, room.floorZ - 10),
    rotation: new Euler(),
    scale: new Vector3((maxX - minX) * S, 20 * S, (maxY - minY) * S),
  }
}

/** Centre of the whole building, for framing the camera. */
export function sceneCentre(project: Project): Vector3 {
  const points = project.rooms.flatMap((r) => r.outline)
  if (points.length === 0) return new Vector3()
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  return toScene2(
    { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
    0,
  )
}
