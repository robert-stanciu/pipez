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
  OpeningKind,
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
    // Ceiling routing by default: it suits a slab you would rather not chase.
    cableRoute: 'ceiling',
    voltage: 230,
    lineVoltage: 400,
    mainBreakerAmps: 25,
    circuitsPerRcd: 4,
    // TN-C-S: the combined earth and neutral arrives at the boundary and is separated in the
    // house, which is what a Romanian connection normally is. TT instead means an electrode
    // and a very different set of obligations, so it is asked rather than assumed.
    earthing: 'TN-C-S',
    // Conductors in a conduit chased into a wall — `FY în tub îngropat`, and the reference
    // method every cable capacity in the app is read against.
    installationMethod: 'B1',
    // A detached house on an overhead or mixed supply wants a Type 2 arrester at the board.
    surgeProtection: 'type-2',
    modulesPerRow: 12,
  },
  standards: 'EN',
  drainage: { strategy: 'rectilinear', minSlope: 0.01, designSlope: 0.02, maxSlope: 0.05 },
  supply: {
    // PP-R by default: it is what a Romanian house is plumbed in, and ø20 — its smallest
    // size, a 13,2 mm bore — is the tap-tail connection that copper would call 15 mm.
    material: 'PPR',
    // Ceiling distribution by default: it is what the solver has always drawn, so an existing
    // project comes back looking the way it was left.
    route: 'ceiling',
    // A town main is normally good for 3 bar at the meter; below that the top floor suffers.
    entryPressureKpa: 300,
  },
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

/**
 * A room from an arbitrary outline. The polygon is the room's **inner** face; neighbours are
 * laid out so the gap between two inner faces is exactly one wall thickness.
 */
export function createShapedRoom(
  name: string,
  outline: Vec2[],
  level: Level,
  settings: ProjectSettings = DEFAULT_SETTINGS,
): Room {
  const ring = ensureCounterClockwise(outline)
  return {
    id: newId('room'),
    name,
    levelId: level.id,
    outline: ring,
    height: level.height,
    floorZ: level.elevation,
    wallThickness: settings.wallThickness,
    walls: makeWalls(ring.length),
  }
}

export function createRoom(
  name: string,
  origin: Vec2,
  width: number,
  depth: number,
  level: Level,
  settings: ProjectSettings = DEFAULT_SETTINGS,
): Room {
  return createShapedRoom(name, rectangle(origin, width, depth), level, settings)
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
  // Every nested group is copied, not shared. A shallow spread would leave two projects
  // pointing at one settings object, so changing the drainage strategy on the project in
  // front of you would silently change it on the next one created — and on the defaults.
  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    drainage: { ...DEFAULT_SETTINGS.drainage },
    electrical: { ...DEFAULT_SETTINGS.electrical },
    supply: { ...DEFAULT_SETTINGS.supply },
  }
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
 * The house drawn on **A02 "Plan parter"** and **A03 "Plan etaj"** — a P+1E detached house,
 * 15.20 × 8.95 m on the ground floor with the upper storey set back onto the eastern
 * two-thirds. It is the app's starting point and the fixture for the end-to-end tests.
 *
 * Everything below is taken off those two drawings. The origin is the inner south-west
 * corner of the ground floor, x east and y north, so the structural grid the architect
 * dimensioned from lands on round numbers: gridlines 1–6 at x = -125, 1925, 4125, 6375,
 * 10625, 14625 and rows A–G at y = 125, 1850, 3050, 3960, 5900, 7350, 10350 (wall
 * centrelines). Room outlines are the *inner* faces, so neighbouring rooms are one wall
 * thickness apart and every wall in the model is a wall on the drawing.
 *
 * Two consequences matter to the solver and are worth stating outright:
 *
 * - The upper storey only covers gridlines 3–6, so the first-floor bathroom does **not**
 *   sit over the ground-floor one — it sits over the dining area. Its soil stack has to
 *   come down inside the gridline-4 or gridline-5 wall, which are the walls that exist on
 *   both storeys.
 * - Living, dining and kitchen are one open-plan space on the drawing. They are modelled as
 *   three named rooms joined by full-width `passage` openings rather than as one blob, so
 *   the schedule still reads room by room.
 */
