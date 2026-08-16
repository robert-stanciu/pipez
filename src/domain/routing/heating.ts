/**
 * Underfloor heating, from the manifolds outwards.
 *
 * A manifold is placed on the plan and everything else follows from it: every heated room on
 * that storey is assigned to its nearest one, the floor of each is covered with coils (see
 * `loops.ts` for how one is set out), the coils are led back to the manifold in the screed,
 * and the manifolds themselves are fed from the heat source.
 *
 * The shape of this solver is deliberately unlike the other four. There is no tree and no
 * Steiner bundling, because a heating loop must not be bundled with anything: it is a single
 * unbroken length of pipe off a coil, out of the manifold and back, with no joint anywhere in
 * the screed. What the graph is used for is only the **leaders** — the pair of pipes between
 * the manifold and the room — and the **primary** between the heat source and each manifold,
 * both of which are ordinary routing problems.
 *
 * The sizing is EN 1264 and lives in `standards/en1264.ts`. Three things are checked against
 * it and each one can fail a design on its own: the floor may not get hotter than people can
 * stand on, a loop may not be longer or more resistant than the circulator can push water
 * round, and the loops on one manifold have to be close enough in length that its valves can
 * balance them.
 */

import { area as polygonArea, offsetPolyline, perimeter } from '../geometry/polygon.ts'
import { dist2, dist3, to3, type Vec2, type Vec3 } from '../geometry/vec.ts'
import {
  fixtureFootprint,
  fixtureFrame,
  heatingOf,
  roomsOnLevel,
  servicePointsOf,
  sortedLevels,
} from '../model.ts'
import {
  belowTemperature,
  downwardFlux,
  insulationThickness,
  JOINT_SLEEVE_LENGTH,
  KINEMATIC_VISCOSITY_HEATING,
  logMeanExcess,
  LOOP_FITTING_ALLOWANCE,
  LOOP_VELOCITY,
  loopVelocity,
  massFlowKgH,
  MANIFOLD_PRESSURE_KPA,
  maxFlux,
  MAX_FIELD_AREA_M2,
  MAX_FIELD_SIDE,
  MAX_LOOP_IMBALANCE,
  MAX_LOOP_PRESSURE_KPA,
  MAX_LOOPS_PER_MANIFOLD,
  MIN_HEATED_AREA_M2,
  MIN_SCREED_COVER,
  minInsulationResistance,
  peripheralPitch,
  surfaceLimitFor,
  surfaceTemperature,
  ufhPipe,
  upwardFlux,
  WALL_CLEARANCE,
  type BelowFloor,
} from '../standards/en1264.ts'
import { boreOf, pressureLossKpa, supplySizes } from '../standards/en806.ts'
import type {
  BomLine,
  FixtureType,
  HeatingLoop,
  Level,
  ManifoldDesign,
  Project,
  Room,
  RoutingWarning,
  Segment,
  SegmentRole,
  ServicePoint,
} from '../types.ts'
import { RouteGraph } from './graph.ts'
import {
  attachTerminal,
  buildPlaneGrid,
  linkStoreys,
  planLines,
  type Layer,
  type LevelShapes,
} from './layers.ts'
import { layLoop, longestSide, splitBands, type Band } from './loops.ts'
import { shortestPaths } from './search.ts'
import type { SystemSolution } from './waste.ts'

export interface HeatingSolution extends SystemSolution {
  loops: HeatingLoop[]
  manifolds: ManifoldDesign[]
  /**
   * What the coils need besides pipe — edge strip, clips. The routed geometry cannot express
   * them, and they are as much a part of a compliant floor as the pipe is.
   */
  bom: BomLine[]
}

/** Distance between the two pipes of a flow-and-return pair, mm. */
const PAIR_PITCH = 60

/**
 * How much more pipe a graded coil takes than its area over its design pitch.
 *
 * The peripheral runs are laid at half the pitch, so a coil comes out a little tighter than
 * what was asked for. Only used to decide how many loops a room needs — the loops themselves
 * are measured off the geometry once they are laid.
 */
const PERIPHERAL_ALLOWANCE = 1.15

