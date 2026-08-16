/**
 * Pressurised water supply — cold and hot, routed independently but by the same method.
 *
 * Supply is much freer than drainage: it is pumped, so it can climb, and the practical
 * arrangement is one horizontal distribution run per storey with a short vertical connection
 * to every fixture, plus a rising main between storeys. That is what this builds — one
 * horizontal tree per floor, joined vertically — which keeps each search two-dimensional and
 * the result buildable.
 *
 * Which of the two bands the horizontal run uses is the project's choice, and the only thing
 * it changes is the height of that plane. Both cold and hot follow it, so the two networks
 * stay parallel and can be clipped together the way an installer would run them.
 *
 * Like the soil stack, the rising main is not placed. Crossing a slab is expensive and only
 * allowed inside a wall present on both storeys, so the reuse discount collects the upstairs
 * branches onto one riser.
 *
 * Where a water heater is present it becomes the *source* of the hot network rather than a
 * consumer of it, and its own cold feed joins the cold tree.
 */

import { fixtureDef } from '../catalog/fixtures.ts'
import { dist3, to3, type Vec2, type Vec3 } from '../geometry/vec.ts'
import {
  connectionAnchor,
  fixturePorts,
  portsOfSystem,
  servicePointOf,
  sortedLevels,
  type ResolvedPort,
} from '../model.ts'
import {
  boreOf,
  connectionSize,
  drawOffFlow,
  FITTING_ALLOWANCE,
  flowFromLu,
  KINEMATIC_VISCOSITY,
  MAX_HOT_DEAD_LEG_LITRES,
  MAX_STATIC_PRESSURE_KPA,
  MAX_VELOCITY_CONNECTION,
  MAX_VELOCITY_DISTRIBUTION,
  maxRunLength,
  MIN_FLOW_PRESSURE_KPA,
  minFlowRate,
  pipeVolumeLitres,
  pressureLossKpa,
  staticHeadKpa,
  supplyDiameter,
  supplyPipeLabel,
  velocity,
} from '../standards/en806.ts'
import type { Project, RoutingWarning, Segment, SystemKind } from '../types.ts'
import { deriveFittings, mergeCollinear } from './fittings.ts'
import { RouteGraph } from './graph.ts'
import {
  attachTerminal,
  buildPlaneGrid,
  linkStoreys,
  planLines,
  type Layer,
  type LevelShapes,
} from './layers.ts'
import { buildTree, treeLinks, type Terminal } from './steiner.ts'
import type { SystemSolution } from './waste.ts'

/** Height of a ceiling-routed distribution plane below its own storey's ceiling. */
const DISTRIBUTION_DROP = 150

/**
 * Depth of a floor-routed distribution plane below its own storey's finished floor.
 *
 * Supply pipe laid in a screed sits near the top of the build-up. It is pressurised, so
 * unlike drainage it gains nothing by going deeper, and staying shallow keeps it above the
 * drainage plane and clear of the insulation underneath. Where the build-up is thinner than
 * this the plane follows it down rather than floating in the room.
 */
const FLOOR_DISTRIBUTION_DEPTH = 50

/** Slab crossings are dear, so the branches gather onto one rising main. */
const SLAB_CROSSING_WEIGHT = 10

/** The worst place a limit is exceeded, kept per pipe size so one run reports once. */
interface Offence {
  value: number
  limit: number
  load: number
  position: Vec3
}

