/**
 * Resolvers that turn stored placements into world geometry.
 *
 * The store keeps fixtures anchored to walls by (wallIndex, offset) so they follow when a
 * wall moves. Everything that needs an actual coordinate — the plan view, the 3D scene and
 * the router — goes through here, so there is exactly one definition of where a thing is.
 */

import { fixtureDef } from './catalog/fixtures.ts'
import { edgesOf, offsetPolygon, pointInPolygon, type Edge } from './geometry/polygon.ts'
import {
  add2,
  closestPointOnSegment,
  dist2,
  scale2,
  to3,
  type Vec2,
  type Vec3,
} from './geometry/vec.ts'
import type {
  ConnectionEntry,
  Fixture,
  Level,
  Opening,
  PortKind,
  Project,
  Room,
  SystemKind,
} from './types.ts'

/* ---------------------------------------------------------------------- walls */

export interface WallGeometry extends Edge {
  roomId: string
  thickness: number
  loadBearing: boolean
  /** Base of the wall in world elevation. */
  floorZ: number
  height: number
  /**
   * The wall's centreline, taken from the offset outline so that consecutive walls meet
   * exactly at the corners. Two rooms placed properly side by side end up with coincident
   * centrelines, which is what lets the router's node keys merge them into one wall.
   */
  centerA: Vec2
  centerB: Vec2
}

/** Room outline offset outward to the middle of the wall. */
export const centrelineOutline = (room: Room): Vec2[] =>
  offsetPolygon(room.outline, room.wallThickness / 2)

/** The outer face of the room's walls — what gets extruded in 3D. */
export const outerOutline = (room: Room): Vec2[] =>
  offsetPolygon(room.outline, room.wallThickness)

export function wallsOf(room: Room): WallGeometry[] {
  const centreline = centrelineOutline(room)
  return edgesOf(room.outline).map((edge) => ({
    ...edge,
    roomId: room.id,
    thickness: room.wallThickness,
    loadBearing: room.walls[edge.index]?.loadBearing ?? false,
    floorZ: room.floorZ,
    height: room.height,
    centerA: centreline[edge.index] ?? edge.a,
    centerB: centreline[(edge.index + 1) % centreline.length] ?? edge.b,
  }))
}

export function wallOf(room: Room, wallIndex: number): WallGeometry | null {
  return wallsOf(room)[wallIndex] ?? null
}

/* --------------------------------------------------------------------- levels */

export const sortedLevels = (project: Project): Level[] =>
  [...project.levels].sort((a, b) => a.index - b.index)

export const findLevel = (project: Project, id: string | null): Level | null =>
  id ? (project.levels.find((l) => l.id === id) ?? null) : null

/** The storey a room sits on, falling back to the ground floor for orphaned data. */
export const levelOfRoom = (project: Project, room: Room): Level | null =>
  findLevel(project, room.levelId) ?? sortedLevels(project)[0] ?? null

export const roomsOnLevel = (project: Project, levelId: string | null): Room[] =>
  levelId === null ? project.rooms : project.rooms.filter((r) => r.levelId === levelId)

/** The storey immediately below this one, if any. */
export function levelBelow(project: Project, levelId: string): Level | null {
  const levels = sortedLevels(project)
  const at = levels.findIndex((l) => l.id === levelId)
  return at > 0 ? levels[at - 1] : null
}

/** The storey a fixture is on, via its room. */
export function levelOfFixture(project: Project, fixture: Fixture): Level | null {
  const room = findRoom(project, fixture.roomId)
  return room ? levelOfRoom(project, room) : null
}

/* --------------------------------------------------------------------- lookup */

export const findRoom = (project: Project, id: string | null): Room | null =>
  id ? (project.rooms.find((r) => r.id === id) ?? null) : null

export const findFixture = (project: Project, id: string | null): Fixture | null =>
  id ? (project.fixtures.find((f) => f.id === id) ?? null) : null

export const openingsOnWall = (project: Project, roomId: string, wallIndex: number): Opening[] =>
  project.openings.filter((o) => o.roomId === roomId && o.wallIndex === wallIndex)

/**
 * The room whose interior contains a plan point, if any.
 *
 * Scoped to one storey by default — storeys overlap in plan, so an unscoped hit test would
 * happily place a kitchen sink in the bedroom above it.
 */
export function roomAt(project: Project, p: Vec2, levelId?: string | null): Room | null {
  for (const room of roomsOnLevel(project, levelId ?? null)) {
    if (pointInPolygon(p, room.outline)) return room
  }
  return null
}

/* ------------------------------------------------------------------- fixtures */

/** Local basis of a placed fixture, in world coordinates. */
export interface FixtureFrame {
  /** Anchor point: the fixture's centre where it meets its mounting surface. */
  origin: Vec3
  /** Unit vector for the fixture's local +x (along the wall, to the right). */
  right: Vec2
  /** Unit vector for the fixture's local +y (out from the wall, into the room). */
  out: Vec2
  /** Facing angle in radians, for the 3D mesh. */
  rotation: number
  room: Room
}

export function fixtureFrame(project: Project, fixture: Fixture): FixtureFrame | null {
  const room = findRoom(project, fixture.roomId)
  if (!room) return null

  if (fixture.wallIndex !== null) {
    const wall = wallOf(room, fixture.wallIndex)
    if (!wall) return null
    const t = Math.max(0, Math.min(wall.length, fixture.wallOffset))
    const anchor = add2(wall.a, scale2(wall.dir, t))
    // `normal` points out of the room, so the fixture faces the other way.
    const out = { x: -wall.normal.x, y: -wall.normal.y }
    return {
      origin: to3(anchor, room.floorZ + fixture.z),
      right: wall.dir,
      out,
      rotation: Math.atan2(out.y, out.x),
      room,
    }
  }

  const cos = Math.cos(fixture.rotation)
  const sin = Math.sin(fixture.rotation)
  return {
    origin: to3(fixture.position, room.floorZ + fixture.z),
    right: { x: cos, y: sin },
    out: { x: -sin, y: cos },
    rotation: fixture.rotation,
    room,
  }
}