/** Slab crossings are dear, so the primaries to an upstairs manifold gather onto one riser. */
const SLAB_CROSSING_WEIGHT = 10

/** Velocity the primary flow and return are sized to, m/s — quiet, for a pipe in a screed. */
const PRIMARY_VELOCITY = 0.8

/**
 * Fixtures a coil may not be laid under.
 *
 * Either they are screwed down through the screed — a WC is fixed with two bolts into exactly
 * the depth the pipe is at — or they stand on the floor and would be heating their own
 * underside instead of the room. A basin or a sink is neither: it hangs off the wall with the
 * floor free underneath it.
 */
const OBSTACLES: ReadonlySet<FixtureType> = new Set<FixtureType>([
  'wc',
  'bathtub',
  'shower',
  'floor-drain',
  'washing-machine',
  'dishwasher',
  'tumble-dryer',
  'cooker',
])

export function routeHeating(
  project: Project,
  shapes: LevelShapes,
  nextId: () => string,
): HeatingSolution {
  const warnings: RoutingWarning[] = []
  const segments: Segment[] = []
  const loops: HeatingLoop[] = []
  const manifolds: ManifoldDesign[] = []
  const bom: BomLine[] = []

  const empty = (): HeatingSolution => ({
    network: {
      system: 'heating',
      segments: [],
      fittings: [],
      totalLength: 0,
      unreachedFixtureIds: [],
    },
    loops: [],
    manifolds: [],
    bom: [],
    warnings,
    graphNodes: 0,
    graphEdges: 0,
  })

  const boards = servicePointsOf(project, 'heatingManifold')
  // No manifold is not a fault: it means the house has no underfloor heating in it.
  if (boards.length === 0) return empty()

  const heating = project.settings.heating
  const pipe = ufhPipe(heating.pipe)
  const returnTempC = heating.flowTempC - heating.deltaTK
  const levels = sortedLevels(project)

  /* ----------------------------------------------------- what goes where, and how deep */

  /**
   * The coil sits in the screed, near the top of the build-up: the cover over it is what
   * EN 1264-4 fixes, so the depth follows from the cover rather than the other way round.
   */
  const planeZ = (level: Level): number =>
    level.elevation - heating.screedCover - pipe.od / 2

  checkBuildUp(project, warnings, nextId)

  /* -------------------------------------------------------------- the rooms to heat */

  interface Assignment {
    room: Room
    level: Level
    board: ServicePoint
  }
  const assignments: Assignment[] = []
  for (const level of levels) {
    const onLevel = boards.filter((b) => b.levelId === level.id)
    for (const room of roomsOnLevel(project, level.id)) {
      const settings = heatingOf(project, room)
      if (!settings.enabled) continue
      // A cupboard or a meter recess is not worth a port on the manifold, and since every
      // room is heated unless told otherwise there will be several of them. Passed over
      // quietly rather than reported: nothing is wrong, there is just nothing to do.
      if (polygonArea(room.outline) / 1e6 < MIN_HEATED_AREA_M2) continue

      const named = settings.manifoldId
        ? boards.find((b) => b.id === settings.manifoldId)
        : undefined
      const pool = named ? [named] : onLevel
      if (pool.length === 0) {
        warnings.push({
          id: nextId(),
          severity: 'warning',
          system: 'heating',
          message: `${room.name} is set to be heated but there is no manifold on ${level.name}. Place one, or point the room at a manifold on another storey — its leaders would then have to cross the slab.`,
        })
        continue
      }
      const centre = roomCentre(room)
      const board = pool.reduce((best, candidate) =>
        dist2(centre, candidate.position) < dist2(centre, best.position) ? candidate : best,
      )
      assignments.push({ room, level, board })
    }
  }
  if (assignments.length === 0) return empty()

  /* ------------------------------------------------------------------- the coils */

  interface LaidLoop {
    /** Plan polyline of the coil, from the flow connection to the return connection. */
    path: Vec2[]
    z: number
    room: Room
    level: Level
    board: ServicePoint
    partOf: number
    area: number
    pitch: number
  }
  const laid: LaidLoop[] = []

  for (const { room, level, board } of assignments) {
    const settings = heatingOf(project, room)
    const obstacles = obstaclesIn(project, room)
    const roomArea = polygonArea(room.outline) / 1e6
    // Leaders are pipe off the same coil, so they have to be inside the length budget before
    // the field is divided up. Manhattan there and back, with a bit for getting round things.
    const leaderEstimate =
      2 *
      1.3 *
      (Math.abs(roomCentre(room).x - board.position.x) +
        Math.abs(roomCentre(room).y - board.position.y))

    const bands = divide(room.outline, settings.spacing, leaderEstimate, pipe.maxLoopLength)
    let part = 0
    for (const band of bands) {
      const layout = layLoop({
        outline: band.lay,
        extent: band.extent,
        obstacles,
        spacing: settings.spacing,
        peripheral: peripheralPitch(settings.spacing),
        clearance: WALL_CLEARANCE,
        anchor: board.position,
      })
      if (!layout) continue
      part += 1
      laid.push({
        path: layout.path,
        z: planeZ(level),
        room,
        level,
        board,
        partOf: bands.length > 1 ? part : 0,
        area: layout.area,
        pitch: layout.effectivePitch,
      })
    }

    if (part === 0) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'heating',
        message: `No heating coil fits in ${room.name}: at ${WALL_CLEARANCE} mm off every wall there is not enough clear floor left to lay one in. Widen the room, or take it off underfloor heating.`,
      })
      continue
    }

    checkMovementJoints(room, roomArea, warnings, nextId)
  }

  if (laid.length === 0) return empty()

  /* ------------------------------------------------------------------ the graph */

  const graph = new RouteGraph()
  const attachAt: Vec2[] = [
    ...boards.map((b) => b.position),
    ...laid.flatMap((loop) => [loop.path[0], loop.path[loop.path.length - 1]]),
  ]
  const source = heatSource(project)
  if (source) attachAt.push({ x: source.x, y: source.y })
  const lines = planLines(project, attachAt)

  const planeOf = new Map<string, Layer>()
  for (const level of levels) {
    const shape = shapes.byLevelId.get(level.id)
    if (!shape || shape.walls.length === 0) continue
    planeOf.set(
      level.id,
      buildPlaneGrid(graph, project, shape, {
        z: planeZ(level),
        lines,
        penetrationWeight: 4,
        allowLoadBearingPenetration: true,
      }),
    )
  }

  const slabEdges = new Set<number>()
  for (let i = 1; i < levels.length; i++) {
    const lower = planeOf.get(levels[i - 1].id)
    const upper = planeOf.get(levels[i].id)
    const lowerShape = shapes.byLevelId.get(levels[i - 1].id)
    const upperShape = shapes.byLevelId.get(levels[i].id)
    if (!lower || !upper || !lowerShape || !upperShape) continue
    for (const id of linkStoreys(
      graph,
      { layer: lower, shape: lowerShape },
      { layer: upper, shape: upperShape },
      SLAB_CROSSING_WEIGHT,
    )) {
      slabEdges.add(id)
    }
  }

  /* ------------------------------------------------- leaders, and the loop schedule */

  const emit = (
    points: Vec3[],
    size: number,
    role: SegmentRole,
    load: number,
    edgeIds: number[] = [],
  ): void => {
    for (let i = 1; i < points.length; i++) {
      const length = dist3(points[i - 1], points[i])
      if (length < 1) continue
      segments.push({
        id: nextId(),
        system: 'heating',
        a: { ...points[i - 1] },
        b: { ...points[i] },
        size,
        load,
        length,
        // Only the primary ever crosses a slab, and when it does it is a riser and is priced
        // as one. A coil and its leaders stay on one storey by construction.
        role: role === 'primary' && slabEdges.has(edgeIds[i - 1] ?? -1) ? 'stack' : role,
      })
    }
  }

  const portCount = new Map<string, number>()
  const loopsOfBoard = new Map<string, HeatingLoop[]>()

  for (const board of boards) {
    const plane = planeOf.get(board.levelId)
    const mine = laid.filter((loop) => loop.board.id === board.id)
    if (!plane || mine.length === 0) continue

    const boardNode = attachTerminal(graph, plane, to3(board.position, plane.z))
    if (boardNode === null) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'heating',
        message: `${board.name} sits outside the building footprint, so nothing can be routed to it.`,
        position: to3(board.position, board.z),
      })
      continue
    }

    // One search per manifold rather than one per loop: the leaders all start here, so the
    // shortest route to every loop in the house falls out of a single tree.
    const tree = shortestPaths(graph, boardNode, {
      turnPenalty: 300,
      reuseDiscount: 1,
      usedEdges: new Set(),
    })

    for (const loop of mine) {
      const settings = heatingOf(project, loop.room)
      const flowEnd = loop.path[0]
      const returnEnd = loop.path[loop.path.length - 1]
      const loopPlane = planeOf.get(loop.level.id) ?? plane
      const target = attachTerminal(graph, loopPlane, to3(flowEnd, loop.z))
      const route = target === null ? null : tree.to(target)
      if (!route) {
        warnings.push({
          id: nextId(),
          severity: 'error',
          system: 'heating',
          message: `No route in the floor from ${board.name} to the coil in ${loop.room.name}. Check that the rooms connect.`,
          position: to3(flowEnd, loop.z),
        })
        continue
      }

      // The leader pair: the routed path is the flow, and the return runs alongside it at a
      // fixed offset and finishes at the other end of the coil. The offset is carried right
      // up to the manifold rather than pinched shut there — a manifold is two bars a hand's
      // width apart, and pinching the pair together would draw the return across the flow.
      const spine = route.path.map((node) => ({ ...graph.position(node) }))
      const back = offsetPolyline(spine.map((p) => ({ x: p.x, y: p.y })), PAIR_PITCH)
      const returnPoints: Vec3[] = back.map((p, i) => to3(p, spine[i].z))
      returnPoints.push(to3(returnEnd, loop.z))

      const coil = loop.path.map((p) => to3(p, loop.z))
      const length = runLength(spine) + runLength(returnPoints) + runLength(coil)

      const port = (portCount.get(board.id) ?? 0) + 1
      portCount.set(board.id, port)

      const record = describe({
        id: nextId(),
        board,
        loop,
        port,
        settings,
        heating,
        returnTempC,
        pipe,
        length,
        below: loop.level.index === 0 ? 'ground' : 'heated',
      })
      loops.push(record)
      const list = loopsOfBoard.get(board.id)
      if (list) list.push(record)
      else loopsOfBoard.set(board.id, [record])

      // Segments carry the loop's own flow, so a run in the plan or the 3D view can be traced
      // back to the port it comes off.
      emit(spine, pipe.od, 'branch', record.flowKgH, route.edgeIds)
      emit(returnPoints, pipe.od, 'branch', record.flowKgH)
      emit(coil, pipe.od, 'loop', record.flowKgH)

      checkLoop(record, pipe.maxLoopLength, warnings, nextId)
    }
  }

  if (loops.length === 0) return empty()

  /* ----------------------------------------------------------------- the primary */

  /** Each manifold's primary carries that manifold, so it is sized on that manifold's flow. */
  const primarySizeOf = (boardId: string): number =>
    primaryDiameter(
      project,
      (loopsOfBoard.get(boardId) ?? []).reduce((sum, loop) => sum + loop.flowKgH, 0),
    )

  const sourceNode = (() => {
    if (!source) return null
    const plane = planeFor(planeOf, levels, source.z)
    return plane ? attachTerminal(graph, plane, { x: source.x, y: source.y, z: plane.z }) : null
  })()

  if (!source) {
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'heating',
      message:
        'No heat source on the plan, so the primary flow and return to the manifolds are not drawn. Place a water heater in the plant room and they will be.',
    })
  }

  const primaryLength = new Map<string, number>()
  if (sourceNode !== null) {
    const tree = shortestPaths(graph, sourceNode, {
      turnPenalty: 400,
      reuseDiscount: 0.2,
      usedEdges: new Set(),
    })
    for (const board of boards) {
      if (!loopsOfBoard.get(board.id)?.length) continue
      const plane = planeOf.get(board.levelId)
      const target = plane ? attachTerminal(graph, plane, to3(board.position, plane.z)) : null
      const route = target === null ? null : tree.to(target)
      if (!route) {
        warnings.push({
          id: nextId(),
          severity: 'error',
          system: 'heating',
          message: `No route for the primary flow and return from the heat source to ${board.name}. A riser may only pass through a wall that exists on both storeys.`,
        })
        continue
      }
      const spine = route.path.map((node) => ({ ...graph.position(node) }))
      const back = offsetPolyline(spine.map((p) => ({ x: p.x, y: p.y })), PAIR_PITCH).map(
        (p, i) => to3(p, spine[i].z),
      )
      const flow = loopsOfBoard.get(board.id)?.reduce((sum, l) => sum + l.flowKgH, 0) ?? 0
      const size = primarySizeOf(board.id)
      emit(spine, size, 'primary', flow, route.edgeIds)
      emit(back, size, 'primary', flow)
      primaryLength.set(board.id, runLength(spine) + runLength(back))
    }
  }

  // The bundle climbing out of the screed into the cabinet. One run rather than one per loop:
  // what is drawn is the riser into the manifold, and what is inside it is on the schedule.
  for (const board of boards) {
    const plane = planeOf.get(board.levelId)
    const mine = loopsOfBoard.get(board.id)
    if (!plane || !mine?.length) continue
    emit(
      [to3(board.position, plane.z), to3(board.position, board.z)],
      primarySizeOf(board.id),
      'primary',
      mine.reduce((sum, loop) => sum + loop.flowKgH, 0),
    )
  }

  /* ---------------------------------------------------------------- the manifolds */

  for (const board of boards) {
    const mine = loopsOfBoard.get(board.id) ?? []
    if (mine.length === 0) continue
    manifolds.push(
      commission(
        board,
        mine,
        heating.flowTempC,
        returnTempC,
        primarySizeOf(board.id),
        primaryLength.get(board.id) ?? 0,
      ),
    )
  }
  for (const design of manifolds) {
    checkManifold(design, loopsOfBoard.get(design.id) ?? [], warnings, nextId)
  }

  /* --------------------------------------------------------------- what to order */

  bom.push(...accessories(project, loops, segments, pipe.label))

  return {
    network: {
      system: 'heating',
      segments,
      // A coil has no fittings at all. Deriving them off the geometry, as every other system
      // does, would put an elbow on the order at every turn of a pipe that is simply bent.
      fittings: [],
      totalLength: segments.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: [],
    },
    loops,
    manifolds,
    bom,
    warnings,
    graphNodes: graph.nodeCount,
    graphEdges: graph.edgeCount,
  }
}

