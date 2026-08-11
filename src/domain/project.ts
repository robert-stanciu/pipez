/**
 * Project factories — the single place a valid Project, Room or Fixture is constructed, so
 * the store, the file loader and the tests all start from the same shape.
 */

import { fixtureDef } from './catalog/fixtures.ts'
import { ensureCounterClockwise, rectangle } from './geometry/polygon.ts'
import type { Vec2 } from './geometry/vec.ts'
import { newId } from './ids.ts'
import type {
  Level,
  Fixture,
  FixtureType,
  Opening,
  Project,
  ProjectSettings,
  Room,
  ServiceKind,
  ServicePoint,
  Wall,
} from './types.ts'

export const SCHEMA_VERSION = 2

export const DEFAULT_SETTINGS: ProjectSettings = {
  wallThickness: 100,
  wallHeight: 2600,
  slabThickness: 250,
  // Screed plus insulation on a domestic slab — this is the depth drainage has to fit in.
  floorBuildUp: 250,
  ceilingVoid: 300,
  gridPitch: 50,
  // Under-floor connections by default: the common arrangement, and it needs no wall.
  connectionEntry: 'bottom',
  electrical: {
    // Three-phase by default: it is what a new supply is, and a single-phase project simply
    // never uses the other two lines.
    supply: 'three-phase',
    voltage: 230,
    lineVoltage: 400,
    mainBreakerAmps: 25,
    circuitsPerRcd: 4,
  },
  standards: 'EN',
  drainage: { strategy: 'rectilinear', minSlope: 0.01, designSlope: 0.02, maxSlope: 0.05 },
}

export function makeWalls(vertexCount: number): Wall[] {
  return Array.from({ length: vertexCount }, (_, index) => ({
    id: newId('w'),
    index,
    loadBearing: false,
  }))
}

/* -------------------------------------------------------------------- levels */

const STOREY_NAMES = ['Ground floor', 'First floor', 'Second floor', 'Third floor']

export function createLevel(index: number, settings: ProjectSettings = DEFAULT_SETTINGS): Level {
  return {
    id: newId('lvl'),
    name: STOREY_NAMES[index] ?? `Level ${index}`,
    index,
    elevation: 0,
    height: settings.wallHeight,
    slabThickness: settings.slabThickness,
  }
}

/**
 * Recompute every level's elevation by stacking storey heights and slabs from the ground up,
 * then push the result into the rooms.
 *
 * Elevations are derived, never edited: what a person changes is a storey's *height*, and
 * everything above has to move. Rooms carry a copy of their floor elevation because the
 * geometry helpers and the router read it on every node they build.
 */
export function relevel(project: Project): Project {
  project.levels.sort((a, b) => a.index - b.index)

  let elevation = 0
  project.levels.forEach((level, position) => {
    level.index = position
    level.elevation = elevation
    elevation += level.height + level.slabThickness
  })

  const byId = new Map(project.levels.map((level) => [level.id, level]))
  const ground = project.levels[0]
  for (const room of project.rooms) {
    const level = byId.get(room.levelId) ?? ground
    if (!level) continue
    room.levelId = level.id
    room.floorZ = level.elevation
  }
  for (const point of project.servicePoints) {
    if (!byId.has(point.levelId) && ground) point.levelId = ground.id
  }
  return project
}

export function createRoom(
  name: string,
  origin: Vec2,
  width: number,
  depth: number,
  level: Level,
  settings: ProjectSettings = DEFAULT_SETTINGS,
): Room {
  const outline = ensureCounterClockwise(rectangle(origin, width, depth))
  return {
    id: newId('room'),
    name,
    levelId: level.id,
    outline,
    height: level.height,
    floorZ: level.elevation,
    wallThickness: settings.wallThickness,
    walls: makeWalls(outline.length),
  }
}

/** Distinct name for a new fixture of this type — "Sink", then "Sink 2", and so on. */
export function nextFixtureName(project: Project, type: FixtureType): string {
  const label = fixtureDef(type).label
  const taken = project.fixtures.filter((f) => f.type === type).length
  return taken === 0 ? label : `${label} ${taken + 1}`
}

export function createFixture(
  project: Project,
  type: FixtureType,
  roomId: string,
  placement: { wallIndex: number; wallOffset: number } | { position: Vec2; rotation?: number },
): Fixture {
  const def = fixtureDef(type)
  const room = project.rooms.find((r) => r.id === roomId)
  // A ceiling fitting is dimensioned from the slab down, everything else from the floor up.
  const z = def.mount === 'ceiling' ? (room?.height ?? DEFAULT_SETTINGS.wallHeight) - 50 : def.defaultZ

  const onWall = 'wallIndex' in placement
  return {
    id: newId('fix'),
    type,
    name: nextFixtureName(project, type),
    roomId,
    entry: null,
    threePhase: null,
    wallIndex: onWall ? placement.wallIndex : null,
    wallOffset: onWall ? placement.wallOffset : 0,
    position: onWall ? { x: 0, y: 0 } : placement.position,
    rotation: onWall ? 0 : (placement.rotation ?? 0),
    z,
  }
}

