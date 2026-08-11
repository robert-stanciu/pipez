/**
 * Swept corners for drainage.
 *
 * A square corner in a soil or waste pipe is not built with a 90° elbow. Solids stall in the
 * sharp inside of one, and there is no way to get a rod round it, so the fitting schedules
 * pair two 45° bends with a short leg between them. That is a geometric fact about the pipe,
 * not a drawing convention — the run really does cut the corner — so it belongs in the model
 * rather than in the renderers.
 *
 * This pass takes the routed and merged segments and chamfers every square corner: both legs
 * are pulled back and a 45° piece is dropped in between. Invert levels come along for the
 * ride because the pull-back interpolates along the original run, which also means the
 * chamfer is very slightly steeper than the runs either side — as a real cut corner is.
 */

import { dist3, type Vec3 } from '../geometry/vec.ts'
import type { Segment } from '../types.ts'

const pointKey = (p: Vec3): string =>
  `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`

/**
 * The sharpest single bend made for drainage.
 *
 * Anything sharper is built from two, which is why a square corner becomes a pair of 45s.
 * A gentler turn — where an any-bearing run meets an axis, say — is one bend and needs no
 * chamfer at all.
 */
const MAX_SINGLE_BEND = 46

/** Face-to-face leg of a 45° bend, near enough, in millimetres. */
const legFor = (dn: number): number => Math.max(70, dn * 1.2)

interface Trim {
  a: number
  b: number
}

const unit = (from: Vec3, to: Vec3): Vec3 => {
  const length = dist3(from, to)
  if (length < 1e-9) return { x: 0, y: 0, z: 0 }
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length, z: (to.z - from.z) / length }
}

const along = (from: Vec3, dir: Vec3, distance: number): Vec3 => ({
  x: from.x + dir.x * distance,
  y: from.y + dir.y * distance,
  z: from.z + dir.z * distance,
})

/** Degrees between two unit vectors. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))
  return (Math.acos(dot) * 180) / Math.PI
}

/**
 * How far off the outgoing line the main run may arrive before the junction counts as a
 * corner that also collects a branch, rather than a branch joining a straight run. The two
 * need different constructions, but both are handled.
 */
const THROUGH_TOLERANCE = 20

/** A branch already entering this obliquely needs no help. */
const OBLIQUE_ENOUGH = 46

/** Beyond this the branch is running back against the flow; sweeping it would not fix that. */
const AGAINST_THE_FLOW = 100

/**
 * A step across shorter than this is an offset, not a leg of the run.
 *
 * Two runs that should be one pipe end up a little apart whenever the plan lines they follow
 * are: an appliance tail 50 mm off the wall line the main run keeps to, say. The router is
 * right to step across — the pipe really does have to get from one to the other — but it draws
 * the step as two square corners, and inside a couple of hundred millimetres there is no room
 * to build those as swept pairs. A real installer does it in one movement, with two 45° bends
 * back to back, which is what this pass draws instead.
 */
const MAX_OFFSET_STEP = 250

/**
 * Replace short lateral steps with a 45° offset, clear of the junction before them.
 *
 * The step is free to happen anywhere along the two parallel runs it joins — sliding it costs
 * nothing and changes no pipe line — so it is moved far enough downstream to leave a fitting's
 * worth of straight run after the junction it was crowding, and the corner it made is turned
 * into a diagonal. Inverts are re-interpolated over the new lengths, so the fall through the
 * offset is the fall of the run it replaced.
 */