export function sampleProject(): Project {
  const project = createProject('Locuință P+1E')
  const settings = project.settings
  // 25 cm masonry throughout, and +2.80 floor to floor as noted on the drawings.
  settings.wallThickness = 250
  settings.wallHeight = 2600
  settings.slabThickness = 200
  // Ground-bearing slab on fill: the drains are laid in the fill under it, not chased into a
  // screed, so there is more than the 250 a suspended floor would give them. The house is
  // 15 m long and it needs every millimetre of that.
  settings.floorBuildUp = 450

  const ground = project.levels[0]
  ground.name = 'Parter'
  ground.height = settings.wallHeight
  ground.slabThickness = settings.slabThickness
  const first = createLevel(1, settings)
  first.name = 'Etaj'
  project.levels.push(first)
  relevel(project)

  const rect = (name: string, x: number, y: number, w: number, d: number, level: Level) => {
    const room = createRoom(name, { x, y }, w, d, level, settings)
    project.rooms.push(room)
    return room
  }

  /* ------------------------------------------------------------------ parter */

  const baie = rect('Baie', 0, 5900, 1800, 4200, ground)
  const centrala = rect('C.T.', 2050, 7350, 1950, 2750, ground)
  const scaraP = rect('Casa scării', 4250, 7350, 2000, 2750, ground)
  const holBaie = rect('Hol baie', 2050, 5900, 1950, 1200, ground)
  const birou = rect('Birou', 0, 3050, 4000, 2600, ground)
  const hol = rect('Hol', 4250, 1850, 2000, 5250, ground)
  const living = rect('Living', 6500, 1850, 4000, 3800, ground)
  const dining = rect('Dining', 6500, 5900, 4000, 4200, ground)
  const bucatarie = rect('Bucătărie', 10750, 5900, 3750, 4200, ground)
  const terasaLiving = rect('Terasă acoperită', 10750, 1850, 3750, 3800, ground)
  // The entrance porch is carried on two piers standing on gridlines 3 and 4, so it is
  // exactly as wide as the hall behind it.
  const terasaIntrare = rect('Terasă intrare', 4250, 0, 2000, 1600, ground)

  /* -------------------------------------------------------------------- etaj */

  const scaraE = rect('Casa scării', 4250, 7350, 2000, 2750, first)
  const baieE = rect('Baie', 6500, 8100, 4000, 2000, first)
  // The landing wraps round the stairwell, so it is the one room here that is not a
  // rectangle: it runs the full width along the north face of the bedrooms, then turns
  // north between the stair and the bathroom.
  const holE = createShapedRoom(
    'Hol',
    [
      { x: 4250, y: 5900 },
      { x: 10500, y: 5900 },
      { x: 10500, y: 7850 },
      { x: 6500, y: 7850 },
      { x: 6500, y: 7100 },
      { x: 4250, y: 7100 },
    ],
    first,
    settings,
  )
  project.rooms.push(holE)
  const dormitor1 = rect('Dormitor 1', 6500, 1850, 4000, 3800, first)
  const dormitor2 = rect('Dormitor 2', 10750, 5900, 3750, 4200, first)
  const dressing1 = rect('Dressing 1', 4250, 1850, 2000, 3800, first)
  const dressing2 = rect('Dressing 2', 10750, 3975, 3750, 1675, first)
  const terasaE = rect('Terasă', 10750, 1850, 3750, 1875, first)

  /* ---------------------------------------------------------------- openings */

  /**
   * Wall 0 of a rectangular room is its south face running west to east, and the rest follow
   * anticlockwise; `offset` is measured from that wall's start vertex. Widths, heights and
   * sills are the ones dimensioned on the drawings.
   */
  const cut = (
    kind: OpeningKind,
    room: Room,
    wallIndex: number,
    offset: number,
    width: number,
    height: number,
    sillHeight: number,
    connects: Room | null = null,
  ) => {
    project.openings.push({
      id: newId('op'),
      kind,
      roomId: room.id,
      wallIndex,
      offset,
      width,
      sillHeight,
      height,
      connectsRoomId: connects?.id ?? null,
    })
  }

  // Parter — doors and passages.
  cut('door', hol, 0, 1005, 1500, 2100, 0, terasaIntrare)
  cut('door', hol, 3, 2740, 900, 2100, 0, birou)
  cut('passage', hol, 1, 4650, 1150, 2400, 0, dining)
  cut('passage', holBaie, 1, 600, 1000, 2100, 0, hol)
  cut('door', holBaie, 3, 625, 900, 2100, 0, baie)
  cut('door', centrala, 0, 975, 900, 2100, 0, holBaie)
  cut('passage', scaraP, 0, 1000, 1800, 2100, 0, hol)
  cut('passage', living, 2, 2000, 3800, 2400, 0, dining)
  cut('passage', dining, 1, 2100, 4000, 2400, 0, bucatarie)
  cut('door', living, 1, 1825, 2500, 2100, 0, terasaLiving)
  cut('door', bucatarie, 0, 1925, 1500, 2100, 0, terasaLiving)

  // Parter — windows.
  cut('window', baie, 3, 3495, 1000, 600, 1500)
  cut('window', centrala, 2, 1020, 600, 600, 1500)
  cut('window', birou, 0, 2005, 1600, 1600, 500)
  cut('window', living, 0, 1045, 1200, 1600, 700)
  cut('window', living, 0, 2950, 1200, 1600, 800)
  cut('window', bucatarie, 1, 2110, 1800, 1100, 1000)

  // Etaj — doors and passages.
  cut('passage', scaraE, 0, 1000, 1800, 2100, 0, holE)
  cut('door', baieE, 0, 3365, 900, 2100, 0, holE)
  cut('door', dormitor1, 2, 3405, 900, 2100, 0, holE)
  cut('door', dormitor2, 3, 3265, 900, 2100, 0, holE)
  cut('door', dressing1, 1, 1815, 900, 2100, 0, dormitor1)
  cut('door', dressing2, 2, 600, 900, 2100, 0, dormitor2)
  cut('door', dormitor1, 1, 900, 1100, 2100, 0, terasaE)

  // Etaj — windows. Wall 5 of the landing is its west face, on gridline 3.
  cut('window', holE, 5, 590, 970, 1000, 900)
  cut('window', baieE, 2, 2700, 1000, 600, 1500)
  cut('window', dormitor1, 0, 1055, 1200, 1600, 500)
  cut('window', dormitor1, 0, 2955, 1200, 1600, 500)
  cut('window', dormitor2, 1, 2170, 1700, 1100, 900)
  cut('window', dressing1, 0, 1005, 800, 1200, 600)
  cut('window', dressing2, 1, 845, 800, 1000, 1200)

  /* ---------------------------------------------------------------- fixtures */

  const onWall = (type: FixtureType, room: Room, wallIndex: number, wallOffset: number) => {
    project.fixtures.push(createFixture(project, type, room.id, { wallIndex, wallOffset }))
  }
  const freeStanding = (type: FixtureType, room: Room, x: number, y: number) => {
    project.fixtures.push(createFixture(project, type, room.id, { position: { x, y } }))
  }

  // Parter — bathroom: tub across the north end, basin west, WC east, as drawn.
  onWall('bathtub', baie, 2, 900)
  onWall('basin', baie, 3, 2100)
  onWall('wc', baie, 1, 2100)
  onWall('socket', baie, 3, 1700)
  freeStanding('ceiling-light', baie, 900, 8000)

  // Parter — boiler room. The rising main and the hot network both start here.
  onWall('water-heater', centrala, 3, 700)
  onWall('washing-machine', centrala, 3, 1600)
  onWall('socket', centrala, 3, 2200)
  freeStanding('floor-drain', centrala, 2900, 8500)
  freeStanding('ceiling-light', centrala, 3025, 8700)

  // Parter — kitchen: sink under the east window, hob on the north run.
  onWall('sink', bucatarie, 1, 2100)
  onWall('dishwasher', bucatarie, 1, 3000)
  onWall('cooker', bucatarie, 2, 1630)
  onWall('socket', bucatarie, 2, 700)
  onWall('socket', bucatarie, 2, 2500)
  freeStanding('ceiling-light', bucatarie, 12600, 8000)

  // Parter — the rest is lighting and socket outlets.
  onWall('socket', scaraP, 1, 2000)
  freeStanding('ceiling-light', scaraP, 5250, 8700)
  freeStanding('ceiling-light', holBaie, 3025, 6500)
  onWall('socket', birou, 0, 800)
  onWall('socket', birou, 0, 3200)
  onWall('socket', birou, 2, 1200)
  onWall('socket', birou, 3, 1300)
  freeStanding('ceiling-light', birou, 2000, 4350)
  onWall('socket', hol, 3, 1500)
  freeStanding('ceiling-light', hol, 5250, 3000)
  freeStanding('ceiling-light', hol, 5250, 6000)
  onWall('socket', living, 0, 500)
  onWall('socket', living, 0, 3500)
  onWall('socket', living, 3, 1200)
  freeStanding('ceiling-light', living, 8500, 3750)
  onWall('socket', dining, 3, 2000)
  onWall('socket', dining, 2, 2000)
  freeStanding('ceiling-light', dining, 8500, 8000)
  freeStanding('ceiling-light', terasaLiving, 12600, 3750)

  // Etaj — bathroom: corner tub north-west, WC north, basin on the south run.
  onWall('bathtub', baieE, 2, 3150)
  onWall('wc', baieE, 2, 1830)
  onWall('basin', baieE, 0, 1620)
  onWall('socket', baieE, 0, 2600)
  freeStanding('ceiling-light', baieE, 8500, 9100)

  onWall('socket', scaraE, 1, 2000)
  freeStanding('ceiling-light', scaraE, 5250, 8700)
  onWall('socket', holE, 0, 5000)
  freeStanding('ceiling-light', holE, 5250, 6500)
  freeStanding('ceiling-light', holE, 8500, 6900)
  onWall('socket', dormitor1, 0, 600)
  onWall('socket', dormitor1, 0, 3400)
  onWall('socket', dormitor1, 2, 1000)
  onWall('socket', dormitor1, 3, 1900)
  freeStanding('ceiling-light', dormitor1, 8500, 3750)
  onWall('socket', dormitor2, 0, 700)
  onWall('socket', dormitor2, 1, 1000)
  onWall('socket', dormitor2, 2, 1000)
  onWall('socket', dormitor2, 3, 1500)
  freeStanding('ceiling-light', dormitor2, 12625, 8000)
  onWall('socket', dressing1, 0, 1500)
  freeStanding('ceiling-light', dressing1, 5250, 3750)
  onWall('socket', dressing2, 0, 3000)
  freeStanding('ceiling-light', dressing2, 12625, 4800)

  /* ----------------------------------------------------------- service points */

  // Everything wet arrives and leaves at the north-west corner: the boiler room sits between
  // the bathroom and the kitchen, so that is where the water comes in and where the collector
  // goes out. The outlet invert is 450 below the floor rather than the 200 a small house gets
  // away with — the kitchen sink is 12 m of horizontal run away, and at the 1.3% EN 12056 asks
  // of DN50 that alone is 160 mm of fall before the fixture's own drop.
  const outlet = createServicePoint('wasteOutlet', { x: 3000, y: 9200 }, ground, centrala.id)
  outlet.z = ground.elevation - 450
  project.servicePoints.push(
    outlet,
    createServicePoint('waterEntry', { x: 3600, y: 9700 }, ground, centrala.id),
    createServicePoint('electricalPanel', { x: 4400, y: 6600 }, ground, hol.id),
  )

  return relevel(project)
}