/* ------------------------------------------------------------------- geometry */

const roomCentre = (room: Room): Vec2 => {
  const n = room.outline.length
  return {
    x: room.outline.reduce((sum, p) => sum + p.x, 0) / n,
    y: room.outline.reduce((sum, p) => sum + p.y, 0) / n,
  }
}

function runLength(points: Vec3[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += dist3(points[i - 1], points[i])
  return total
}

function obstaclesIn(project: Project, room: Room): Vec2[][] {
  return project.fixtures
    .filter((f) => f.roomId === room.id && OBSTACLES.has(f.type))
    .map((f) => fixtureFootprint(project, f))
    .filter((poly) => poly.length >= 3)
}

/** The heat source the primaries start from — the boiler or store, if one is placed. */
function heatSource(project: Project): Vec3 | null {
  const heater = project.fixtures.find((f) => f.type === 'water-heater')
  if (!heater) return null
  const frame = fixtureFrame(project, heater)
  return frame ? { ...frame.origin } : null
}

function planeFor(
  planes: Map<string, Layer>,
  levels: Level[],
  z: number,
): Layer | null {
  let best: Layer | null = null
  let bestGap = Infinity
  for (const level of levels) {
    const plane = planes.get(level.id)
    if (!plane) continue
    const gap = z >= level.elevation ? z - level.elevation : Infinity
    if (gap < bestGap) {
      bestGap = gap
      best = plane
    }
  }
  return best ?? planes.get(levels[0]?.id ?? '') ?? null
}

/**
 * How many loops a room needs, and the bands they cover.
 *
 * The estimate is the pipe a field of that area takes at that pitch, plus the perimeter leg
 * and the leaders. It only has to be good enough to pick the number of bands — the loops are
 * measured properly once they are laid, and a loop that still comes out too long is reported
 * rather than silently re-cut.
 */
function divide(
  outline: Vec2[],
  spacing: number,
  leaderEstimate: number,
  maxLoopLength: number,
): Band[] {
  // Floor area over pitch is the pipe a coil takes, perimeter run and all — that run covers a
  // strip of floor like any other. A shade more than that, because the runs against the walls
  // are drawn in tighter than the design pitch and the peripheral zone is pipe too.
  const estimate = (polygonArea(outline) / spacing) * PERIPHERAL_ALLOWANCE + leaderEstimate
  const count = Math.max(1, Math.ceil(estimate / maxLoopLength))
  // Grown across each cut until the two perimeter runs meet at one peripheral pitch — the
  // most the bands can be grown before they start laying pipe in the same floor.
  const overlap = Math.max(0, WALL_CLEARANCE - peripheralPitch(spacing) / 2)
  return splitBands(outline, count, overlap)
}

/* -------------------------------------------------------------------- the sums */

interface DescribeArgs {
  id: string
  board: ServicePoint
  loop: {
    room: Room
    level: Level
    partOf: number
    area: number
    pitch: number
  }
  port: number
  settings: ReturnType<typeof heatingOf>
  heating: Project['settings']['heating']
  returnTempC: number
  pipe: ReturnType<typeof ufhPipe>
  length: number
  below: BelowFloor
}

/** Everything EN 1264 has to say about one laid loop. */
function describe(args: DescribeArgs): HeatingLoop {
  const { loop, settings, heating, returnTempC, pipe } = args
  const roomTempC = settings.roomTempC
  const excess = logMeanExcess(heating.flowTempC, returnTempC, roomTempC)
  const pitch = Math.max(50, Math.min(400, loop.pitch))

  const flux = upwardFlux(excess, {
    coverMm: heating.screedCover,
    covering: settings.covering,
    spacingMm: pitch,
    odMm: pipe.od,
  })
  const surfaceLimitC = surfaceLimitFor(roomTempC)
  const down = downwardFlux(
    roomTempC + excess,
    belowTemperature(args.below, roomTempC),
    heating.insulationR,
  )

  const outputW = flux * loop.area
  const flowKgH = massFlowKgH((flux + down) * loop.area, heating.deltaTK)
  const velocity = loopVelocity(flowKgH, pipe.bore)

  return {
    id: args.id,
    manifoldId: args.board.id,
    port: args.port,
    roomId: loop.room.id,
    roomName: loop.room.name,
    levelId: loop.level.id,
    partOf: loop.partOf,
    length: args.length,
    area: loop.area,
    spacing: Math.round(pitch),
    covering: settings.covering,
    roomTempC,
    fluxW: flux,
    outputW,
    downwardW: down,
    surfaceTempC: surfaceTemperature(roomTempC, flux),
    surfaceLimitC,
    flowKgH,
    velocity,
    pressureDropKpa: pressureLossKpa(
      flowKgH / 3600,
      pipe.bore,
      args.length * LOOP_FITTING_ALLOWANCE,
      KINEMATIC_VISCOSITY_HEATING,
    ),
  }
}

function commission(
  board: ServicePoint,
  mine: HeatingLoop[],
  flowTempC: number,
  returnTempC: number,
  primarySize: number,
  primaryLength: number,
): ManifoldDesign {
  const lengths = mine.map((loop) => loop.length)
  const worst = Math.max(...mine.map((loop) => loop.pressureDropKpa))
  // Manifolds are built in whole ports; two spare is what leaves room for the extension
  // nobody has asked for yet and everybody eventually wants.
  const ports = Math.min(MAX_LOOPS_PER_MANIFOLD, Math.max(2, mine.length))
  return {
    id: board.id,
    name: board.name,
    levelId: board.levelId,
    loops: mine.length,
    ports,
    flowTempC,
    returnTempC,
    outputW: mine.reduce((sum, loop) => sum + loop.outputW, 0),
    flowKgH: mine.reduce((sum, loop) => sum + loop.flowKgH, 0),
    pumpHeadKpa: worst + MANIFOLD_PRESSURE_KPA,
    shortestLoop: Math.min(...lengths),
    longestLoop: Math.max(...lengths),
    primarySize,
    primaryLength,
  }
}

/** Smallest pipe in the project's supply material that carries the flow quietly. */
function primaryDiameter(project: Project, flowKgH: number): number {
  const material = project.settings.supply.material
  const ladder = supplySizes(material)
  const flowM3s = flowKgH / 3600 / 1000
  const needed = Math.sqrt((4 * flowM3s) / (Math.PI * PRIMARY_VELOCITY)) * 1000
  for (const size of ladder) {
    if (boreOf(material, size.od) >= needed) return size.od
  }
  return ladder[ladder.length - 1].od
}

/* --------------------------------------------------------------------- checks */

function checkBuildUp(project: Project, warnings: RoutingWarning[], nextId: () => string): void {
  const heating = project.settings.heating
  const pipe = ufhPipe(heating.pipe)

  if (heating.screedCover < MIN_SCREED_COVER) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `Only ${heating.screedCover} mm of screed over the pipe. EN 1264-4 asks for at least ${MIN_SCREED_COVER} mm on a cement screed — below that the floor cracks along the runs and you can feel them underfoot.`,
    })
  }

  // Assessed against the ground floor, which is the storey with the least friendly thing
  // underneath it and the one that sets the specification for the insulation bought.
  const required = minInsulationResistance('ground')
  if (heating.insulationR < required) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `${heating.insulationR.toFixed(2)} m²K/W of insulation under the ground-floor coils, against the ${required.toFixed(2)} EN 1264-4 requires over the ground. That is ${insulationThickness(required)} mm of EPS rather than ${insulationThickness(heating.insulationR)} — the difference goes straight into the ground.`,
    })
  }

  const needed = insulationThickness(heating.insulationR) + pipe.od + heating.screedCover
  if (needed > project.settings.floorBuildUp) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `The heated floor needs ${needed} mm of build-up — ${insulationThickness(heating.insulationR)} mm of insulation, ${pipe.od} mm of pipe and ${heating.screedCover} mm of cover — and there is ${project.settings.floorBuildUp} mm to put it in. Something has to give, and it is usually the insulation.`,
    })
  }
}

