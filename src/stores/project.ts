/**
 * The project store — the single source of truth both views render from.
 *
 * Undo is snapshot-based. A floor plan is a few kilobytes of JSON, so cloning it per edit is
 * cheaper than maintaining an inverse operation for every command, and it cannot drift out
 * of sync with the model the way hand-written undo eventually does.
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { fixtureDef } from '../domain/catalog/fixtures.ts'
import { nearestWall, offsetWall, setWallLength, translateOutline } from '../domain/edit.ts'
import { closestPointOnSegment, type Vec2 } from '../domain/geometry/vec.ts'
import {
  allowsMultiple,
  findLevel,
  findRoom,
  fixtureFrame,
  wallOf,
  roomAt,
  roomsOnLevel,
  sortedLevels,
} from '../domain/model.ts'
import {
  createFixture,
  createLevel,
  createOpening,
  createProject,
  createRoom,
  createServicePoint,
  makeWalls,
  relevel,
  roomHeating,
  sampleProject,
} from '../domain/project.ts'
import type {
  Fixture,
  FixtureType,
  Level,
  Opening,
  Project,
  Room,
  RoomHeating,
  ServiceKind,
  ServicePoint,
} from '../domain/types.ts'

const MAX_HISTORY = 60

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const useProjectStore = defineStore('project', () => {
  const project = ref<Project>(sampleProject())

  const past = shallowRef<Project[]>([])
  const future = shallowRef<Project[]>([])

  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  /**
   * Take a snapshot *before* mutating. Call this at the start of a user-visible change; a
   * drag calls it once on pointer-down rather than on every move, so one gesture is one undo.
   */
  function checkpoint(): void {
    past.value = [...past.value.slice(-(MAX_HISTORY - 1)), clone(project.value)]
    future.value = []
  }

  function touch(): void {
    project.value.updatedAt = new Date().toISOString()
  }

  function undo(): void {
    const previous = past.value[past.value.length - 1]
    if (!previous) return
    future.value = [clone(project.value), ...future.value]
    past.value = past.value.slice(0, -1)
    project.value = previous
  }

  function redo(): void {
    const next = future.value[0]
    if (!next) return
    past.value = [...past.value, clone(project.value)]
    future.value = future.value.slice(1)
    project.value = next
  }

  function load(next: Project): void {
    past.value = []
    future.value = []
    project.value = next
  }

  const reset = () => load(createProject())
  const loadSample = () => load(sampleProject())

  /* ------------------------------------------------------------------ levels */

  const levels = computed(() => sortedLevels(project.value))

  /** Falls back to the ground floor whenever the caller's level id is stale. */
  const levelOr = (levelId: string | null): Level =>
    findLevel(project.value, levelId) ?? levels.value[0]

  function addLevel(): Level {
    checkpoint()
    const level = createLevel(project.value.levels.length, project.value.settings)
    project.value.levels.push(level)
    relevel(project.value)
    touch()
    return level
  }

  /**
   * Remove a storey and everything on it. The ground floor stays: a building with no storeys
   * has nowhere to put anything, and every id in the project would dangle.
   */
  function removeLevel(levelId: string): void {
    if (project.value.levels.length <= 1) return
    checkpoint()
    const doomed = new Set(
      project.value.rooms.filter((r) => r.levelId === levelId).map((r) => r.id),
    )
    project.value.levels = project.value.levels.filter((l) => l.id !== levelId)
    project.value.rooms = project.value.rooms.filter((r) => !doomed.has(r.id))
    project.value.fixtures = project.value.fixtures.filter((f) => !doomed.has(f.roomId))
    project.value.openings = project.value.openings.filter((o) => !doomed.has(o.roomId))
    project.value.servicePoints = project.value.servicePoints.filter((s) => s.levelId !== levelId)
    relevel(project.value)
    touch()
  }

  function updateLevel(levelId: string, patch: Partial<Level>): void {
    const level = findLevel(project.value, levelId)
    if (!level) return
    checkpoint()
    Object.assign(level, patch)
    // Changing a storey's height moves everything above it, and its rooms with it.
    relevel(project.value)
    for (const room of project.value.rooms) {
      if (room.levelId === levelId && patch.height !== undefined) room.height = patch.height
    }
    touch()
  }

  /* ------------------------------------------------------------------- rooms */

  function addRoom(origin: Vec2, width: number, depth: number, levelId: string | null): Room {
    checkpoint()
    const level = levelOr(levelId)
    const onLevel = project.value.rooms.filter((r) => r.levelId === level.id).length
    const room = createRoom(
      `Room ${onLevel + 1}`,
      origin,
      width,
      depth,
      level,
      project.value.settings,
    )
    project.value.rooms.push(room)
    touch()
    return room
  }

  function removeRoom(roomId: string): void {
    checkpoint()
    project.value.rooms = project.value.rooms.filter((r) => r.id !== roomId)
    project.value.fixtures = project.value.fixtures.filter((f) => f.roomId !== roomId)
    project.value.openings = project.value.openings.filter((o) => o.roomId !== roomId)
    for (const point of project.value.servicePoints) {
      if (point.roomId === roomId) point.roomId = null
    }
    touch()
  }

  /** Live update during a drag — the caller is responsible for the checkpoint. */
  function moveRoom(roomId: string, delta: Vec2): void {
    const room = findRoom(project.value, roomId)
    if (!room) return
    room.outline = translateOutline(room.outline, delta)
    touch()
  }

  function setRoomOutline(roomId: string, outline: Vec2[]): void {
    const room = findRoom(project.value, roomId)
    if (!room) return
    room.outline = outline
    if (room.walls.length !== outline.length) room.walls = makeWalls(outline.length)
    touch()
  }

  function pushWall(roomId: string, wallIndex: number, distance: number): void {
    const room = findRoom(project.value, roomId)
    if (!room) return
    room.outline = offsetWall(room.outline, wallIndex, distance)
    touch()
  }

  function resizeWall(roomId: string, wallIndex: number, length: number): void {
    const room = findRoom(project.value, roomId)
    if (!room) return
    checkpoint()
    room.outline = setWallLength(room.outline, wallIndex, length)
    touch()
  }

  function updateRoom(roomId: string, patch: Partial<Room>): void {
    const room = findRoom(project.value, roomId)
    if (!room) return
    checkpoint()
    Object.assign(room, patch)
    touch()
  }

  /**
   * Change a room's underfloor heating.
   *
   * A room that has never said anything about heating has no record at all, so the patch is
   * applied on top of a fresh default rather than to nothing.
   */
  function updateRoomHeating(roomId: string, patch: Partial<RoomHeating>): void {
    const room = findRoom(project.value, roomId)
    if (!room) return
    checkpoint()
    room.heating = { ...roomHeating(), ...room.heating, ...patch }
    touch()
  }

  /** Move a room, and everything in it, to another storey. */
  function moveRoomToLevel(roomId: string, levelId: string): void {
    const room = findRoom(project.value, roomId)
    const level = findLevel(project.value, levelId)
    if (!room || !level || room.levelId === levelId) return
    checkpoint()
    room.levelId = level.id
    // Service points sit on a storey in their own right; carry any inside this room across
    // so the outlet does not end up floating under the wrong floor.
    for (const point of project.value.servicePoints) {
      if (point.roomId !== roomId) continue
      const previous = levelOr(point.levelId)
      point.z += level.elevation - previous.elevation
      point.levelId = level.id
    }
    relevel(project.value)
    touch()
  }

  function setWallLoadBearing(roomId: string, wallIndex: number, loadBearing: boolean): void {
    const room = findRoom(project.value, roomId)
    const wall = room?.walls[wallIndex]
    if (!wall) return
    checkpoint()
    wall.loadBearing = loadBearing
    touch()
  }

  /* ---------------------------------------------------------------- fixtures */

  /** Place a fixture at a plan point on one storey, anchoring it to a nearby wall if there is one. */
  function addFixtureAt(type: FixtureType, point: Vec2, levelId: string | null): Fixture | null {
    const def = fixtureDef(type)
    const level = levelOr(levelId)
    const room = roomAt(project.value, point, level.id)

    if (def.mount === 'wall') {
      const hit = nearestWall(project.value, point, 600, level.id)
      if (!hit) return null
      checkpoint()
      const fixture = createFixture(project.value, type, hit.roomId, {
        wallIndex: hit.wallIndex,
        wallOffset: hit.offset,
      })
      project.value.fixtures.push(fixture)
      touch()
      return fixture
    }

    if (!room) return null
    checkpoint()
    const fixture = createFixture(project.value, type, room.id, { position: point })
    project.value.fixtures.push(fixture)
    touch()
    return fixture
  }

  function moveFixtureTo(fixtureId: string, point: Vec2): void {
    const fixture = project.value.fixtures.find((f) => f.id === fixtureId)
    if (!fixture) return
    // A drag stays on the storey the fixture is already on; changing floors is a deliberate
    // act, not something that should happen because two rooms overlap in plan.
    const levelId = findRoom(project.value, fixture.roomId)?.levelId ?? null

    // How it is mounted *now*, not what the catalogue suggests: once the user has anchored a
    // dishwasher to a wall, dragging it should slide along that wall.
    if (fixture.wallIndex !== null) {
      // Wall fixtures slide along whichever wall is nearest, so a drag can move them
      // around a corner or onto the next room's wall without a separate gesture.
      const hit = nearestWall(project.value, point, 600, levelId)
      if (!hit) return
      fixture.roomId = hit.roomId
      fixture.wallIndex = hit.wallIndex
      fixture.wallOffset = hit.offset
    } else {
      const room = roomAt(project.value, point, levelId)
      if (room) fixture.roomId = room.id
      fixture.wallIndex = null
      fixture.position = point
    }
    touch()
  }

  /**
   * Anchor a fixture to one of its room's walls, or set it free-standing.
   *
   * The catalogue only supplies a sensible default — a basin hangs on a wall, a washing
   * machine stands on the floor — but which wall a thing actually backs onto is the user's
   * call, and it decides where a back-entry connection runs. Switching keeps the appliance
   * where it is and facing the way it faces; only how it is held changes.
   */
  function setFixtureMounting(fixtureId: string, wallIndex: number | null): void {
    const fixture = project.value.fixtures.find((f) => f.id === fixtureId)
    const room = findRoom(project.value, fixture?.roomId ?? null)
    if (!fixture || !room || fixture.wallIndex === wallIndex) return

    const frame = fixtureFrame(project.value, fixture)
    const anchor = frame ? { x: frame.origin.x, y: frame.origin.y } : fixture.position
    checkpoint()

    if (wallIndex === null) {
      fixture.position = anchor
      // Keep facing the same way: `out` is (-sin, cos) of the rotation.
      if (frame) fixture.rotation = Math.atan2(-frame.out.x, frame.out.y)
      fixture.wallIndex = null
    } else {
      const wall = wallOf(room, wallIndex)
      if (!wall) return
      const { t } = closestPointOnSegment(anchor, wall.a, wall.b)
      fixture.wallIndex = wallIndex
      fixture.wallOffset = t * wall.length
    }
    touch()
  }

  /** Move a fixture to another storey, keeping its plan position where possible. */
  function moveFixtureToLevel(fixtureId: string, levelId: string): void {
    const fixture = project.value.fixtures.find((f) => f.id === fixtureId)
    if (!fixture) return
    const anchor = fixtureFrame(project.value, fixture)
    const point = anchor ? { x: anchor.origin.x, y: anchor.origin.y } : fixture.position
    checkpoint()

    const hit =
      fixtureDef(fixture.type).mount === 'wall'
        ? nearestWall(project.value, point, 2000, levelId)
        : null
    if (hit) {
      fixture.roomId = hit.roomId
      fixture.wallIndex = hit.wallIndex
      fixture.wallOffset = hit.offset
    } else {
      const room = roomAt(project.value, point, levelId) ?? roomsOnLevel(project.value, levelId)[0]
      if (!room) return
      fixture.roomId = room.id
      fixture.wallIndex = null
      fixture.position = point
    }
    touch()
  }

  function updateFixture(fixtureId: string, patch: Partial<Fixture>): void {
    const fixture = project.value.fixtures.find((f) => f.id === fixtureId)
    if (!fixture) return
    checkpoint()
    Object.assign(fixture, patch)
    touch()
  }

  function removeFixture(fixtureId: string): void {
    checkpoint()
    project.value.fixtures = project.value.fixtures.filter((f) => f.id !== fixtureId)
    touch()
  }

  /* ---------------------------------------------------------------- openings */

  function addOpeningAt(point: Vec2, kind: Opening['kind'], levelId: string | null): Opening | null {
    const level = levelOr(levelId)
    const hit = nearestWall(project.value, point, 600, level.id)
    if (!hit) return null
    checkpoint()
    const opening = createOpening(hit.roomId, hit.wallIndex, hit.offset, kind)
    // A doorway between two rooms is worth recording explicitly: it is how the plan says
    // the rooms are connected, independently of whether their walls happen to touch.
    const neighbour = roomAt(project.value, point, level.id)
    opening.connectsRoomId = neighbour && neighbour.id !== hit.roomId ? neighbour.id : null
    project.value.openings.push(opening)
    touch()
    return opening
  }

  function updateOpening(openingId: string, patch: Partial<Opening>): void {
    const opening = project.value.openings.find((o) => o.id === openingId)
    if (!opening) return
    checkpoint()
    Object.assign(opening, patch)
    touch()
  }

  function removeOpening(openingId: string): void {
    checkpoint()
    project.value.openings = project.value.openings.filter((o) => o.id !== openingId)
    touch()
  }

  /* ----------------------------------------------------------- service points */

  /**
   * Water comes into a building once; drainage can leave it in several places and there can
   * be more than one consumer unit, so those are added rather than moved.
   */
  function placeServicePoint(kind: ServiceKind, point: Vec2, levelId: string | null): ServicePoint {
    checkpoint()
    const level = levelOr(levelId)
    const room = roomAt(project.value, point, level.id)
    const existing = allowsMultiple(kind)
      ? undefined
      : project.value.servicePoints.find((s) => s.kind === kind)
    if (existing) {
      const previous = levelOr(existing.levelId)
      // Height is stored absolutely but meant relative to its own floor, so carry the
      // offset across rather than leaving the outlet buried under the storey below.
      existing.z += level.elevation - previous.elevation
      existing.levelId = level.id
      existing.position = point
      existing.roomId = room?.id ?? null
      touch()
      return existing
    }
    const created = createServicePoint(kind, point, level, room?.id ?? null)
    // Number them when there is more than one, so the schedule and the plan agree.
    const sameKind = project.value.servicePoints.filter((s) => s.kind === kind).length
    if (sameKind > 0) created.name = `${created.name} ${sameKind + 1}`
    project.value.servicePoints.push(created)
    touch()
    return created
  }

  function moveServicePointTo(id: string, point: Vec2): void {
    const service = project.value.servicePoints.find((s) => s.id === id)
    if (!service) return
    service.position = point
    service.roomId = roomAt(project.value, point, service.levelId)?.id ?? null
    touch()
  }

  function updateServicePoint(id: string, patch: Partial<ServicePoint>): void {
    const service = project.value.servicePoints.find((s) => s.id === id)
    if (!service) return
    checkpoint()
    Object.assign(service, patch)
    touch()
  }

  function removeServicePoint(id: string): void {
    checkpoint()
    project.value.servicePoints = project.value.servicePoints.filter((s) => s.id !== id)
    touch()
  }

  function updateElectrical(patch: Partial<Project['settings']['electrical']>): void {
    checkpoint()
    Object.assign(project.value.settings.electrical, patch)
    touch()
  }

  function updateSettings(patch: Partial<Project['settings']>): void {
    checkpoint()
    Object.assign(project.value.settings, patch)
    touch()
  }

  function rename(name: string): void {
    checkpoint()
    project.value.name = name
    touch()
  }

  return {
    project,
    levels,
    canUndo,
    canRedo,
    checkpoint,
    undo,
    redo,
    load,
    reset,
    loadSample,
    addLevel,
    removeLevel,
    updateLevel,
    addRoom,
    removeRoom,
    moveRoom,
    setRoomOutline,
    pushWall,
    resizeWall,
    updateRoom,
    updateRoomHeating,
    moveRoomToLevel,
    setWallLoadBearing,
    addFixtureAt,
    moveFixtureTo,
    moveFixtureToLevel,
    setFixtureMounting,
    updateFixture,
    removeFixture,
    addOpeningAt,
    updateOpening,
    removeOpening,
    placeServicePoint,
    moveServicePointTo,
    updateServicePoint,
    removeServicePoint,
    updateSettings,
    updateElectrical,
    rename,
  }
})
