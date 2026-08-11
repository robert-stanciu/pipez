/**
 * Turning a routed tree into something you could order from a merchant: merge the raw
 * per-edge segments into straight runs, infer the fittings at every junction and change of
 * direction, and total it all up.
 */

import { dist3, type Vec3 } from '../geometry/vec.ts'
import { supplyPipeLabel } from '../standards/en806.ts'
import type {
  BomLine,
  Circuit,
  Fitting,
  Network,
  Segment,
  SupplyMaterial,
  SystemKind,
} from '../types.ts'
import { angleBetween } from './bends.ts'


const pointKey = (p: Vec3): string => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`

/** The end of a segment that is not this point. */
const otherEnd = (segment: Segment, point: Vec3): Vec3 =>
  pointKey(segment.a) === pointKey(point) ? segment.b : segment.a

function unitFrom(from: Vec3, to: Vec3): Vec3 {
  const length = dist3(from, to)
  if (length < 1e-9) return { x: 0, y: 0, z: 0 }
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length, z: (to.z - from.z) / length }
}

/**
 * Below this a junction is a joint in a straight run, not a change of direction.
 *
 * Graded pipe is never quite level, so two legs that are square in plan meet at a degree or
 * so off ninety. Calling that an elbow would put a fitting on the schedule that does not
 * exist and that nobody would install.
 */
const STRAIGHT_ENOUGH = 5

/**
 * Angles fittings are actually made in.
 *
 * Drainage stops at 45 — sharper turns are built from a pair — while pressurised pipe and
 * cable are happily taken round a square corner in one fitting.
 */
const CATALOGUE_ANGLES: Record<SystemKind, number[]> = {
  waste: [15, 30, 45],
  cold: [45, 90],
  hot: [45, 90],
  power: [45, 90],
}

/**
 * Report the fitting you would order, not the angle the geometry happens to compute.
 *
 * A corner swept at 45° comes out as 44.4° once the fall is taken into account; the part in
 * the merchant's rack is still a 45. An angle far from anything in the catalogue is reported
 * as it is, so a genuinely odd corner shows up rather than being quietly rounded away.
 */
function catalogueAngle(degrees: number, system: SystemKind): number {
  let best = Math.round(degrees)
  let bestGap = Infinity
  for (const candidate of CATALOGUE_ANGLES[system]) {
    const gap = Math.abs(candidate - degrees)
    if (gap < bestGap && gap <= 5) {
      bestGap = gap
      best = candidate
    }
  }
  return best
}

/**
 * Collapse chains of collinear segments that carry the same load and size.
 *
 * The router emits one segment per grid edge, so a 4 m straight run arrives as a dozen
 * pieces. Merging matters for more than tidiness: the fitting pass counts a bend at every
 * junction of two segments, and un-merged collinear pieces would invent elbows that aren't
 * there.
 */
export function mergeCollinear(segments: Segment[]): Segment[] {
  const incident = new Map<string, Segment[]>()
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      const key = pointKey(end)
      const list = incident.get(key)
      if (list) list.push(segment)
      else incident.set(key, [segment])
    }
  }

  const consumed = new Set<string>()
  const output: Segment[] = []

  /**
   * Truly parallel, not merely pointing into the same octant.
   *
   * Any-bearing runs make this matter: two diagonals heading north-east at different angles
   * share a sign triple, and merging them would straighten a real corner out of existence.
   */
  const parallel = (x: Segment, y: Segment): boolean => {
    const a = unitFrom(x.a, x.b)
    const b = unitFrom(y.a, y.b)
    return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z) > 0.9999
  }

  const sameRun = (x: Segment, y: Segment): boolean =>
    x.size === y.size &&
    Math.abs(x.load - y.load) < 1e-9 &&
    x.circuitId === y.circuitId &&
    // A stack and the drop that feeds it are both vertical but are different components,
    // and merging them would hide the storey crossing from the schedule.
    x.role === y.role &&
    parallel(x, y)

  /** Walk from `end` while the chain stays straight and undivided. */
  const extend = (start: Segment, fromEnd: 'a' | 'b'): Vec3 => {
    let current = start
    let tip = fromEnd === 'a' ? start.a : start.b
    for (;;) {
      const neighbours = (incident.get(pointKey(tip)) ?? []).filter((s) => s.id !== current.id)
      if (neighbours.length !== 1) return tip
      const next = neighbours[0]
      if (consumed.has(next.id) || !sameRun(current, next)) return tip
      consumed.add(next.id)
      tip = pointKey(next.a) === pointKey(tip) ? next.b : next.a
      current = next
    }
  }

  for (const segment of segments) {
    if (consumed.has(segment.id)) continue
    consumed.add(segment.id)
    const a = extend(segment, 'a')
    const b = extend(segment, 'b')
    const length = dist3(a, b)
    output.push({ ...segment, a, b, length })
  }

  return output
}

/**
 * Infer fittings from the merged geometry: a tee where three or more runs meet, an elbow
 * where two runs turn, a reducer where the size steps, and a terminal at every loose end.
 */
export function deriveFittings(
  segments: Segment[],
  system: SystemKind,
  nextId: () => string,
): Fitting[] {
  const incident = new Map<string, { point: Vec3; segments: Segment[] }>()
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      const key = pointKey(end)
      const entry = incident.get(key)
      if (entry) entry.segments.push(segment)
      else incident.set(key, { point: end, segments: [segment] })
    }
  }

  const fittings: Fitting[] = []
  // Sorting by position keeps the output stable regardless of Map insertion order.
  const junctions = [...incident.values()].sort((l, r) => pointKey(l.point).localeCompare(pointKey(r.point)))

  for (const { point, segments: touching } of junctions) {
    const maxSize = Math.max(...touching.map((s) => s.size))
    const minSize = Math.min(...touching.map((s) => s.size))
    const key = pointKey(point)
    const arriving = touching.filter((s) => pointKey(s.b) === key)

    // Three or more runs, or two runs both flowing in — the second is the outfall, where two
    // pipes meet and the drainage leaves the building. Both are junctions, not bends.
    if (touching.length >= 3 || arriving.length >= 2) {
      // The angle a branch makes with the outgoing run is what distinguishes an oblique tee
      // from a square one, and on a drain that is the difference between a junction that
      // clears and one that blocks.
      const leaving = touching.find((s) => pointKey(s.a) === key)
      const entry = leaving
        ? arriving
            .map((s) => angleBetween(unitFrom(s.a, point), unitFrom(point, leaving.b)))
            .filter((angle) => angle > 1)
        : []
      fittings.push({
        id: nextId(),
        kind: 'tee',
        system,
        position: point,
        size: maxSize,
        angle: entry.length > 0 ? catalogueAngle(Math.max(...entry), system) : undefined,
      })
      continue
    }
    if (touching.length === 2) {
      const [first, second] = touching
      // Directions of travel through the junction: in along one leg, out along the other.
      const dirIn = unitFrom(otherEnd(first, point), point)
      const dirOut = unitFrom(point, otherEnd(second, point))
      const turn = angleBetween(dirIn, dirOut)

      if (turn >= STRAIGHT_ENOUGH) {
        fittings.push({
          id: nextId(),
          kind: 'elbow',
          system,
          position: point,
          size: maxSize,
          angle: catalogueAngle(turn, system),
          dirIn,
          dirOut,
        })
      } else if (maxSize !== minSize) {
        fittings.push({ id: nextId(), kind: 'reducer', system, position: point, size: maxSize })
      } else {
        fittings.push({ id: nextId(), kind: 'coupling', system, position: point, size: maxSize })
      }
      continue
    }
    fittings.push({ id: nextId(), kind: 'terminal', system, position: point, size: maxSize })
  }

  return fittings
}

const PIPE_LABEL: Record<SystemKind, string> = {
  cold: 'Cold water pipe',
  hot: 'Hot water pipe',
  waste: 'Waste pipe',
  power: 'Cable',
}

/** A run that crosses a storey is a different item on the order, and priced differently. */
const STACK_LABEL: Record<SystemKind, string> = {
  cold: 'Cold water rising main',
  hot: 'Hot water rising main',
  waste: 'Soil stack',
  power: 'Cable riser',
}

/** The stub between the top of a drain and its air admittance valve. */
const VENT_LABEL: Record<SystemKind, string> = {
  cold: 'Cold water pipe',
  hot: 'Hot water pipe',
  waste: 'Vent pipe',
  power: 'Cable',
}

const FITTING_LABEL: Record<Fitting['kind'], string> = {
  elbow: 'Elbow 90°',
  tee: 'Tee',
  reducer: 'Reducer',
  coupling: 'Coupling',
  trap: 'Trap',
  stack: 'Stack connector',
  aav: 'Air admittance valve',
  terminal: 'Terminal connection',
}

/** Roll the networks up into an orderable list. */
/**
 * Roll the networks up into an orderable list.
 *
 * Only what is routed: pipe by the metre, fittings by the piece, a breaker per circuit. The
 * board's own parts — enclosure, arrester, residual current devices, blanks — are counted in
 * the shopping list, which knows the ratings the devices are actually sold in.
 */
export function buildBom(
  networks: Network[],
  circuits: Circuit[],
  material: SupplyMaterial = 'copper',
): BomLine[] {
  const lines = new Map<string, BomLine>()

  const bump = (line: Omit<BomLine, 'quantity'>, quantity: number) => {
    const key = `${line.system}|${line.item}|${line.unit}`
    const existing = lines.get(key)
    if (existing) existing.quantity += quantity
    else lines.set(key, { ...line, quantity })
  }

  for (const network of networks) {
    for (const segment of network.segments) {
      // The short leg between a pair of 45° bends is part of the fittings, which are counted
      // below — billing it as pipe as well would order the same 150 mm twice.
      if (segment.role === 'bend') continue
      // A vent stub is the same pipe, but it is bought and fitted with the valve rather than
      // with the drain, so it is worth its own line on the order.
      const noun =
        segment.role === 'stack' ? STACK_LABEL : segment.role === 'vent' ? VENT_LABEL : PIPE_LABEL
      const circuit = segment.circuitId
        ? circuits.find((c) => c.id === segment.circuitId)
        : undefined
      const item =
        network.system === 'power'
          ? // Cores are the circuit's own count: three on a single-phase final circuit, five
            // once it is taken across all three lines. Billing every cable as three would
            // order the wrong drum for the cooker.
            `${noun.power} ${circuit?.cores ?? 3} × ${segment.size} mm²`
          : network.system === 'waste'
            ? `${noun[network.system]} DN${segment.size}`
            : // Supply is bought by outside diameter and by material — a Ø20 PP-R and a 15 mm
              // copper are the same connection, and only one of them is on the shelf here.
              `${noun[network.system]} ${supplyPipeLabel(material, segment.size)}`
      bump({ system: network.system, item, unit: 'm' }, segment.length / 1000)
    }
    for (const fitting of network.fittings) {
      // Cables have no fittings worth ordering — the run is continuous to the outlet.
      if (network.system === 'power') continue
      const suffix =
        fitting.size > 0
          ? fitting.system === 'waste'
            ? ` DN${fitting.size}`
            : ` ${supplyPipeLabel(material, fitting.size)}`
          : ''
      // Bends and tees are bought by their angle: a 45° and a 90° are different parts, and on
      // a drain an oblique tee and a square one are not interchangeable at all.
      const label =
        fitting.angle && (fitting.kind === 'elbow' || fitting.kind === 'tee')
          ? fitting.kind === 'elbow'
            ? `Bend ${fitting.angle}°`
            : `${fitting.angle <= 46 ? 'Oblique' : 'Square'} tee ${fitting.angle}°`
          : FITTING_LABEL[fitting.kind]
      bump({ system: network.system, item: `${label}${suffix}`, unit: 'pc' }, 1)
    }
  }

  for (const circuit of circuits) {
    // Curve and breaking capacity are what distinguish one 16 A breaker from another on the
    // shelf, so they belong on the line you would hand to a merchant.
    const rating = `${circuit.curve ?? 'C'}${circuit.breakerAmps}`
    const poles = circuit.poles === 3 ? '3P+N ' : ''
    bump(
      {
        system: 'power',
        item: `MCB ${poles}${rating} · ${(circuit.icn ?? 6000) / 1000} kA — ${circuit.name}`,
        unit: 'pc',
      },
      1,
    )
  }

  return [...lines.values()]
    .map((line) => ({ ...line, quantity: Math.round(line.quantity * 100) / 100 }))
    .sort((a, b) => a.system.localeCompare(b.system) || a.item.localeCompare(b.item))
}