export function routeSupply(
  project: Project,
  shapes: LevelShapes,
  system: 'cold' | 'hot',
  nextId: () => string,
): SystemSolution {
  const warnings: RoutingWarning[] = []
  const material = project.settings.supply.material
  const empty = (): SystemSolution => ({
    network: { system, segments: [], fittings: [], totalLength: 0, unreachedFixtureIds: [] },
    warnings,
    graphNodes: 0,
    graphEdges: 0,
  })

  const heater = project.fixtures.find((f) => f.type === 'water-heater') ?? null
  const heaterHotPort = heater
    ? (fixturePorts(project, heater).find((p) => p.kind === 'hot') ?? null)
    : null

  // The heater generates hot water, so it is the root of the hot tree, never a draw-off.
  const consumers = portsOfSystem(project, system).filter(
    (p) =>
      !(
        system === 'hot' &&
        heaterHotPort &&
        p.portId === heaterHotPort.portId &&
        p.fixtureId === heaterHotPort.fixtureId
      ),
  )
  if (consumers.length === 0) return empty()

  const entry = servicePointOf(project, 'waterEntry')
  const sourcePoint: Vec3 | null =
    system === 'hot' && heaterHotPort
      ? heaterHotPort.position
      : entry
        ? to3(entry.position, entry.z)
        : null

  if (!sourcePoint) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system,
      message:
        system === 'hot'
          ? 'No hot water source. Place a water heater, or a water entry to feed from.'
          : 'No water entry placed. Drop one on the plan to feed the cold network.',
    })
    return empty()
  }

  const levels = sortedLevels(project)
  const graph = new RouteGraph()
  const attachAt: Vec2[] = [
    ...consumers.map((p) => ({ x: p.position.x, y: p.position.y })),
    { x: sourcePoint.x, y: sourcePoint.y },
  ]
  const lines = planLines(project, attachAt)

  /**
   * The height of a storey's distribution plane, and the only thing the route choice changes.
   *
   * Everything downstream — the tree, the sizing, the risers, the checks — is written against
   * a plane rather than against a ceiling, so moving it into the screed moves the drawing
   * without moving any of the reasoning about it.
   */
  const planeZ = (level: (typeof levels)[number]): number =>
    project.settings.supply.route === 'floor'
      ? level.elevation - Math.min(FLOOR_DISTRIBUTION_DEPTH, project.settings.floorBuildUp)
      : level.elevation + level.height - DISTRIBUTION_DROP

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

  const planeFor = (z: number): Layer | null => {
    // Attach a point to the storey it physically sits on.
    let best: Layer | null = null
    let bestGap = Infinity
    for (const level of levels) {
      const plane = planeOf.get(level.id)
      if (!plane) continue
      const gap = z >= level.elevation ? z - level.elevation : Infinity
      if (gap < bestGap) {
        bestGap = gap
        best = plane
      }
    }
    return best ?? planeOf.get(levels[0]?.id ?? '') ?? null
  }

  const sourcePlane = planeFor(sourcePoint.z)
  const root = sourcePlane ? attachTerminal(graph, sourcePlane, sourcePoint) : null
  if (root === null) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system,
      message: 'The water source is outside the building footprint.',
      position: sourcePoint,
    })
    return empty()
  }

  const terminals: Terminal[] = []
  const byNode = new Map<number, ResolvedPort>()
  for (const port of consumers) {
    const plane = planeFor(port.position.z)
    // Back entry brings the tap feed out of the wall, so the drop runs inside the wall
    // rather than down the face of the room in front of the appliance.
    const fixture = project.fixtures.find((f) => f.id === port.fixtureId)
    const anchor = fixture ? connectionAnchor(project, fixture, port) : null
    const node = plane
      ? attachTerminal(graph, plane, port.position, 1, anchor?.wall ? anchor.plan : undefined)
      : null
    if (node === null) {
      warnings.push({
        id: nextId(),
        severity: 'error',
        system,
        message: `${port.fixtureName} sits outside the building footprint.`,
        position: port.position,
        fixtureId: port.fixtureId,
      })
      continue
    }
    terminals.push({
      ref: port.fixtureId,
      node,
      load: luOf(project, port, system),
      // The catalogue quotes tap tails as copper; in PP-R or composite the same bore is a
      // different number on the outside of the pipe.
      minSize: connectionSize(material, port.dn),
    })
    byNode.set(node, port)
  }

  const tree = buildTree(graph, root, terminals, { turnPenalty: 300, reuseDiscount: 0.1 })

  for (const missed of tree.unreached) {
    warnings.push({
      id: nextId(),
      severity: 'error',
      system,
      message: `No ${system} water route to ${byNode.get(missed.node)?.fixtureName ?? 'a fixture'}. Check that the rooms connect, and that a wall lines up between storeys for the riser.`,
      fixtureId: missed.ref,
    })
  }

  /* ------------------------------------------------- what each edge of the tree carries */

  /**
   * The network sized once, per node, ahead of drawing anything.
   *
   * Every check EN 806 makes — velocity, head loss, standing volume, run length — is a
   * property of the pipe on the way to a draw-off rather than of one grid edge, so the sizes,
   * bores and lengths are worked out here and both the segments and the checks below read the
   * same numbers. `n` always means the edge from `n` up to its parent.
   */
  const size = new Float64Array(graph.nodeCount)
  const bore = new Float64Array(graph.nodeCount)
  const edgeLength = new Float64Array(graph.nodeCount)
  /** Draw-off points fed through this edge. One of them makes it a connection pipe. */
  const drawOffs = new Int32Array(graph.nodeCount)

  for (const terminal of tree.connected) drawOffs[terminal.node] += 1
  for (let i = tree.order.length - 1; i > 0; i--) {
    const node = tree.order[i]
    const up = tree.parent[node]
    if (up >= 0) drawOffs[up] += drawOffs[node]
  }
  for (const node of tree.order) {
    const up = tree.parent[node]
    if (up < 0) continue
    size[node] = supplyDiameter(tree.loadToParent[node], tree.minSizeToParent[node], material)
    bore[node] = boreOf(material, size[node])
    edgeLength[node] = dist3(graph.position(node), graph.position(up))
  }

  /**
   * A pipe serving a single fitting carries that fitting's own draw-off rate; anything shared
   * carries the diversified design flow, which is the whole point of the annex B curve. Two
   * taps are not two taps' worth of water, but one tap certainly is one.
   */
  const flowThrough = (node: number): number =>
    drawOffs[node] <= 1
      ? drawOffFlow(tree.loadToParent[node])
      : flowFromLu(tree.loadToParent[node])

  /* --------------------------------------------------------- §4.4 velocity ceilings */

  /**
   * One warning per size, at its worst point.
   *
   * The router emits an edge per grid cell, so a run that is too fast is too fast for fifty
   * of them; reporting each would bury the drawing under identical messages.
   */
  const tooFast = new Map<number, Offence>()
  for (const node of tree.order) {
    if (tree.parent[node] < 0 || edgeLength[node] <= 0) continue
    const single = drawOffs[node] <= 1
    const speed = velocity(flowThrough(node), bore[node])
    const limit = single ? MAX_VELOCITY_CONNECTION : MAX_VELOCITY_DISTRIBUTION
    if (speed <= limit) continue
    const worst = tooFast.get(size[node])
    if (!worst || speed > worst.value) {
      tooFast.set(size[node], {
        value: speed,
        limit,
        load: tree.loadToParent[node],
        position: graph.position(node),
      })
    }
  }
  for (const [od, offence] of [...tooFast].sort((a, b) => a[0] - b[0])) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system,
      message: `${supplyPipeLabel(material, od)} runs at ${offence.value.toFixed(1)} m/s carrying ${offence.load} LU, over the ${offence.limit.toFixed(1)} m/s EN 806-3 limit — expect flow noise and water hammer. Size that run up.`,
      position: offence.position,
    })
  }

  /* ------------------------------------------------ table 3 maximum run lengths */

  // How far the run of a given size has come, and the heaviest load on it. Sizes only grow
  // towards the source, so a run starts where the size last stepped up and ends at the tap.
  const runLength = new Float64Array(graph.nodeCount)
  const runLoad = new Float64Array(graph.nodeCount)
  const tooLong = new Map<number, Offence>()
  for (const node of tree.order) {
    const up = tree.parent[node]
    if (up < 0) continue
    const sameRun = tree.parent[up] >= 0 && size[up] === size[node]
    runLength[node] = edgeLength[node] + (sameRun ? runLength[up] : 0)
    runLoad[node] = sameRun ? runLoad[up] : tree.loadToParent[node]

    const limit = maxRunLength(material, size[node], runLoad[node])
    if (runLength[node] <= limit) continue
    const worst = tooLong.get(size[node])
    if (!worst || runLength[node] > worst.value) {
      tooLong.set(size[node], {
        value: runLength[node],
        limit,
        load: runLoad[node],
        position: graph.position(node),
      })
    }
  }
  for (const [od, offence] of [...tooLong].sort((a, b) => a[0] - b[0])) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system,
      message: `${(offence.value / 1000).toFixed(1)} m of ${supplyPipeLabel(material, od)} carrying ${offence.load} LU, past the ${(offence.limit / 1000).toFixed(0)} m the EN 806-3 table allows at that load — the pressure will not hold up over that distance.`,
      position: offence.position,
    })
  }

  /* ----------------------------------------------- §4.3 pressure at the worst outlet */

  // Head loss accumulated from the source. Hot water is thinner and loses rather less of it.
  const viscosity = system === 'hot' ? KINEMATIC_VISCOSITY.hot : KINEMATIC_VISCOSITY.cold
  const lossToNode = new Float64Array(graph.nodeCount)
  for (const node of tree.order) {
    const up = tree.parent[node]
    if (up < 0) continue
    lossToNode[node] =
      lossToNode[up] +
      pressureLossKpa(
        flowThrough(node),
        bore[node],
        edgeLength[node] * FITTING_ALLOWANCE,
        viscosity,
      )
  }

  const entryPressure = project.settings.supply.entryPressureKpa
  let worstOutlet: { residual: number; ref: string; lu: number } | null = null
  let lowestDrawOff: { staticKpa: number; ref: string } | null = null
  for (const terminal of tree.connected) {
    const port = byNode.get(terminal.node)
    const at = port?.position ?? graph.position(terminal.node)
    const head = staticHeadKpa(at.z - sourcePoint.z)
    const residual = entryPressure - head - lossToNode[terminal.node]
    if (!worstOutlet || residual < worstOutlet.residual) {
      worstOutlet = { residual, ref: port?.fixtureName ?? 'a fixture', lu: terminal.load }
    }
    // Nothing is flowing, so only the climb counts — and the deepest tap sees the most.
    const staticKpa = entryPressure - head
    if (!lowestDrawOff || staticKpa > lowestDrawOff.staticKpa) {
      lowestDrawOff = { staticKpa, ref: port?.fixtureName ?? 'a fixture' }
    }
  }

  if (worstOutlet && worstOutlet.residual < MIN_FLOW_PRESSURE_KPA) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system,
      message: `${worstOutlet.ref} is the hydraulically worst outlet: ${Math.round(Math.max(0, worstOutlet.residual))} kPa is left there of the ${Math.round(entryPressure)} kPa at the entry, short of the ${MIN_FLOW_PRESSURE_KPA} kPa EN 806-3 wants to deliver its ${minFlowRate(worstOutlet.lu).toFixed(2)} l/s minimum. Size the trunk up, shorten the run, or fit a booster.`,
    })
  }
  if (lowestDrawOff && lowestDrawOff.staticKpa > MAX_STATIC_PRESSURE_KPA) {
    warnings.push({
      id: nextId(),
      severity: 'warning',
      system,
      message: `${Math.round(lowestDrawOff.staticKpa)} kPa stands at ${lowestDrawOff.ref} with nothing drawing, over the ${MAX_STATIC_PRESSURE_KPA} kPa EN 806-3 allows at a draw-off point — fit a pressure reducing valve at the entry.`,
    })
  }

  /* --------------------------------------------------------- hot dead-leg volume */

  if (system === 'hot') {
    // Volume, not length: three litres of standing water is three litres whether it is in a
    // long thin pipe or a short fat one, and it is the volume that has to be run off before
    // the tap goes hot and the volume that sits at Legionella temperature in between.
    const litresToNode = new Float64Array(graph.nodeCount)
    for (const node of tree.order) {
      const up = tree.parent[node]
      if (up < 0) continue
      litresToNode[node] = litresToNode[up] + pipeVolumeLitres(bore[node], edgeLength[node])
    }
    for (const terminal of tree.connected) {
      const litres = litresToNode[terminal.node]
      if (litres <= MAX_HOT_DEAD_LEG_LITRES) continue
      const port = byNode.get(terminal.node)
      warnings.push({
        id: nextId(),
        severity: 'warning',
        system,
        message: `${port?.fixtureName ?? 'A fixture'} has ${litres.toFixed(1)} litres of hot water standing in the ${(tree.distToRoot[terminal.node] / 1000).toFixed(1)} m leg feeding it, past the ${MAX_HOT_DEAD_LEG_LITRES} litre dead-leg limit — it will run cold for a while and the standing water is a Legionella risk. Add a circulation loop.`,
        position: port?.position,
        fixtureId: terminal.ref,
        // The plant room reads this: a dead leg past the limit is what puts a circulation
        // pump, its check valve and its timer on the schedule.
        code: 'hot-dead-leg',
      })
    }
  }

  /* ------------------------------------------------------------------- segments */

  const segments: Segment[] = []
  for (const { child, parent } of treeLinks(tree)) {
    const a = graph.position(child)
    const b = graph.position(parent)
    // Only an edge that actually crosses a slab is a rising main. A tall vertical run inside
    // one storey is just a drop from the ceiling void down to a low tap.
    const isRiser = slabEdges.has(tree.edgeToParent[child])
    const flat = Math.hypot(a.x - b.x, a.y - b.y)
    segments.push({
      id: nextId(),
      system,
      a: { ...a },
      b: { ...b },
      size: size[child],
      load: tree.loadToParent[child],
      length: dist3(a, b),
      role: isRiser ? 'stack' : flat < 1 ? 'drop' : 'branch',
    })
  }

  const merged = mergeCollinear(segments)
  const fittings = deriveFittings(merged, system, nextId)

  return {
    network: {
      system,
      segments: merged,
      fittings,
      totalLength: merged.reduce((sum, s) => sum + s.length, 0),
      unreachedFixtureIds: tree.unreached.map((t) => t.ref),
    },
    warnings,
    graphNodes: graph.nodeCount,
    graphEdges: graph.edgeCount,
  }
}

function luOf(project: Project, port: ResolvedPort, system: SystemKind): number {
  const fixture = project.fixtures.find((f) => f.id === port.fixtureId)
  if (!fixture) return 0
  const loads = fixtureDef(fixture.type).loads
  return (system === 'hot' ? loads.supplyLuHot : loads.supplyLuCold) ?? 0
}
