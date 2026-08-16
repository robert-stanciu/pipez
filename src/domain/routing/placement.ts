/**
 * Where to put a heating manifold.
 *
 * A manifold is the one thing on a heating drawing that is placed by hand and paid for by
 * everything else. Every loop on it is a single unbroken pipe from the cabinet, round the room
 * and back, so the leaders — the pair of pipes between the manifold and the room — are not an
 * overhead on the loop, they *are* the loop: a metre of leader is a metre of pipe that heats
 * nothing, taken off the length the room had to play with. And the manifold has to be fed
 * itself, by a flow and return from the heat source.
 *
 * Those two pull in opposite directions. Standing in the middle of the plan makes every leader
 * short and drags the primary the length of the house; standing next to the boiler makes the
 * primary nothing and every leader long. What is minimised here is the pipe the two of them
 * come to together, with the primary counted at what a metre of it costs against a metre of
 * coil.
 *
 * Nothing is routed here. Distances are the rectilinear ones a pipe in a floor runs, taken
 * straight rather than round the walls, because the job is to choose between candidate
 * positions and not to price the result — the solve does that, properly, afterwards.
 */

import {
  bounds,
  distanceToBoundary,
  pointInPolygon,
  area as polygonArea,
  type Bounds,
} from '../geometry/polygon.ts'
import { add2, dist2, norm2, perp2, scale2, sub2, type Vec2 } from '../geometry/vec.ts'
import { fixtureFrame, heatingOf, roomsOnLevel, servicePointsOf } from '../model.ts'
import { MIN_HEATED_AREA_M2, ufhPipe, WALL_CLEARANCE } from '../standards/en1264.ts'
import type { Project, Room, ServicePoint } from '../types.ts'

/**
 * What a metre of primary counts for against a metre of coil.
 *
 * The primary is the larger pipe and it is insulated, so a metre of it lands on the order at
 * more than a metre of Ø16 coil. Counting it one for one lets a dozen rooms outvote it and the
 * heat source stops mattering; counting it much dearer than this buys the primary back by
 * making every leader in the house longer, which is a worse drawing however it prices. At
 * double, the two move together — on a plan laid out at all sensibly the best place is short
 * of both, not a trade of one against the other.
 */
const PRIMARY_WEIGHT = 2

/** How far a cabinet stands off the wall it is recessed into, mm. */
const CABINET_INSET = WALL_CLEARANCE

/** How finely the walls are walked looking for somewhere to stand it, mm. */
const CANDIDATE_STEP = 250

export interface ManifoldPlacement {
  /** Where the manifold goes. */
  position: Vec2
  /** The room it lands in, if it lands in one. */
  roomId: string | null
  /** Leader pipe between the manifold and every room it serves, mm — flow and return both. */
  leaderLength: number
  /** Primary flow and return between the heat source and the manifold, mm. */
  primaryLength: number
  /** How many rooms it would serve from there. */
  rooms: number
}

/**
 * The best place on its own storey for one manifold, with every other manifold left where it
 * is. Which rooms it ends up serving is worked out from where it lands, by the same
 * nearest-manifold rule the solver uses — so moving it can hand rooms to a neighbour.
 *
 * Returns null when there is nowhere to stand it or nothing on the storey to heat.
 */
export function bestManifoldPosition(
  project: Project,
  boardId: string,
): ManifoldPlacement | null {
  const board = servicePointsOf(project, 'heatingManifold').find((b) => b.id === boardId)
  if (!board) return null
  const site = survey(project, board)
  if (!site) return null

  let best: ManifoldPlacement | null = null
  let bestCost = Infinity
  let bestMove = Infinity
  for (const candidate of standingRoom(roomsOnLevel(project, board.levelId))) {
    const placement = evaluate(site, candidate.position, candidate.roomId)
    if (!placement) continue
    const cost = costOf(placement)
    const move = dist2(candidate.position, board.position)
    // Ties go to whatever is nearest where the manifold already stands, so a manifold that is
    // already in the right place does not shuffle along its wall every time this is pressed.
    if (cost < bestCost - 1 || (cost < bestCost + 1 && move < bestMove)) {
      if (cost < bestCost) bestCost = cost
      bestMove = move
      best = placement
    }
  }
  return best
}

/** What the manifold costs where it stands, to compare against what it could cost. */
export function manifoldPlacementCost(
  project: Project,
  board: ServicePoint,
): ManifoldPlacement | null {
  const site = survey(project, board)
  return site ? evaluate(site, board.position, board.roomId) : null
}

/** Total pipe a placement comes to, with the primary at what it costs. */
export const costOf = (placement: ManifoldPlacement): number =>
  placement.leaderLength + PRIMARY_WEIGHT * placement.primaryLength

/* --------------------------------------------------------------------- parts */

/** One room's claim on a manifold: where it is, and how much leader it buys. */
interface Demand {
  box: Bounds
  centre: Vec2
  /** Every loop in a room is its own pipe off its own port, so two loops pay the leader twice. */
  loops: number
  /** Set where the room names a manifold rather than taking whichever is nearest. */
  manifoldId: string | null
}

