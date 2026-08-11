/**
 * Electrical circuits.
 *
 * Two steps. First **grouping**: loads become circuits under the HD 60364 rules — dedicated
 * circuits for fixed appliances and the cooker, shared circuits for lighting and general
 * sockets, split when either the outlet count or the design load runs out. Then **routing**:
 * one tree per circuit from the consumer unit.
 *
 * Cables are the one system with a hard constraint on *where* they may run, not just how
 * far. A cable buried outside the DIN 18015-3 installation zones is a genuine hazard,
 * because nobody drilling into that wall later has any way to predict it is there. So the
 * horizontal search space is the wall centrelines at zone height, not open floor — plus the
 * ceiling plane, which lighting needs to reach a pendant in the middle of a room.
 */

import { fixtureDef } from '../catalog/fixtures.ts'
import { dist2, dist3, to3, type Vec2 } from '../geometry/vec.ts'
import {
  findRoom,
  fixtureFrame,
  fixturePorts,
  roomsOnLevel,
  servicePointsOf,
  sortedLevels,
  type ResolvedPort,
} from '../model.ts'
import {
  balancePhases,
  boardDemand,
  diversifiedCurrentFor,
  IMBALANCE_THRESHOLD,
  groupRcds,
  layOutPanel,
  recommendedMainBreaker,
} from '../electrical/panel.ts'
import {
  barWetZones,
  isBarredAccessory,
  verticalDropPoints,
  wetZoneAt,
  wetZones,
  type WetZone,
} from '../electrical/zones.ts'
import {
  BATHROOM_ZONE_2_EXTENT,
  breakerFor,
  BREAKING_CAPACITY,
  cableForRun,
  CIRCUIT_RULES,
  currentCapacity,
  currentFor,
  curveFor,
  groupingFactor,
  horizontalZone,
  inHorizontalZone,
  methodOf,
  needsEarthElectrode,
  peSize,
  PHASES,
  VOLT_DROP_LIMIT,
  voltDrop,
  voltDropPercent,
  zoneMidpoint,
} from '../standards/electrical.ts'
import type {
  Circuit,
  ElectricalCircuitKind,
  Fixture,
  FixtureType,
  Id,
  PanelDesign,
  Project,
  RoutingWarning,
  Segment,
  ServicePoint,
} from '../types.ts'
import { deriveFittings, mergeCollinear } from './fittings.ts'
import { RouteGraph } from './graph.ts'
import {
  attachTerminal,
  buildPlaneGrid,
  buildWallGraph,
  linkStoreys,
  planLines,
  type Layer,
  type LevelShapes,
} from './layers.ts'
import { buildTree, treeLinks, type Terminal } from './steiner.ts'
import type { SystemSolution } from './waste.ts'

/**
 * The height a storey's horizontal runs sit at.
 *
 * Straight out of the DIN 18015-3 bands rather than a constant of our own: the standard
 * permits a strip 150–450 mm above the finished floor and another 150–450 mm below the
 * ceiling, and the middle of whichever band the project has chosen is where a run chased into
 * the screed or the plaster actually goes. Taking it from `horizontalZones` means the zone
 * the router obeys and the zone the rules module documents cannot drift apart.
 */
const runHeightAboveFloor = (roomHeight: number, route: 'ceiling' | 'floor'): number =>
  zoneMidpoint(horizontalZone(roomHeight, route))

/** The ceiling plane used to reach light points. */
const CEILING_PLANE_DROP = 60
/** Slab crossings are dear, so circuits gather onto one riser. */
const SLAB_CROSSING_WEIGHT = 10

/**
 * How far two circuits must share a chase before they are treated as bunched.
 *
 * HD 60364-5-52's grouping factors describe a *run* of cables warming each other up. Every
 * circuit in the house leaves the board through the same few hundred millimetres of wall, and
 * derating the whole installation on that detail would be arithmetic rather than engineering;
 * a metre of shared chase is where the heat actually starts to matter.
 */
const BUNCHED_LENGTH = 1000

export interface ElectricalSolution extends SystemSolution {
  circuits: Circuit[]
  panels: PanelDesign[]
}

/* ------------------------------------------------------------------- grouping */

/**
 * Split the powered fixtures into circuits.
 *
 * Appliances and cookers get one circuit each. Lighting and sockets are grouped room by
 * room — an electrician does not scatter one circuit across the flat when they can avoid
 * it — and a new circuit is opened as soon as either limit would be exceeded.
 */
/**
 * The board a fixture belongs to: one on its own storey if there is one, otherwise the
 * nearest. A sub-board per floor is the usual arrangement precisely because it keeps the
 * final circuits short.
 */