export function absorbOffsets(segments: Segment[], nextId: () => string): Segment[] {
  const incident = new Map<string, Segment[]>()
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      const key = pointKey(end)
      const list = incident.get(key)
      if (list) list.push(segment)
      else incident.set(key, [segment])
    }
  }

  const dropped = new Set<string>()
  const replaced = new Map<string, Segment>()
  const inserted: Segment[] = []

  // Sorted so the result does not depend on array order.
  for (const step of [...segments].sort((l, r) => l.id.localeCompare(r.id))) {
    const across = dist3(step.a, step.b)
    if (across < 1 || across > MAX_OFFSET_STEP) continue
    if (step.role === 'bend' || step.role === 'stack' || step.role === 'vent') continue

    const startKey = pointKey(step.a)
    const endKey = pointKey(step.b)
    // Nothing else may leave the far end, or there is no single run to slide the step along.
    const beyond = (incident.get(endKey) ?? []).filter((s) => s.id !== step.id)
    if (beyond.length !== 1) continue
    const after = beyond[0]
    if (pointKey(after.a) !== endKey || dropped.has(after.id)) continue

    // The run arriving at the near end that the step is offsetting from.
    const before = (incident.get(startKey) ?? []).find(
      (s) => s.id !== step.id && pointKey(s.b) === startKey,
    )
    if (!before || dropped.has(before.id)) continue

    const alongBefore = unit(before.a, before.b)
    const alongAfter = unit(after.a, after.b)
    const stepDir = unit(step.a, step.b)
    // Parallel runs, stepped across: anything else is a genuine corner and is swept, not moved.
    if (angleBetween(alongBefore, alongAfter) > 5) continue
    if (angleBetween(stepDir, alongAfter) < 60) continue

    // Room to slide: a fitting's length of straight run after the junction, and the diagonal
    // and its own clearance still inside the run beyond.
    const clearance = legFor(step.size)
    const beyondLength = dist3(after.a, after.b)
    const slide = Math.min(clearance, beyondLength - across - clearance)
    if (slide < 20) continue

    const corner = along(step.a, alongAfter, slide)
    const rejoin = along(corner, stepDir, across)
    const landing = along(rejoin, alongAfter, across)

    // Fall is re-spread over the new lengths, so the run drops by what it dropped before.
    const oldTotal = across + beyondLength
    const newTotal = slide + across * Math.SQRT2 + (beyondLength - across - slide)
    const fall = (step.a.z - after.b.z) / (oldTotal > 0 ? oldTotal : 1)
    const zAt = (distance: number) => step.a.z - fall * (oldTotal / newTotal) * distance
    const at = (p: Vec3, distance: number): Vec3 => ({ x: p.x, y: p.y, z: zAt(distance) })

    const straight = at(corner, slide)
    const diagonal = at(landing, slide + across * Math.SQRT2)

    const piece = (a: Vec3, b: Vec3, role: Segment['role']): Segment => {
      const length = dist3(a, b)
      const run = Math.hypot(b.x - a.x, b.y - a.y)
      return { ...step, id: nextId(), a, b, length, role, slope: run > 0 ? (a.z - b.z) / run : 0 }
    }

    dropped.add(step.id)
    inserted.push(piece({ ...step.a }, straight, step.role))
    inserted.push(piece(straight, diagonal, 'bend'))
    replaced.set(after.id, {
      ...after,
      a: diagonal,
      length: dist3(diagonal, after.b),
    })
  }

  if (dropped.size === 0) return segments
  return [
    ...segments
      .filter((segment) => !dropped.has(segment.id))
      .map((segment) => replaced.get(segment.id) ?? segment),
    ...inserted,
  ].filter((segment) => segment.length >= 1)
}

/**
 * Swing branch connections round to enter in the direction of flow.
 *
 * A square tee on a drain is wrong for the same reason a square elbow is: the incoming flow
 * hits the far wall of the main run, throws the stream back on itself and drops its solids at
 * the junction. Every schedule joins a branch with a 45° oblique tee instead, entering
 * downstream.
 *
 * The geometry is forced, once you insist on it: the branch cannot enter the *same* point at
 * 45°, so the junction slides `leg` downstream along the trunk while the branch stops `leg`
 * short, and the diagonal between them lands at 45° to both. For a branch arriving square
 * that is a 45° bend followed by a 45° tee, which is exactly the detail on the drawing.
 *
 * Segments are assumed to run a → b downstream, which is how the drainage solver emits them.
 */