function checkMovementJoints(
  room: Room,
  areaM2: number,
  warnings: RoutingWarning[],
  nextId: () => string,
): void {
  const side = longestSide(room.outline)
  if (areaM2 <= MAX_FIELD_AREA_M2 && side <= MAX_FIELD_SIDE) return
  const fields = Math.max(2, Math.ceil(Math.max(areaM2 / MAX_FIELD_AREA_M2, side / MAX_FIELD_SIDE)))
  warnings.push({
    id: nextId(),
    severity: 'info',
    system: 'heating',
    message: `${room.name} is ${areaM2.toFixed(1)} m² and ${(side / 1000).toFixed(1)} m on its longest side, over the ${MAX_FIELD_AREA_M2} m² and ${MAX_FIELD_SIDE / 1000} m EN 1264-4 allows in one heated field. It needs ${fields - 1} movement joint${fields === 2 ? '' : 's'} through the full depth of the screed, and every pipe crossing one sleeved for ${JOINT_SLEEVE_LENGTH} mm.`,
  })
}

function checkLoop(
  loop: HeatingLoop,
  maxLoopLength: number,
  warnings: RoutingWarning[],
  nextId: () => string,
): void {
  const name = loop.partOf > 0 ? `${loop.roomName} loop ${loop.partOf}` : loop.roomName

  if (loop.surfaceTempC > loop.surfaceLimitC + 0.05) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `The floor in ${name} reaches ${loop.surfaceTempC.toFixed(1)} °C, over the ${loop.surfaceLimitC} °C EN 1264-2 allows. It is giving ${Math.round(loop.fluxW)} W/m² where ${Math.round(maxFlux(loop.surfaceLimitC, loop.roomTempC))} is the most a floor at that limit can. Drop the flow temperature, open the pitch out, or lay a covering with more resistance than ${loop.covering}.`,
    })
  }

  if (loop.length > maxLoopLength) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `${name} is a ${(loop.length / 1000).toFixed(0)} m loop against the ${maxLoopLength / 1000} m this pipe should run — leaders included, because they come off the same coil. Split the room into more loops, or lay it in bigger pipe.`,
    })
  }

  if (loop.pressureDropKpa > MAX_LOOP_PRESSURE_KPA) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `${name} costs ${loop.pressureDropKpa.toFixed(0)} kPa at ${loop.flowKgH.toFixed(0)} kg/h, over the ${MAX_LOOP_PRESSURE_KPA} kPa a manifold circulator can be relied on for. Shorten it, or widen the design drop so less water has to go round.`,
    })
  }

  if (loop.velocity > LOOP_VELOCITY.max) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `Water runs at ${loop.velocity.toFixed(2)} m/s in ${name}, over the ${LOOP_VELOCITY.max} m/s that stays quiet under a floor.`,
    })
  }
}