export function panelForFixture(
  project: Project,
  panels: ServicePoint[],
  fixture: Fixture,
): ServicePoint | null {
  if (panels.length === 0) return null
  const room = findRoom(project, fixture.roomId)
  const frame = fixtureFrame(project, fixture)
  const at = frame ? { x: frame.origin.x, y: frame.origin.y } : fixture.position

  const onLevel = room ? panels.filter((p) => p.levelId === room.levelId) : []
  const pool = onLevel.length > 0 ? onLevel : panels
  return pool.reduce((best, panel) =>
    dist2(at, panel.position) < dist2(at, best.position) ? panel : best,
  )
}

export function groupCircuits(project: Project, nextId: () => string): Circuit[] {
  const electrical = project.settings.electrical
  const powered = project.fixtures.filter((f) => fixtureDef(f.type).loads.circuit !== undefined)
  const circuits: Circuit[] = []

  /** Everything a circuit needs before it has been routed or given a phase. */
  const boards = servicePointsOf(project, 'electricalPanel')
  const blank = (
    kind: ElectricalCircuitKind,
    name: string,
    poles: 1 | 3,
    panelId: string,
  ): Circuit => {
    const rule = CIRCUIT_RULES[kind]
    const method = methodOf(electrical)
    return {
      id: nextId(),
      panelId,
      kind,
      name,
      fixtureIds: [],
      breakerAmps: rule.breakerAmps,
      curve: curveFor(kind),
      icn: BREAKING_CAPACITY,
      cableMm2: rule.cableMm2,
      peMm2: peSize(rule.cableMm2),
      totalWatts: 0,
      rcdProtected: rule.rcdProtected,
      poles,
      phases: [],
      // Three live cores, a neutral and an earth for a 400 V circuit; one live, neutral and
      // earth for a 230 V one.
      cores: poles === 3 ? 5 : 3,
      designCurrent: 0,
      assessedCurrent: 0,
      diversifiedCurrent: 0,
      routeLength: 0,
      voltDropPercent: 0,
      circuitDropPercent: 0,
      installationMethod: method,
      groupedWith: 1,
      groupingFactor: 1,
      currentCapacity: currentCapacity(rule.cableMm2, method),
      rcdGroup: 0,
    }
  }

  const dedicated = powered.filter((f) => {
    const kind = fixtureDef(f.type).loads.circuit
    return kind === 'appliance' || kind === 'cooker'
  })
  for (const fixture of dedicated) {
    const def = fixtureDef(fixture.type)
    const kind = def.loads.circuit as ElectricalCircuitKind
    // A fixed appliance may be taken across all three lines, which is the whole reason for
    // having them: a 7 kW cooker draws 30 A on one phase and 10 A on three.
    const poles: 1 | 3 =
      electrical.supply === 'three-phase' && fixture.threePhase === true ? 3 : 1
    const circuit = blank(
      kind,
      fixture.name,
      poles,
      panelForFixture(project, boards, fixture)?.id ?? '',
    )
    circuit.fixtureIds = [fixture.id]
    circuit.totalWatts = def.loads.watts ?? 0
    circuits.push(circuit)
  }

  for (const kind of ['lighting', 'sockets'] as const) {
    const rule = CIRCUIT_RULES[kind]
    const members = powered.filter((f) => fixtureDef(f.type).loads.circuit === kind)
    const byRoom = new Map<string, Fixture[]>()
    for (const fixture of members) {
      const list = byRoom.get(fixture.roomId)
      if (list) list.push(fixture)
      else byRoom.set(fixture.roomId, [fixture])
    }

    let current: Circuit | null = null
    let currentPanel: string | null = null
    let index = 0
    for (const [roomId, group] of byRoom) {
      const roomName = findRoom(project, roomId)?.name ?? 'Room'
      for (const fixture of group) {
        const watts = fixtureDef(fixture.type).loads.watts ?? 0
        const panelId = panelForFixture(project, boards, fixture)?.id ?? ''
        const wouldOverflow =
          current !== null &&
          (current.fixtureIds.length + 1 > rule.maxOutlets ||
            current.totalWatts + watts > rule.maxWatts)
        // A circuit never spans two boards. With a board per storey that also stops one
        // running up through the building, which is the point of having them.
        if (current === null || wouldOverflow || panelId !== currentPanel) {
          index += 1
          // Lighting and sockets are always 230 V off one line; only a fixed appliance is
          // worth taking across three.
          current = blank(kind, `${rule.label} ${index} — ${roomName}`, 1, panelId)
          currentPanel = panelId
          circuits.push(current)
        }
        current.fixtureIds.push(fixture.id)
        current.totalWatts += watts
      }
    }
  }

  return circuits
}

/**
 * Appliances with a variable-speed drive in them.
 *
 * An inverter-driven motor leaks a residual current that is neither a clean sine nor a simple
 * pulsating d.c., and a Type A device can fail to see it. IEC 62423 calls that composite
 * waveform Type F's job, so a residual current device with one of these behind it is
 * specified as Type F rather than the Type A that is the floor everywhere else.
 */