export interface ResolvedPort {
  portId: string
  fixtureId: string
  fixtureName: string
  kind: PortKind
  position: Vec3
  dn: number
  /** Room the fixture belongs to. */
  roomId: string
}

/** World positions of every port on a fixture. */
export function fixturePorts(project: Project, fixture: Fixture): ResolvedPort[] {
  const frame = fixtureFrame(project, fixture)
  if (!frame) return []
  const def = fixtureDef(fixture.type)

  return def.ports.map((port) => {
    const planar = add2(
      add2(frame.origin, scale2(frame.right, port.offset.x)),
      scale2(frame.out, port.offset.y),
    )
    return {
      portId: port.id,
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      kind: port.kind,
      position: { x: planar.x, y: planar.y, z: frame.origin.z + port.offset.z },
      dn: port.dn,
      roomId: fixture.roomId,
    }
  })
}

/** Every port of a given system across the whole project. */
export function portsOfSystem(project: Project, system: SystemKind): ResolvedPort[] {
  return project.fixtures.flatMap((f) => fixturePorts(project, f).filter((p) => p.kind === system))
}

/* ---------------------------------------------------------- connection entry */

export const entryOf = (project: Project, fixture: Fixture): ConnectionEntry =>
  fixture.entry ?? project.settings.connectionEntry

export interface ConnectionAnchor {
  /** Plan position where the vertical part of the connection runs. */
  plan: Vec2
  /** The wall it runs inside, when it runs in one. */
  wall: WallGeometry | null
  /** True when the requested entry could not be honoured and bottom entry was used instead. */
  fellBack: boolean
}

/**
 * How close an appliance's back has to be to a wall to count as standing against it.
 *
 * Enough slack for a skirting board and a service gap, not enough to catch something parked
 * in the middle of the room.
 */
const AGAINST_WALL_CLEARANCE = 180

/**
 * The wall an appliance backs onto, if any.
 *
 * A basin is *anchored* to its wall and simply knows. A washing machine is not — it stands on
 * the floor and is positioned freely, exactly as a real one is — so the question has to be
 * answered geometrically: is its back against a wall? Asking only anchored fixtures would
 * mean back entry silently did nothing for every appliance that is not wall-hung, which is
 * most of the ones that need it.
 */
export function wallBehind(project: Project, fixture: Fixture): WallGeometry | null {
  const room = findRoom(project, fixture.roomId)
  if (!room) return null
  if (fixture.wallIndex !== null) return wallOf(room, fixture.wallIndex)

  const frame = fixtureFrame(project, fixture)
  if (!frame) return null
  // The frame's origin is the middle of the appliance's back face.
  const back: Vec2 = { x: frame.origin.x, y: frame.origin.y }

  let nearest: WallGeometry | null = null
  let nearestDistance = Infinity
  for (const wall of wallsOf(room)) {
    const { point } = closestPointOnSegment(back, wall.centerA, wall.centerB)
    const distance = dist2(back, point)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = wall
    }
  }
  if (!nearest) return null
  return nearestDistance <= nearest.thickness / 2 + AGAINST_WALL_CLEARANCE ? nearest : null
}

/**
 * Where a fixture's connection turns vertical.
 *
 * Bottom entry drops straight out of the appliance, so the vertical is directly beneath the
 * port. Back entry goes horizontally into the wall first and drops inside it, so the vertical
 * sits on the wall centreline behind the fixture — which is the whole visible difference: the
 * pipes are in the wall rather than under the floor in the middle of the room.
 *
 * An appliance standing clear of every wall cannot be fed from behind, so it falls back to
 * bottom entry and says so.
 */
export function connectionAnchor(
  project: Project,
  fixture: Fixture,
  port: ResolvedPort,
): ConnectionAnchor {
  const beneath: Vec2 = { x: port.position.x, y: port.position.y }
  if (entryOf(project, fixture) !== 'back') return { plan: beneath, wall: null, fellBack: false }

  const wall = wallBehind(project, fixture)
  if (!wall) return { plan: beneath, wall: null, fellBack: true }

  // Straight back from the port to the middle of the wall behind it.
  const { point } = closestPointOnSegment(beneath, wall.centerA, wall.centerB)
  return { plan: point, wall, fellBack: false }
}

/** Footprint corners of a fixture in plan, for drawing and for obstacle tests. */
export function fixtureFootprint(project: Project, fixture: Fixture): Vec2[] {
  const frame = fixtureFrame(project, fixture)
  if (!frame) return []
  const { size } = fixtureDef(fixture.type)
  const halfWidth = size.width / 2
  const corners: Array<[number, number]> = [
    [-halfWidth, 0],
    [halfWidth, 0],
    [halfWidth, size.depth],
    [-halfWidth, size.depth],
  ]
  return corners.map(([along, outward]) =>
    add2(add2(frame.origin, scale2(frame.right, along)), scale2(frame.out, outward)),
  )
}

/* -------------------------------------------------------------- service points */

export const servicePointOf = (project: Project, kind: string) =>
  project.servicePoints.find((s) => s.kind === kind) ?? null

/** Absolute position of a service point. */
export const servicePointPosition = (
  project: Project,
  kind: string,
): Vec3 | null => {
  const point = servicePointOf(project, kind)
  return point ? to3(point.position, point.z) : null
}