export function createOpening(
  roomId: string,
  wallIndex: number,
  offset: number,
  kind: Opening['kind'] = 'door',
): Opening {
  const isWindow = kind === 'window'
  return {
    id: newId('op'),
    kind,
    roomId,
    wallIndex,
    offset,
    width: isWindow ? 1200 : 900,
    sillHeight: isWindow ? 900 : 0,
    height: isWindow ? 1200 : 2100,
    connectsRoomId: null,
  }
}

const SERVICE_DEFAULT_Z: Record<ServiceKind, number> = {
  // The waste outlet is an invert level, so it sits below the floor datum.
  wasteOutlet: -200,
  waterEntry: 500,
  electricalPanel: 1600,
}

export function createServicePoint(
  kind: ServiceKind,
  position: Vec2,
  level: Level,
  roomId: string | null,
): ServicePoint {
  const names: Record<ServiceKind, string> = {
    waterEntry: 'Water entry',
    wasteOutlet: 'Waste outlet',
    electricalPanel: 'Consumer unit',
  }
  return {
    id: newId('svc'),
    kind,
    name: names[kind],
    levelId: level.id,
    roomId,
    position,
    // Service heights are relative to their own storey's floor; the outlet invert is below it.
    z: level.elevation + SERVICE_DEFAULT_Z[kind],
  }
}

export function createProject(name = 'Untitled project'): Project {
  const now = new Date().toISOString()
  const settings = { ...DEFAULT_SETTINGS, drainage: { ...DEFAULT_SETTINGS.drainage } }
  return relevel({
    schemaVersion: SCHEMA_VERSION,
    id: newId('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    settings,
    levels: [createLevel(0, settings)],
    rooms: [],
    openings: [],
    fixtures: [],
    servicePoints: [],
  })
}

/**
 * A small two-storey house used as the app's starting point and as the fixture for the
 * end-to-end tests.
 *
 * Rooms are placed so their wall centrelines coincide exactly — side to side, so neighbours
 * share one wall, and floor to floor, so the upstairs bathroom sits directly over the
 * downstairs one. That vertical alignment is what gives the router somewhere to drop a soil
 * stack: it may only cross a slab inside a wall that exists on both storeys.
 */
export function sampleProject(): Project {
  const project = createProject('Sample house')
  const t = project.settings.wallThickness

  const ground = project.levels[0]
  const first = createLevel(1, project.settings)
  project.levels.push(first)
  relevel(project)

  const kitchen = createRoom('Kitchen', { x: 0, y: 0 }, 3400, 2800, ground, project.settings)
  const wc = createRoom('Cloakroom', { x: 3400 + t, y: 0 }, 2200, 2000, ground, project.settings)
  const bedroom = createRoom('Bedroom', { x: 0, y: 0 }, 3400, 2800, first, project.settings)
  const bathroom = createRoom('Bathroom', { x: 3400 + t, y: 0 }, 2200, 2000, first, project.settings)
  project.rooms.push(kitchen, wc, bedroom, bathroom)

  // Wall 1 of each west room is its east face; a doorway there links the pair.
  for (const [from, to] of [
    [kitchen, wc],
    [bedroom, bathroom],
  ] as const) {
    const door = createOpening(from.id, 1, 1400, 'door')
    door.connectsRoomId = to.id
    project.openings.push(door)
  }

  const add = (
    type: FixtureType,
    roomId: string,
    placement: Parameters<typeof createFixture>[3],
  ) => {
    project.fixtures.push(createFixture(project, type, roomId, placement))
  }

  // Ground floor — the kitchen's south wall is index 0, running west to east.
  add('sink', kitchen.id, { wallIndex: 0, wallOffset: 700 })
  add('dishwasher', kitchen.id, { wallIndex: 0, wallOffset: 1500 })
  add('washing-machine', kitchen.id, { wallIndex: 0, wallOffset: 2200 })
  add('cooker', kitchen.id, { wallIndex: 2, wallOffset: 1700 })
  add('socket', kitchen.id, { wallIndex: 2, wallOffset: 900 })
  add('ceiling-light', kitchen.id, { position: { x: 1700, y: 1400 } })
  add('wc', wc.id, { wallIndex: 2, wallOffset: 600 })
  add('basin', wc.id, { wallIndex: 2, wallOffset: 1500 })
  add('ceiling-light', wc.id, { position: { x: 4600, y: 1000 } })

  // First floor — the bathroom is stacked directly above the cloakroom.
  add('wc', bathroom.id, { wallIndex: 2, wallOffset: 600 })
  add('basin', bathroom.id, { wallIndex: 2, wallOffset: 1400 })
  add('shower', bathroom.id, { wallIndex: 1, wallOffset: 700 })
  add('ceiling-light', bathroom.id, { position: { x: 4600, y: 1000 } })
  add('socket', bedroom.id, { wallIndex: 0, wallOffset: 900 })
  add('socket', bedroom.id, { wallIndex: 2, wallOffset: 2200 })
  add('ceiling-light', bedroom.id, { position: { x: 1700, y: 1400 } })

  project.servicePoints.push(
    createServicePoint('wasteOutlet', { x: 3200, y: 300 }, ground, kitchen.id),
    createServicePoint('waterEntry', { x: 200, y: 300 }, ground, kitchen.id),
    createServicePoint('electricalPanel', { x: 300, y: 2600 }, ground, kitchen.id),
  )

  return relevel(project)
}