const VARIABLE_SPEED_LOADS: ReadonlySet<FixtureType> = new Set<FixtureType>([
  'washing-machine',
  'dishwasher',
  'tumble-dryer',
])

/** Circuits with such a load on them, by id. */
export function electronicLoadCircuits(project: Project, circuits: Circuit[]): ReadonlySet<Id> {
  const byId = new Map(project.fixtures.map((fixture) => [fixture.id, fixture]))
  const ids = new Set<Id>()
  for (const circuit of circuits) {
    const variable = circuit.fixtureIds.some((id) => {
      const fixture = byId.get(id)
      return fixture !== undefined && VARIABLE_SPEED_LOADS.has(fixture.type)
    })
    if (variable) ids.add(circuit.id)
  }
  return ids
}

/* -------------------------------------------------------------------- routing */

export function routeElectrical(
  project: Project,
  shapes: LevelShapes,
  nextId: () => string,
): ElectricalSolution {
  const warnings: RoutingWarning[] = []
  const circuits = groupCircuits(project, nextId)

  const empty = (): ElectricalSolution => ({
    network: { system: 'power', segments: [], fittings: [], totalLength: 0, unreachedFixtureIds: [] },
    circuits,
    panels: [],
    warnings,
    graphNodes: 0,
    graphEdges: 0,
  })

  if (circuits.length === 0) return empty()

  const boards = servicePointsOf(project, 'electricalPanel')
  if (boards.length === 0) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'power',
      message: 'No consumer unit placed. Drop one on the plan to route circuits from it.',
    })
    return empty()
  }

  // The supply lands on the lowest board; the rest are sub-boards fed from it.
  const levelIndex = new Map(sortedLevels(project).map((l, i) => [l.id, i]))
  const ordered = [...boards].sort(
    (l, r) => (levelIndex.get(l.levelId) ?? 0) - (levelIndex.get(r.levelId) ?? 0),
  )
  const mainBoard = ordered[0]

  const powerPorts = new Map<string, ResolvedPort>()
  for (const fixture of project.fixtures) {
    for (const port of fixturePorts(project, fixture)) {
      if (port.kind === 'power') powerPorts.set(fixture.id, port)
    }
  }

  const levels = sortedLevels(project)

  /** Where a run may turn vertical, per storey — beside a corner or a door reveal. */
  const dropsOf = new Map<string, Vec2[]>()
  for (const level of levels) {
    dropsOf.set(level.id, verticalDropPoints(project, roomsOnLevel(project, level.id)))
  }

  const attachAt: Vec2[] = [
    ...[...powerPorts.values()].map((p) => ({ x: p.position.x, y: p.position.y })),
    ...boards.map((b) => b.position),
  ]

  const graph = new RouteGraph()
  const lines = planLines(project, attachAt)

  // Per storey: a wall-zone network for the horizontal runs, and a ceiling plane so lighting
  // circuits can reach a pendant in the middle of a room. Which of the two permitted bands the
  // horizontal runs use decides whether lighting reaches that pendant across the ceiling or
  // has to climb the wall to get there.
  const route = project.settings.electrical.cableRoute

  /** Bathroom zone 1 per storey, so a message can name the fixture that created it. */
  const zonesOf = new Map<string, WetZone[]>()

  const wallOf = new Map<string, Layer>()
  const ceilingOf = new Map<string, Layer>()
  for (const level of levels) {
    const rooms = roomsOnLevel(project, level.id)
    const levelShape = shapes.byLevelId.get(level.id)
    if (rooms.length === 0 || !levelShape) continue

    const drops = dropsOf.get(level.id) ?? []
    // One height for the storey: the lowest room's band, so the run stays inside every room's
    // permitted zone rather than only the tallest one's.
    const heightAboveFloor = Math.min(
      ...rooms.map((r) => runHeightAboveFloor(r.height, route)),
    )
    // One height for the storey means a room with a markedly different ceiling gets a run
    // outside its own permitted band — legal nowhere, and invisible once it is plastered over.
    for (const room of rooms) {
      if (inHorizontalZone(heightAboveFloor, room.height)) continue
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'power',
        message: `Horizontal cable runs on ${level.name} sit ${Math.round(heightAboveFloor)} mm above the floor, which is outside the DIN 18015-3 installation zones for ${room.name} at ${room.height} mm. Level the ceilings or route that room separately.`,
      })
    }
    const built = buildWallGraph(graph, project, {
      heightAboveFloor,
      step: 400,
      attachAt: [...attachAt, ...drops],
      rooms,
    })

    /**
     * Zones 0 and 1 come straight out of the wall network. A fixed appliance inside one — a
     * shower pump, an instantaneous heater — keeps the few nodes its own supply needs.
     */
    const zones = wetZones(project, rooms)
    zonesOf.set(level.id, zones)
    const fixedSupplies = [...powerPorts.entries()]
      .filter(([fixtureId]) => {
        const fixture = project.fixtures.find((f) => f.id === fixtureId)
        return fixture !== undefined && !isBarredAccessory(fixture)
      })
      .map(([, port]) => ({ x: port.position.x, y: port.position.y }))
    const wallLayer = barWetZones(graph, built, zones, fixedSupplies)

    // Light points hang from the slab wherever the horizontal runs are, so the ceiling plane
    // stays put; floor routing simply means a longer climb to reach it.
    const ceilingLayer = buildPlaneGrid(graph, project, levelShape, {
      z: level.elevation + Math.min(...rooms.map((r) => r.height)) - CEILING_PLANE_DROP,
      lines,
      penetrationWeight: 4,
      allowLoadBearingPenetration: true,
    })
    /**
     * A cable leaves the wall zone for the ceiling **only in a vertical installation zone**.
     *
     * This is the run DIN 18015-3 is really about. A drop straight to an accessory is
     * predictable because the accessory is there to see; a run climbing an otherwise blank
     * wall is findable only if it is beside a corner or a reveal, which is where the standard
     * puts it.
     *
     * The links are made one at a time rather than by matching the two layers wherever they
     * coincide, because the ceiling plane is a Hanan lattice: drawing a grid line through
     * every permitted drop would multiply the whole plane by them and cost thousands of nodes
     * to gain a few dozen crossings. `attachTerminal` instead hooks a single point into the
     * lattice with a short axis-aligned spur, which is the same thing a fixture does.
     */
    for (const drop of drops) {
      const wallNode = wallLayer.at(graph, drop) ?? wallLayer.nearest(graph, drop)
      if (wallNode === null) continue
      const wallPos = graph.position(wallNode)
      // The wall network is sampled, so `nearest` can answer with a node some way off; a drop
      // that is not actually at the corner it was set out from is not the zone.
      if (Math.abs(wallPos.x - drop.x) > 5 || Math.abs(wallPos.y - drop.y) > 5) continue
      const ceilingNode = attachTerminal(graph, ceilingLayer, {
        x: drop.x,
        y: drop.y,
        z: ceilingLayer.z,
      })
      if (ceilingNode !== null) graph.connect(wallNode, ceilingNode, 1)
    }

    wallOf.set(level.id, wallLayer)
    ceilingOf.set(level.id, ceilingLayer)
  }

  // Risers between storeys, inside walls that exist on both — same rule as the soil stack.
  const slabEdges = new Set<number>()
  for (let i = 1; i < levels.length; i++) {
    const below = levels[i - 1]
    const above = levels[i]
    const lower = wallOf.get(below.id)
    const upper = wallOf.get(above.id)
    const lowerShape = shapes.byLevelId.get(below.id)
    const upperShape = shapes.byLevelId.get(above.id)
    if (!lower || !upper || !lowerShape || !upperShape) continue

    const created = linkStoreys(
      graph,
      { layer: lower, shape: lowerShape },
      { layer: upper, shape: upperShape },
      SLAB_CROSSING_WEIGHT,
    )
    for (const id of created) slabEdges.add(id)
    if (created.length === 0) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'power',
        message: `No cable riser is possible between ${below.name} and ${above.name}: a riser may only pass through a wall that exists on both storeys, and none line up.`,
      })
    }
  }

  const levelIdFor = (z: number): string => {
    let best = levels[0]?.id ?? ''
    for (const level of levels) {
      if (z >= level.elevation - 1) best = level.id
    }
    return best
  }

  /** Each board, attached to the wall network on its own storey. */
  const boardNode = new Map<string, number>()
  for (const board of boards) {
    const wall = wallOf.get(board.levelId) ?? wallOf.get(levelIdFor(board.z))
    const node = wall ? attachTerminal(graph, wall, to3(board.position, board.z)) : null
    if (node === null) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'power',
        message: `${board.name} is not near any wall.`,
        position: to3(board.position, board.z),
      })
      continue
    }
    boardNode.set(board.id, node)
  }
  if (boardNode.size === 0) return empty()

  const segments: Segment[] = []
  const unreached: string[] = []

  /**
   * Which circuits share each graph edge, and how long that edge is.
   *
   * Every circuit is routed as its own tree over one shared graph, so two circuits taking the
   * same length of chase come out on the same edges. Recording it here — while the route is
   * still edges rather than merged segments — is what makes the grouping factor countable at
   * all: after `mergeCollinear` a shared run is two independent segments that merely happen to
   * be collinear.
   */
  const edgeCircuits = new Map<number, Set<string>>()
  const edgeLength = new Map<number, number>()

  /** What a routed tree cost, and how far the furthest terminal ended up from the root. */
  interface RunResult {
    /** Every metre of cable the tree used. */
    total: number
    /** Distance to the furthest terminal, following the tree — the point of utilisation. */
    longest: number
  }

  /** Run a tree from one node to a set of terminals, emitting segments. */
  const runTree = (
    from: number,
    terminals: Terminal[],
    circuitId: string,
    size: number,
    onMissed: (ref: string, node: number) => void,
  ): RunResult => {
    const tree = buildTree(graph, from, terminals, { turnPenalty: 200, reuseDiscount: 0.3 })
    for (const missed of tree.unreached) onMissed(missed.ref, missed.node)

    const storeyRise = (levels[0]?.height ?? 2600) * 0.6
    let total = 0
    for (const { child, parent } of treeLinks(tree)) {
      const a = graph.position(child)
      const b = graph.position(parent)
      const edgeId = tree.edgeToParent[child]
      const isRiser = slabEdges.has(edgeId)
      const flat = Math.hypot(a.x - b.x, a.y - b.y)
      const run = dist3(a, b)
      total += run

      const sharing = edgeCircuits.get(edgeId)
      if (sharing) sharing.add(circuitId)
      else edgeCircuits.set(edgeId, new Set([circuitId]))
      edgeLength.set(edgeId, run)

      segments.push({
        id: nextId(),
        system: 'power',
        a: { ...a },
        b: { ...b },
        size,
        load: tree.loadToParent[child],
        length: run,
        role: isRiser ? 'stack' : flat < 1 && Math.abs(a.z - b.z) > storeyRise ? 'stack' : flat < 1 ? 'drop' : 'branch',
        circuitId,
      })
    }

    // The volt drop limit is a limit at the point of utilisation, so what matters is the
    // longest single path from the board — not the sum of every branch off it. A lighting
    // circuit feeding six pendants installs far more cable than any one lamp is fed through.
    const longest = tree.connected.reduce(
      (worst, terminal) => Math.max(worst, tree.distToRoot[terminal.node]),
      0,
    )
    return { total, longest }
  }

  /**
   * Circuits bunched with this one over a length of chase worth derating for.
   *
   * The count is taken at the worst point of the route: for each number of neighbours, how
   * much of this circuit's run is shared by at least that many circuits, and the answer is the
   * largest count that persists for more than a metre.
   */
  const bunchedCount = (circuitId: string): number => {
    const shared: number[] = []
    for (const [edgeId, circuitsOnEdge] of edgeCircuits) {
      if (!circuitsOnEdge.has(circuitId)) continue
      const count = circuitsOnEdge.size
      const length = edgeLength.get(edgeId) ?? 0
      shared[count] = (shared[count] ?? 0) + length
    }
    let running = 0
    for (let count = shared.length - 1; count > 1; count--) {
      running += shared[count] ?? 0
      if (running >= BUNCHED_LENGTH) return count
    }
    return 1
  }

  /**
   * Submains: every sub-board is fed from the main one.
   *
   * Without this the sub-boards would appear on the drawing with nothing supplying them,
   * which is exactly the cable most likely to be forgotten and the most expensive to add
   * afterwards.
   */
  const submainLength = new Map<string, number>()
  const mainNode = boardNode.get(mainBoard.id)
  for (const board of boards) {
    if (board.id === mainBoard.id || mainNode === undefined) continue
    const target = boardNode.get(board.id)
    if (target === undefined) continue
    const run = runTree(
      mainNode,
      [{ ref: board.id, node: target, load: 0, minSize: 6 }],
      `submain:${board.id}`,
      6,
      () => {
        warnings.push({
          id: nextId(),
          severity: 'error',
          system: 'power',
          message: `No cable route from ${mainBoard.name} to ${board.name}.`,
        })
      },
    )
    submainLength.set(board.id, run.longest)
  }

  for (const circuit of circuits) {
    const terminals: Terminal[] = []
    const byNode = new Map<number, ResolvedPort>()

    for (const fixtureId of circuit.fixtureIds) {
      const port = powerPorts.get(fixtureId)
      if (!port) continue
      const fixture = project.fixtures.find((f) => f.id === fixtureId)
      const isLight = fixture ? fixtureDef(fixture.type).mount === 'ceiling' : false
      const room = fixture ? findRoom(project, fixture.roomId) : null
      const levelId = room?.levelId ?? levelIdFor(port.position.z)
      const layer = isLight ? ceilingOf.get(levelId) : wallOf.get(levelId)

      /**
       * A socket outlet has no business in zones 0, 1 or 2 (HD 60364-7-701.512.3) — the only
       * exception is a shaver supply unit to EN 61558-2-5, which is a different accessory.
       *
       * A standards breach rather than a routing failure, so it is a warning and the circuit
       * is still drawn: the route exists, and refusing to draw it would hide the outlet that
       * has to be moved.
       */
      const zone = fixture && isBarredAccessory(fixture)
        ? wetZoneAt(zonesOf.get(levelId) ?? [], port.position, BATHROOM_ZONE_2_EXTENT)
        : null
      if (zone) {
        warnings.push({
          id: nextId(),
          severity: 'warning',
          system: 'power',
          message: `${port.fixtureName} sits inside the protective zone around ${zone.fixtureName}. HD 60364-7-701 allows no socket outlet in zones 0 to 2 — move it clear.`,
          position: port.position,
          fixtureId,
        })
      }

      const node = layer ? attachTerminal(graph, layer, port.position) : null
      if (node === null) {
        unreached.push(fixtureId)
        warnings.push({
          id: nextId(),
          severity: 'error',
          system: 'power',
          message: `${port.fixtureName} could not be reached from any permitted cable zone.`,
          position: port.position,
          fixtureId,
        })
        continue
      }
      terminals.push({
        ref: fixtureId,
        node,
        load: currentFor(fixtureDef(fixture?.type ?? 'socket').loads.watts ?? 0),
        minSize: circuit.cableMm2,
      })
      byNode.set(node, port)
    }

    if (terminals.length === 0) continue
    const from = boardNode.get(circuit.panelId) ?? mainNode
    if (from === undefined) continue

    // Each circuit is its own tree — cables are not shared between circuits, so the reuse
    // discount must not tempt two circuits onto one run.
    const run = runTree(from, terminals, circuit.id, circuit.cableMm2, (ref, node) => {
      unreached.push(ref)
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'power',
        message: `No cable route from ${circuit.name} back to its board via ${byNode.get(node)?.fixtureName ?? 'a fixture'}.`,
        fixtureId: ref,
      })
    })
    circuit.routeLength = run.longest

    const design = currentFor(circuit.totalWatts)
    if (design > circuit.breakerAmps) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'power',
        message: `${circuit.name} draws ${design.toFixed(1)} A against a ${circuit.breakerAmps} A breaker. Split the circuit or uprate it.`,
      })
    }
  }

  const merged = mergeCollinear(segments)
  const fittings = deriveFittings(merged, 'power', nextId)

  // Now the runs exist, the circuits can be finished: what the length does to the volt drop,
  // what the neighbours in the chase do to the conductor, which line it hangs off and where it
  // sits on the board.
  const panels = commission(
    project,
    boards,
    mainBoard,
    submainLength,
    circuits,
    merged,
    bunchedCount,
    electronicLoadCircuits(project, circuits),
    warnings,
    nextId,
  )

  return {
    network: {
      system: 'power',
      segments: merged,
      fittings,
      totalLength: merged.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: unreached,
    },
    circuits,
    panels,
    warnings,
    graphNodes: graph.nodeCount,
    graphEdges: graph.edgeCount,
  }
}