export function sweepJunctions(segments: Segment[], nextId: () => string): Segment[] {
  const incident = new Map<string, { point: Vec3; segments: Segment[] }>()
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      const key = pointKey(end)
      const entry = incident.get(key)
      if (entry) entry.segments.push(segment)
      else incident.set(key, { point: end, segments: [segment] })
    }
  }

  /** New endpoints, gathered first and applied together so two junctions cannot fight. */
  const moved = new Map<string, { a?: Vec3; b?: Vec3 }>()
  const inserted: Segment[] = []

  const junctions = [...incident.entries()].sort(([l], [r]) => l.localeCompare(r))

  for (const [key, { point, segments: touching }] of junctions) {
    if (touching.length < 3) continue

    const leaving = touching.filter((s) => pointKey(s.a) === key)
    const arriving = touching.filter((s) => pointKey(s.b) === key)
    // One way out, more than one way in, or the flow here is not a simple confluence.
    if (leaving.length !== 1 || arriving.length < 2) continue

    const outgoing = leaving[0]
    const downstream = unit(point, outgoing.b)
    if (downstream.x === 0 && downstream.y === 0 && downstream.z === 0) continue

    // Travel direction of each arriving run, and how far off the trunk's line it is.
    const approach = arriving.map((segment) => ({
      segment,
      direction: unit(segment.a, point),
    }))
    const turnOf = (direction: Vec3) => angleBetween(direction, downstream)

    // The main run carries straight on; the rest are branches. Alignment decides, and where
    // two arrive equally square the bigger pipe is the one that goes through.
    const through = [...approach].sort(
      (l, r) => turnOf(l.direction) - turnOf(r.direction) || r.segment.size - l.segment.size,
    )[0]

    const branches = approach.filter(
      (entry) =>
        entry !== through &&
        turnOf(entry.direction) > OBLIQUE_ENOUGH &&
        turnOf(entry.direction) <= AGAINST_THE_FLOW,
    )
    if (branches.length === 0) continue

    /**
     * How much of a run this junction may eat.
     *
     * A run touched at both ends has to survive both, so it only gives up a third. A run that
     * ends in a loose end — the last piece into the outlet, typically — has nothing else
     * claiming it and can be consumed whole: the junction then lands on the outlet itself,
     * which is where the tee physically is when a branch drops in beside it. Refusing that
     * case is what leaves a square tee 30 mm short of the outfall.
     */
    const room = (segment: Segment) => {
      const length = dist3(segment.a, segment.b)
      const far = pointKey(segment.a) === key ? segment.b : segment.a
      return (incident.get(pointKey(far))?.segments.length ?? 0) === 1 ? length : length * 0.3
    }
    const leg = Math.min(
      legFor(Math.max(outgoing.size, ...branches.map((b) => b.segment.size))),
      room(outgoing),
      ...branches.map((b) => room(b.segment)),
    )
    if (leg < 20) continue

    // The junction slides downstream, and the outgoing run starts from there instead.
    const junction = along(point, downstream, leg)
    moved.set(outgoing.id, { ...moved.get(outgoing.id), a: junction })

    if (turnOf(through.direction) <= THROUGH_TOLERANCE) {
      // The main run is already heading this way, so it simply grows to meet the junction.
      moved.set(through.segment.id, { ...moved.get(through.segment.id), b: junction })
    } else {
      // The main run turns here as well as collecting a branch — a drop reaching the floor
      // and picking up a basin on its way out, say. It keeps its corner, and a short piece
      // carries it down to the new junction; the corner pass then sweeps that turn. Only the
      // through flow is in this piece, because the branch does not join until the junction.
      inserted.push({
        ...through.segment,
        id: nextId(),
        a: point,
        b: junction,
        length: dist3(point, junction),
        role: 'branch',
      })
    }

    for (const branch of branches) {
      const stop = along(point, branch.direction, -leg)
      moved.set(branch.segment.id, { ...moved.get(branch.segment.id), b: stop })
      inserted.push({
        ...branch.segment,
        id: nextId(),
        a: stop,
        b: junction,
        length: dist3(stop, junction),
        role: 'bend',
      })
    }
  }

  if (moved.size === 0) return segments
  return [
    ...segments.map((segment) => {
      const change = moved.get(segment.id)
      if (!change) return segment
      const a = change.a ?? segment.a
      const b = change.b ?? segment.b
      return { ...segment, a, b, length: dist3(a, b) }
    }),
    ...inserted,
    // A run swallowed whole by its junction is now a point. Dropping it costs no connectivity
    // — both its ends are the same place — and leaving it in would put a zero-length pipe on
    // the schedule and a coupling in the middle of a fitting.
  ].filter((segment) => segment.length >= 1)
}

