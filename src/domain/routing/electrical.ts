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
import { dist3, to3, type Vec2 } from '../geometry/vec.ts'
import {
  findRoom,
  fixturePorts,
  roomsOnLevel,
  servicePointOf,
  sortedLevels,
  type ResolvedPort,
} from '../model.ts'
import {
  balancePhases,
  diversifiedCurrentFor,
  IMBALANCE_THRESHOLD,
  groupRcds,
  layOutPanel,
  recommendedMainBreaker,
} from '../electrical/panel.ts'
import {
  breakerFor,
  cableForRun,
  CIRCUIT_RULES,
  currentFor,
  PHASES,
  VOLT_DROP_LIMIT,
  voltDrop,
  voltDropPercent,
} from '../standards/electrical.ts'
import type {
  Circuit,
  ElectricalCircuitKind,
  Fixture,
  PanelDesign,
  Project,
  RoutingWarning,
  Segment,
} from '../types.ts'
import { deriveFittings, mergeCollinear } from './fittings.ts'
import { RouteGraph } from './graph.ts'
import {
  attachTerminal,
  buildPlaneGrid,
  buildWallGraph,
  linkLayersVertically,
  linkStoreys,
  planLines,
  type Layer,
  type LevelShapes,
} from './layers.ts'
import { buildTree, treeLinks, type Terminal } from './steiner.ts'
import type { SystemSolution } from './waste.ts'

/** Horizontal cable runs sit in the upper installation zone, below the ceiling. */
const UPPER_ZONE_BELOW_CEILING = 300
/** The ceiling plane used to reach light points. */
const CEILING_PLANE_DROP = 60
/** Slab crossings are dear, so circuits gather onto one riser. */
const SLAB_CROSSING_WEIGHT = 10

export interface ElectricalSolution extends SystemSolution {
  circuits: Circuit[]
  panel: PanelDesign | null
}

/* ------------------------------------------------------------------- grouping */

/**
 * Split the powered fixtures into circuits.
 *
 * Appliances and cookers get one circuit each. Lighting and sockets are grouped room by
 * room — an electrician does not scatter one circuit across the flat when they can avoid
 * it — and a new circuit is opened as soon as either limit would be exceeded.
 */