interface Site {
  boardId: string
  demands: Demand[]
  others: ServicePoint[]
  source: Vec2 | null
}

function survey(project: Project, board: ServicePoint): Site | null {
  const demands: Demand[] = []
  for (const room of roomsOnLevel(project, board.levelId)) {
    const settings = heatingOf(project, room)
    if (!settings.enabled) continue
    if (polygonArea(room.outline) / 1e6 < MIN_HEATED_AREA_M2) continue
    demands.push({
      box: bounds(room.outline),
      centre: centreOf(room),
      loops: loopsIn(project, room),
      manifoldId: settings.manifoldId ?? null,
    })
  }
  if (demands.length === 0) return null

  return {
    boardId: board.id,
    demands,
    others: servicePointsOf(project, 'heatingManifold').filter(
      (b) => b.id !== board.id && b.levelId === board.levelId,
    ),
    source: heatSourcePosition(project),
  }
}

function evaluate(site: Site, at: Vec2, roomId: string | null): ManifoldPlacement | null {
  let leaderLength = 0
  let rooms = 0
  for (const demand of site.demands) {
    const mine = demand.manifoldId
      ? demand.manifoldId === site.boardId
      : site.others.every((other) => dist2(demand.centre, at) <= dist2(demand.centre, other.position))
    if (!mine) continue
    // There and back: a leader is a pair, and the pair is pipe off the coil itself.
    leaderLength += 2 * demand.loops * rectilinear(at, demand.box)
    rooms += 1
  }
  if (rooms === 0) return null

  return {
    position: { ...at },
    roomId,
    leaderLength,
    primaryLength: site.source
      ? 2 * (Math.abs(site.source.x - at.x) + Math.abs(site.source.y - at.y))
      : 0,
    rooms,
  }
}

interface Candidate {
  position: Vec2
  roomId: string | null
}

/**
 * Everywhere a cabinet could stand, which is against a wall.
 *
 * A manifold is a metre of steel box recessed into a wall or hung on one; nobody stands one in
 * the middle of a floor, and a solver allowed to would put it there every time. So the walls of
 * every room on the storey are walked, a cabinet's depth inside them.
 */
function standingRoom(rooms: Room[]): Candidate[] {
  const out: Candidate[] = []
  for (const room of rooms) {
    for (let i = 0; i < room.outline.length; i++) {
      const a = room.outline[i]
      const b = room.outline[(i + 1) % room.outline.length]
      const along = sub2(b, a)
      const length = Math.hypot(along.x, along.y)
      if (length < 2 * CANDIDATE_STEP) continue
      // The outline may wind either way, so the inward normal is whichever of the two lands
      // inside the room.
      const offset = scale2(perp2(norm2(along)), CABINET_INSET)
      for (let k = 1; k * CANDIDATE_STEP < length; k++) {
        const on = add2(a, scale2(along, (k * CANDIDATE_STEP) / length))
        const inward = pointInPolygon(add2(on, offset), room.outline)
          ? add2(on, offset)
          : sub2(on, offset)
        if (distanceToBoundary(inward, room.outline) < CABINET_INSET - 1) continue
        if (!pointInPolygon(inward, room.outline)) continue
        out.push({ position: inward, roomId: room.id })
      }
    }
  }
  return out
}

const centreOf = (room: Room): Vec2 => {
  const n = room.outline.length
  return {
    x: room.outline.reduce((sum, p) => sum + p.x, 0) / n,
    y: room.outline.reduce((sum, p) => sum + p.y, 0) / n,
  }
}

/**
 * How far a leader runs to reach a room, in the two directions a pipe in a floor runs.
 *
 * To the edge of the room rather than to the middle of it, because the edge is where the coil
 * is picked up: a manifold standing in the room it serves has no leader to speak of.
 */
function rectilinear(from: Vec2, box: Bounds): number {
  const dx = Math.max(0, box.min.x - from.x, from.x - box.max.x)
  const dy = Math.max(0, box.min.y - from.y, from.y - box.max.y)
  return dx + dy
}

/**
 * How many loops a room will take, which is how many times its leader gets paid for.
 *
 * The reckoning the solver uses to decide how many bands to cut a room into, without the
 * leader term — which is the thing being chosen here and cannot be known yet.
 */
function loopsIn(project: Project, room: Room): number {
  const settings = heatingOf(project, room)
  const pipe = ufhPipe(project.settings.heating.pipe)
  const estimate = (polygonArea(room.outline) / settings.spacing) * 1.15
  return Math.max(1, Math.ceil(estimate / pipe.maxLoopLength))
}

/** The heat source the primary comes from, in plan. */
function heatSourcePosition(project: Project): Vec2 | null {
  const heater = project.fixtures.find((f) => f.type === 'water-heater')
  if (!heater) return null
  const frame = fixtureFrame(project, heater)
  return frame ? { x: frame.origin.x, y: frame.origin.y } : null
}