/**
 * Replace square corners with a pair of 45° bends.
 *
 * `nextId` is used for the inserted pieces so the result stays deterministic.
 */
export function sweepCorners(segments: Segment[], nextId: () => string): Segment[] {
  const trims = new Map<string, Trim>(segments.map((s) => [s.id, { a: 0, b: 0 }]))

  const incident = new Map<string, { point: Vec3; segments: Segment[] }>()
  for (const segment of segments) {
    for (const end of [segment.a, segment.b]) {
      const key = pointKey(end)
      const entry = incident.get(key)
      if (entry) entry.segments.push(segment)
      else incident.set(key, { point: end, segments: [segment] })
    }
  }

  const inserted: Segment[] = []

  // Sorted so the output does not depend on Map insertion order.
  const corners = [...incident.entries()].sort(([l], [r]) => l.localeCompare(r))

  for (const [key, { point, segments: touching }] of corners) {
    // Only a plain corner: a tee is a swept branch fitting, not two elbows.
    if (touching.length !== 2) continue
    const [first, second] = touching
    if (first.role === 'bend' || second.role === 'bend') continue

    // One run in, one run out. Two runs *arriving* is not a corner but a confluence — the
    // outfall, where the drainage leaves the building — and chamfering it would splice the
    // two together and leave the outlet itself connected to nothing.
    const arriving = touching.filter((s) => pointKey(s.b) === key).length
    if (arriving !== 1) continue

    // Directions leading away from the corner, along each leg.
    const firstFar = pointKey(first.a) === key ? first.b : first.a
    const secondFar = pointKey(second.a) === key ? second.b : second.a
    const d1 = unit(point, firstFar)
    const d2 = unit(point, secondFar)

    // The turn the water makes is the supplement of the angle between the two outgoing legs.
    // Splitting it in two gives an isoceles corner, so each half is exactly half the turn.
    const turn = 180 - angleBetween(d1, d2)
    if (turn <= MAX_SINGLE_BEND) continue

    const trim1 = trims.get(first.id) as Trim
    const trim2 = trims.get(second.id) as Trim
    const available1 = dist3(first.a, first.b) - trim1.a - trim1.b
    const available2 = dist3(second.a, second.b) - trim2.a - trim2.b

    const leg = Math.min(
      legFor(Math.max(first.size, second.size)),
      available1 * 0.4,
      available2 * 0.4,
    )
    if (leg < 20) continue

    if (pointKey(first.a) === key) trim1.a += leg
    else trim1.b += leg
    if (pointKey(second.a) === key) trim2.a += leg
    else trim2.b += leg

    const p1 = along(point, d1, leg)
    const p2 = along(point, d2, leg)

    // Orient the new piece along the flow, a -> b, like every other segment. Which leg the
    // water arrives on says this exactly; inferring it from the fall does not, because a
    // level-ish corner drops a millimetre or two across the chamfer and the comparison is
    // then decided by rounding — which quietly produces a piece pointing back upstream.
    const [from, to] = pointKey(first.b) === key ? [p1, p2] : [p2, p1]
    inserted.push({
      id: nextId(),
      system: first.system,
      a: from,
      b: to,
      size: Math.max(first.size, second.size),
      load: Math.max(first.load, second.load),
      length: dist3(from, to),
      role: 'bend',
    })
  }

  const output: Segment[] = []
  for (const segment of segments) {
    const trim = trims.get(segment.id) as Trim
    const length = dist3(segment.a, segment.b)
    if (trim.a + trim.b >= length) continue // fully consumed by its own corners

    const dir = unit(segment.a, segment.b)
    const a = trim.a > 0 ? along(segment.a, dir, trim.a) : segment.a
    const b = trim.b > 0 ? along(segment.b, dir, -trim.b) : segment.b
    output.push({ ...segment, a, b, length: dist3(a, b) })
  }

  return [...output, ...inserted]
}