export function groupCircuits(project: Project, nextId: () => string): Circuit[] {
  const electrical = project.settings.electrical
  const powered = project.fixtures.filter((f) => fixtureDef(f.type).loads.circuit !== undefined)
  const circuits: Circuit[] = []

  /** Everything a circuit needs before it has been routed or given a phase. */
  const blank = (kind: ElectricalCircuitKind, name: string, poles: 1 | 3): Circuit => {
    const rule = CIRCUIT_RULES[kind]
    return {
      id: nextId(),
      kind,
      name,
      fixtureIds: [],
      breakerAmps: rule.breakerAmps,
      cableMm2: rule.cableMm2,
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
    const circuit = blank(kind, fixture.name, poles)
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
    let index = 0
    for (const [roomId, group] of byRoom) {
      const roomName = findRoom(project, roomId)?.name ?? 'Room'
      for (const fixture of group) {
        const watts = fixtureDef(fixture.type).loads.watts ?? 0
        const wouldOverflow =
          current !== null &&
          (current.fixtureIds.length + 1 > rule.maxOutlets ||
            current.totalWatts + watts > rule.maxWatts)
        if (current === null || wouldOverflow) {
          index += 1
          // Lighting and sockets are always 230 V off one line; only a fixed appliance is
          // worth taking across three.
          current = blank(kind, `${rule.label} ${index} — ${roomName}`, 1)
          circuits.push(current)
        }
        current.fixtureIds.push(fixture.id)
        current.totalWatts += watts
      }
    }
  }

  return circuits
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
    panel: null,
    warnings,
    graphNodes: 0,
    graphEdges: 0,
  })

  if (circuits.length === 0) return empty()

  const consumerUnit = servicePointOf(project, 'electricalPanel')
  if (!consumerUnit) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'power',
      message: 'No consumer unit placed. Drop one on the plan to route circuits from it.',
    })
    return empty()
  }

  const powerPorts = new Map<string, ResolvedPort>()
  for (const fixture of project.fixtures) {
    for (const port of fixturePorts(project, fixture)) {
      if (port.kind === 'power') powerPorts.set(fixture.id, port)
    }
  }

  const attachAt: Vec2[] = [
    ...[...powerPorts.values()].map((p) => ({ x: p.position.x, y: p.position.y })),
    consumerUnit.position,
  ]

  const levels = sortedLevels(project)
  const graph = new RouteGraph()
  const lines = planLines(project, attachAt)

  // Per storey: a wall-zone network for the horizontal runs, and a ceiling plane so lighting
  // circuits can reach a pendant in the middle of a room.
  const wallOf = new Map<string, Layer>()
  const ceilingOf = new Map<string, Layer>()
  for (const level of levels) {
    const rooms = roomsOnLevel(project, level.id)
    const levelShape = shapes.byLevelId.get(level.id)
    if (rooms.length === 0 || !levelShape) continue

    const wallLayer = buildWallGraph(graph, project, {
      heightAboveFloor: Math.min(...rooms.map((r) => r.height - UPPER_ZONE_BELOW_CEILING)),
      step: 400,
      attachAt,
      rooms,
    })
    const ceilingLayer = buildPlaneGrid(graph, project, levelShape, {
      z: level.elevation + Math.min(...rooms.map((r) => r.height)) - CEILING_PLANE_DROP,
      lines,
      penetrationWeight: 4,
      allowLoadBearingPenetration: true,
    })
    // A cable leaves the wall zone for the ceiling only where the two coincide in plan.
    linkLayersVertically(graph, wallLayer, ceilingLayer, 1, 50)

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

  const consumerUnitWall = wallOf.get(consumerUnit.levelId) ?? wallOf.get(levelIdFor(consumerUnit.z))
  const consumerUnitNode = consumerUnitWall ? attachTerminal(graph, consumerUnitWall, to3(consumerUnit.position, consumerUnit.z)) : null
  if (consumerUnitNode === null) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'power',
      message: 'The consumer unit is not near any wall.',
      position: to3(consumerUnit.position, consumerUnit.z),
    })
    return empty()
  }

  const segments: Segment[] = []
  const unreached: string[] = []

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

    // Each circuit is its own tree — cables are not shared between circuits, so the reuse
    // discount must not tempt two circuits onto one run.
    const tree = buildTree(graph, consumerUnitNode, terminals, { turnPenalty: 200, reuseDiscount: 0.3 })

    for (const missed of tree.unreached) {
      unreached.push(missed.ref)
      warnings.push({
        id: nextId(),
        severity: 'error',
        system: 'power',
        message: `No cable route from the consumer unit to ${byNode.get(missed.node)?.fixtureName ?? 'a fixture'}.`,
        fixtureId: missed.ref,
      })
    }

    for (const { child, parent } of treeLinks(tree)) {
      const a = graph.position(child)
      const b = graph.position(parent)
      // Only a slab crossing is a riser; a long vertical inside one storey is the drop from
      // the wall zone down to a socket.
      const isRiser = slabEdges.has(tree.edgeToParent[child])
      const flat = Math.hypot(a.x - b.x, a.y - b.y)
      segments.push({
        id: nextId(),
        system: 'power',
        a: { ...a },
        b: { ...b },
        size: circuit.cableMm2,
        load: tree.loadToParent[child],
        length: dist3(a, b),
        role: isRiser ? 'stack' : flat < 1 ? 'drop' : 'branch',
        circuitId: circuit.id,
      })
    }

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

  // Now the runs exist, the circuits can be finished: how long each one is, what that does to
  // the volt drop, which line it hangs off and where it sits on the board.
  const panel = commission(project, circuits, merged, warnings, nextId)

  return {
    network: {
      system: 'power',
      segments: merged,
      fittings,
      totalLength: merged.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: unreached,
    },
    circuits,
    panel,
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
  circuits: Circuit[],
  segments: Segment[],
  warnings: RoutingWarning[],
  nextId: () => string,
): PanelDesign | null {
  const electrical = project.settings.electrical
  const { voltage, lineVoltage } = electrical

  const lengthByCircuit = new Map<string, number>()
  for (const segment of segments) {
    if (!segment.circuitId) continue
    lengthByCircuit.set(
      segment.circuitId,
      (lengthByCircuit.get(segment.circuitId) ?? 0) + segment.length,
    )
  }

  for (const circuit of circuits) {
    circuit.routeLength = lengthByCircuit.get(circuit.id) ?? 0
    circuit.designCurrent = currentFor(circuit.totalWatts, circuit.poles, voltage, lineVoltage)
    circuit.breakerAmps = Math.max(
      CIRCUIT_RULES[circuit.kind].breakerAmps,
      breakerFor(circuit.designCurrent),
    )
    circuit.diversifiedCurrent = diversifiedCurrentFor(circuit)

    const limit = circuit.kind === 'lighting' ? VOLT_DROP_LIMIT.lighting : VOLT_DROP_LIMIT.other
    // A socket circuit is assessed at its breaker rating: nobody knows what will be plugged
    // into it, so the honest design condition is a full circuit. A fixed appliance is
    // assessed at what it actually draws.
    circuit.assessedCurrent =
      circuit.kind === 'sockets' ? circuit.breakerAmps : circuit.designCurrent
    circuit.cableMm2 = cableForRun(
      circuit.breakerAmps,
      circuit.assessedCurrent,
      circuit.routeLength,
      circuit.poles,
      limit,
      voltage,
      lineVoltage,
    )
    circuit.voltDropPercent = voltDropPercent(
      voltDrop(circuit.assessedCurrent, circuit.routeLength, circuit.cableMm2, circuit.poles),
      circuit.poles,
      voltage,
      lineVoltage,
    )

    if (circuit.voltDropPercent > limit * 100 + 1e-9) {
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system: 'power',
        message: `${circuit.name} drops ${circuit.voltDropPercent.toFixed(1)}% over ${(circuit.routeLength / 1000).toFixed(1)} m, past the ${(limit * 100).toFixed(0)}% limit even at ${circuit.cableMm2} mm². Shorten the run or split the circuit.`,
      })
    }
  }

  // Update the cable actually drawn, so the plan, the 3D view and the schedule agree.
  const sizeOf = new Map(circuits.map((circuit) => [circuit.id, circuit.cableMm2]))
  for (const segment of segments) {
    const size = segment.circuitId ? sizeOf.get(segment.circuitId) : undefined
    if (size !== undefined) segment.size = size
  }

  balancePhases(circuits, electrical.supply)
  const rcdGroups = groupRcds(circuits, electrical.circuitsPerRcd, electrical.supply)
  const panel = layOutPanel(circuits, rcdGroups, electrical)

  if (panel.maximumDemand > electrical.mainBreakerAmps) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system: 'power',
      message: `Maximum demand is ${panel.maximumDemand.toFixed(1)} A per line against a ${electrical.mainBreakerAmps} A incomer. Uprate the supply to at least ${recommendedMainBreaker(panel.maximumDemand)} A, or move load off.`,
    })
  }

  if (electrical.supply === 'three-phase' && panel.imbalanceAmps > IMBALANCE_THRESHOLD) {
    const worst = PHASES.reduce((l, r) => (panel.phaseLoad[l] > panel.phaseLoad[r] ? l : r))
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'power',
      message: `The lines are ${panel.imbalanceAmps.toFixed(1)} A apart (${panel.imbalancePercent.toFixed(0)}%), with ${worst} carrying ${panel.phaseLoad[worst].toFixed(1)} A. An unbalanced supply puts current in the neutral and pulls the line voltages apart — split a large single-phase load, or take it across all three.`,
    })
  }

  if (panel.modulesUsed > panel.enclosureModules) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system: 'power',
      message: `The board needs ${panel.modulesUsed} modules and the largest standard enclosure holds ${panel.enclosureModules}.`,
    })
  }

  return panel
}