/** Loop names, in the order they are ported, for a message that lists several of them. */
const listLoops = (loops: HeatingLoop[]): string => {
  const names = loops.map((l) => (l.partOf > 0 ? `${l.roomName} ${l.partOf}` : l.roomName))
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function checkManifold(
  design: ManifoldDesign,
  mine: HeatingLoop[],
  warnings: RoutingWarning[],
  nextId: () => string,
): void {
  // Reported per manifold rather than per loop: on a house with a dozen small rooms this is
  // one observation about how the manifold will fill and vent, not a dozen separate faults.
  const sluggish = mine.filter((loop) => loop.velocity > 0 && loop.velocity < LOOP_VELOCITY.min)
  if (sluggish.length > 0) {
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'heating',
      message: `On ${design.name} the water crawls through ${listLoops(sluggish)} at under ${LOOP_VELOCITY.min} m/s. It will not carry air along with it at that speed, so those loops have to be vented by hand each time the system is filled — or given a tighter pitch so there is more of them for the same floor.`,
    })
  }

  if (design.loops > MAX_LOOPS_PER_MANIFOLD) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `${design.name} carries ${design.loops} loops. Manifolds are built up to ${MAX_LOOPS_PER_MANIFOLD} ports, and past that the last one is starved whatever the valves are set to — add a second manifold.`,
    })
  }

  const ratio = design.shortestLoop > 0 ? design.longestLoop / design.shortestLoop : 1
  if (ratio > MAX_LOOP_IMBALANCE) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'heating',
      message: `On ${design.name} the longest loop is ${(design.longestLoop / 1000).toFixed(0)} m and the shortest ${(design.shortestLoop / 1000).toFixed(0)} m. Water takes the easy way round, and a spread of more than ${MAX_LOOP_IMBALANCE}∶1 cannot be balanced back out at the valves — split the long one, or lengthen the short one by tightening its pitch.`,
    })
  }
}

/* ------------------------------------------------------------- what to order */

/**
 * The parts of a heated floor that are not pipe.
 *
 * The edge strip is not optional trim: EN 1264-4 §4.3 wants a compressible strip at every
 * wall for the screed to grow into, and a heated floor without one pushes the screed against
 * the walls until something cracks.
 */
function accessories(
  project: Project,
  loops: HeatingLoop[],
  segments: Segment[],
  pipeLabel: string,
): BomLine[] {
  const rooms = new Set(loops.map((loop) => loop.roomId))
  const strip = project.rooms
    .filter((room) => rooms.has(room.id))
    .reduce((sum, room) => sum + perimeter(room.outline), 0)

  const coil = segments
    .filter((s) => s.role === 'loop' || s.role === 'branch')
    .reduce((sum, s) => sum + s.length, 0)

  return [
    {
      system: 'heating',
      item: 'Edge insulation strip',
      unit: 'm',
      quantity: strip / 1000,
    },
    {
      system: 'heating',
      // Roughly one every half metre of run, which is what holds a coil down against a
      // screed pour without it floating.
      item: `Pipe clip for ${pipeLabel}`,
      unit: 'pc',
      quantity: Math.ceil(coil / 500),
    },
  ]
}