/**
 * Turn routed circuits into a board.
 *
 * Cable size is settled here rather than at grouping time because it depends on the run: a
 * 2.5 mm² circuit protected at 16 A is perfectly safe and still unusable at forty metres,
 * because the far end sags below what the appliance will start on. Only once the route is
 * known can the conductor be chosen to satisfy both the breaker and the drop.
 */
function commission(
  project: Project,
  boards: ServicePoint[],
  mainBoard: ServicePoint,
  submainLength: Map<string, number>,
  circuits: Circuit[],
  segments: Segment[],
  bunchedCount: (circuitId: string) => number,
  electronicLoads: ReadonlySet<Id>,
  warnings: RoutingWarning[],
  nextId: () => string,
): PanelDesign[] {
  const electrical = project.settings.electrical
  const { voltage, lineVoltage } = electrical
  const method = methodOf(electrical)
  const supplyPoles: 1 | 3 = electrical.supply === 'three-phase' ? 3 : 1

  // First pass: what each circuit draws and what protects it. None of this depends on the
  // route, and the submains cannot be sized until it is known.
  for (const circuit of circuits) {
    circuit.designCurrent = currentFor(circuit.totalWatts, circuit.poles, voltage, lineVoltage)
    /**
     * The rule's breaker is a floor for a 230 V circuit — a socket circuit is 16 A whether
     * anything is plugged into it or not — but it is meaningless once the load is spread over
     * three lines. A 7 kW hob draws 30 A on one phase and 10 A on three, and giving the
     * three-phase version the single-phase rule's 32 A would put a breaker on it that the
     * circuit can never trip, on a cable three times the size it needs. European practice for
     * that hob is C16 on 5 × 2.5 mm².
     */
    circuit.breakerAmps =
      circuit.poles === 1
        ? Math.max(CIRCUIT_RULES[circuit.kind].breakerAmps, breakerFor(circuit.designCurrent))
        : breakerFor(circuit.designCurrent)
    circuit.curve = curveFor(circuit.kind)
    circuit.icn = BREAKING_CAPACITY
    circuit.diversifiedCurrent = diversifiedCurrentFor(circuit)
  }

  // Phases are balanced across the whole installation, not per board: the lines are the same
  // three wherever they are tapped, and balancing one board at a time would leave the sum of
  // them lopsided. It happens before the boards are totalled because a board's demand is a
  // per-line figure.
  balancePhases(circuits, electrical.supply)

  /**
   * The submains, and what they cost in volt drop.
   *
   * They are sized against a **1% allowance** rather than the whole 5%: the limit is measured
   * from the origin of the installation, so every metre the submain spends is a metre the
   * final circuits behind it no longer have. One percent for the distribution and four for
   * the finals is the conventional split.
   */
  const SUBMAIN_ALLOWANCE = 0.01
  const submainMm2 = new Map<string, number>()
  const submainDrop = new Map<string, number>()
  for (const board of boards) {
    if (board.id === mainBoard.id) continue
    const mine = circuits.filter((c) => c.panelId === board.id)
    const demand = boardDemand(mine, electrical.supply)
    const length = submainLength.get(board.id) ?? 0
    const size = cableForRun(
      breakerFor(demand),
      demand,
      length,
      supplyPoles,
      SUBMAIN_ALLOWANCE,
      voltage,
      lineVoltage,
      method,
      1,
      6,
    )
    submainMm2.set(board.id, size)
    submainDrop.set(
      board.id,
      voltDropPercent(voltDrop(demand, length, size, supplyPoles), supplyPoles, voltage, lineVoltage),
    )
  }

  // Second pass: the conductor. It depends on the run, on what shares the chase with it, and
  // on how much of the permitted drop the supply to its board has already spent.
  for (const circuit of circuits) {
    const limit = circuit.kind === 'lighting' ? VOLT_DROP_LIMIT.lighting : VOLT_DROP_LIMIT.other
    const upstream = submainDrop.get(circuit.panelId) ?? 0
    // A socket circuit is assessed at its breaker rating: nobody knows what will be plugged
    // into it, so the honest design condition is a full circuit. A fixed appliance is
    // assessed at what it actually draws.
    circuit.assessedCurrent =
      circuit.kind === 'sockets' ? circuit.breakerAmps : circuit.designCurrent

    circuit.installationMethod = method
    circuit.groupedWith = bunchedCount(circuit.id)
    circuit.groupingFactor = groupingFactor(circuit.groupedWith)

    const conventional = CIRCUIT_RULES[circuit.kind].cableMm2
    circuit.cableMm2 = cableForRun(
      circuit.breakerAmps,
      circuit.assessedCurrent,
      circuit.routeLength,
      circuit.poles,
      limit,
      voltage,
      lineVoltage,
      method,
      circuit.groupedWith,
      // The catalogue minimum is a single-phase convention — 2.5 mm² on a socket circuit
      // whatever the sums say. It has nothing to say about a load taken across three lines.
      circuit.poles === 1 ? conventional : 0,
      upstream,
    )
    circuit.peMm2 = peSize(circuit.cableMm2)
    circuit.currentCapacity = currentCapacity(circuit.cableMm2, method, circuit.groupedWith)

    /**
     * HD 60364-4-43's first coordination condition, Iz ≥ In. It can only fail here when even
     * the largest conductor on the table cannot carry the breaker where the cable is
     * installed — everything below that has already been uprated by `cableForRun`.
     */
    if (circuit.currentCapacity < circuit.breakerAmps - 1e-9) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'power',
        message: `${circuit.name} is on ${circuit.cableMm2} mm² carrying ${circuit.currentCapacity.toFixed(1)} A behind a ${circuit.breakerAmps} A breaker — bunched with ${circuit.groupedWith - 1} other circuits, method ${method} derates it below its protection. Split the chase or drop the breaker.`,
      })
    } else if (circuit.cableMm2 > conventional && circuit.groupedWith > 1) {
      warnings.push({
        id: nextId(),
        severity: 'info',
        system: 'power',
        message: `${circuit.name} runs with ${circuit.groupedWith - 1} other circuits in the same chase, so ${conventional} mm² would carry only ${currentCapacity(conventional, method, circuit.groupedWith).toFixed(1)} A. Uprated to ${circuit.cableMm2} mm².`,
      })
    }

    circuit.circuitDropPercent = voltDropPercent(
      voltDrop(circuit.assessedCurrent, circuit.routeLength, circuit.cableMm2, circuit.poles),
      circuit.poles,
      voltage,
      lineVoltage,
    )
    // The limit is measured from the origin of the installation, so a circuit on a sub-board
    // carries its submain's drop as well as its own. Assessed on the final circuit alone, a
    // circuit that is really at 8% reports a comfortable 4.8%.
    circuit.voltDropPercent = circuit.circuitDropPercent + upstream

    if (circuit.voltDropPercent > limit * 100 + 1e-9) {
      const via = upstream > 0 ? ` (including ${upstream.toFixed(1)}% along its submain)` : ''
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'power',
        message: `${circuit.name} drops ${circuit.voltDropPercent.toFixed(1)}%${via} over ${(circuit.routeLength / 1000).toFixed(1)} m, past the ${(limit * 100).toFixed(0)}% limit even at ${circuit.cableMm2} mm². Shorten the run or split the circuit.`,
      })
    }
  }

  // Update the cable actually drawn, so the plan, the 3D view and the schedule agree.
  const sizeOf = new Map(circuits.map((circuit) => [circuit.id, circuit.cableMm2]))
  for (const segment of segments) {
    const size = segment.circuitId ? sizeOf.get(segment.circuitId) : undefined
    if (size !== undefined) segment.size = size
  }

  const designs: PanelDesign[] = []
  for (const board of boards) {
    const mine = circuits.filter((c) => c.panelId === board.id)
    if (mine.length === 0) continue

    const isMain = board.id === mainBoard.id
    const rcdGroups = groupRcds(mine, electrical.circuitsPerRcd, electrical.supply, electronicLoads)
    const design = layOutPanel(mine, rcdGroups, electrical, isMain)
    const length = submainLength.get(board.id) ?? 0

    designs.push({
      ...design,
      id: board.id,
      name: board.name,
      levelId: board.levelId,
      isMain,
      submainLength: length,
      // A submain is sized on the board it feeds, and on the run to reach it.
      submainMm2: isMain ? null : (submainMm2.get(board.id) ?? null),
    })

    if (design.modulesUsed > design.enclosureModules) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'power',
        message: `${board.name} needs ${design.modulesUsed} modules and the largest standard enclosure holds ${design.enclosureModules}.`,
      })
    }
  }

  // The incomer carries everything, wherever it is finally switched.
  const totalDemand = designs.reduce((sum, d) => sum + d.maximumDemand, 0)
  if (totalDemand > electrical.mainBreakerAmps) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'power',
      message: `Maximum demand is ${totalDemand.toFixed(1)} A per line against a ${electrical.mainBreakerAmps} A incomer. Uprate the supply to at least ${recommendedMainBreaker(totalDemand)} A, or move load off.`,
    })
  }

  const wholeInstallation: Record<string, number> = { L1: 0, L2: 0, L3: 0 }
  for (const design of designs) {
    for (const phase of PHASES) wholeInstallation[phase] += design.phaseLoad[phase]
  }
  const loads = PHASES.map((p) => wholeInstallation[p])
  const spread = Math.max(...loads) - Math.min(...loads)
  if (electrical.supply === 'three-phase' && spread > IMBALANCE_THRESHOLD) {
    const worst = PHASES.reduce((l, r) => (wholeInstallation[l] > wholeInstallation[r] ? l : r))
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'power',
      message: `The lines are ${spread.toFixed(1)} A apart, with ${worst} carrying ${wholeInstallation[worst].toFixed(1)} A. An unbalanced supply puts current in the neutral and pulls the line voltages apart — split a large single-phase load, or take it across all three.`,
    })
  }

  /**
   * What the earthing arrangement obliges the installation to have.
   *
   * These are not defects in the drawing — the solver cannot see whether an electrode has
   * been driven or the water main has been bonded — but they are the two things about a
   * Romanian house that are most often left out, and neither is visible anywhere else.
   */
  const origin = designs.find((design) => design.isMain)
  if (origin) {
    const earthing = origin.earthing
    warnings.push({
      id: nextId(),
      severity: 'info',
      system: 'power',
      message: needsEarthElectrode(earthing)
        ? `${origin.name} is a TT installation: it needs its own earth electrode, and the 30 mA residual current devices are the only protection against an insulation fault — the loop impedance through two electrodes will never trip a breaker. Main protective bonding to the main earthing terminal at ${origin.mainBondingMm2} mm².`
        : `${origin.name} is ${earthing}: the incoming water and gas services and any structural steel must be bonded to the main earthing terminal at ${origin.mainBondingMm2} mm². On TN-C-S a missing bond puts the supply neutral's voltage on every pipe in the house if the PEN conductor breaks.`,
    })

    if (origin.spd === null) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'power',
        message: `No surge protective device at ${origin.name}. HD 60364-4-44 §443 requires one unless a documented risk assessment says otherwise; a detached house on an overhead or mixed supply takes a Type 2 arrester at the origin.`,
      })
    }
  }

  return designs
}
