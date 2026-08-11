/**
 * Where a cable is allowed to be.
 *
 * The rest of the electrical work decides how much copper a circuit needs; this decides where
 * it may run, which is the part a drill discovers. Two sets of rules apply, and the router has
 * to obey both:
 *
 *  - **DIN 18015-3 installation zones.** Horizontal runs live in bands near the floor, at
 *    switch height and below the ceiling; a vertical run that is not simply dropping to the
 *    accessory it serves belongs 100–300 mm from a corner or a door reveal. Between them they
 *    make a wall predictable: anyone can work out where the cable is without opening it up.
 *
 *  - **HD 60364-7-701 bathroom zones.** Zones 0 and 1 are not a preference. Nothing but the
 *    fixed appliance's own supply may pass through them, so they are cut out of the search
 *    space rather than merely discouraged.
 *
 * The DIN zones are set out along wall centrelines, so everything here works in plan plus a
 * height, in millimetres, the same as the router.
 */

import { fixtureDef } from '../catalog/fixtures.ts'
import { dist2, type Vec2 } from '../geometry/vec.ts'
import { fixtureFrame, wallsOf } from '../model.ts'
import type { RouteGraph } from '../routing/graph.ts'
import type { Layer } from '../routing/layers.ts'
import {
  BATHROOM_ZONE_1_HEIGHT,
  BATHROOM_ZONE_1_RADIUS,
  VERTICAL_ZONE_OFFSET,
} from '../standards/electrical.ts'
import type { Fixture, FixtureType, Project, Room } from '../types.ts'

/**
 * Plan positions where a vertical run may leave a horizontal one.
 *
 * One point on each side of every corner and every door reveal, set out at the middle of the
 * DIN 18015-3 vertical band. They are points rather than the band itself because the wall
 * graph is a sampled centreline: giving the router the whole 100–300 mm strip would mean
 * nodes it cannot use, whereas a node at 200 mm is a drop it can actually take.
 *
 * A cable dropping straight to the accessory it feeds is not covered — that run is directly
 * above or below its own outlet, which is permitted anywhere and is how the terminal
 * connections are built.
 */
export function verticalDropPoints(project: Project, rooms: Room[]): Vec2[] {
  const points: Vec2[] = []
  const seen = new Set<string>()
  const add = (p: Vec2) => {
    const key = `${Math.round(p.x)},${Math.round(p.y)}`
    if (seen.has(key)) return
    seen.add(key)
    points.push({ x: Math.round(p.x), y: Math.round(p.y) })
  }

  for (const room of rooms) {
    const openings = project.openings.filter((o) => o.roomId === room.id)
    for (const wall of wallsOf(room)) {
      const span = dist2(wall.centerA, wall.centerB)
      if (span < 2 * VERTICAL_ZONE_OFFSET) continue

      // Both corners, and both reveals of every opening in this wall.
      const edges = [0, span]
      for (const opening of openings) {
        if (opening.wallIndex !== wall.index) continue
        edges.push(opening.offset - opening.width / 2, opening.offset + opening.width / 2)
      }

      for (const edge of edges) {
        for (const t of [edge - VERTICAL_ZONE_OFFSET, edge + VERTICAL_ZONE_OFFSET]) {
          if (t <= 0 || t >= span) continue
          const ratio = t / span
          add({
            x: wall.centerA.x + (wall.centerB.x - wall.centerA.x) * ratio,
            y: wall.centerA.y + (wall.centerB.y - wall.centerA.y) * ratio,
          })
        }
      }
    }
  }
  return points
}

/**
 * A protected volume around a fixed water outlet: a disc in plan, up to a height.
 *
 * Zone 0 — the inside of the bath or the shower basin — sits inside zone 1 everywhere it
 * matters here, so the two are treated as one no-go volume.
 */
export interface WetZone {
  centre: Vec2
  radius: number
  /** Floor of the room, and the top of the zone above the project datum. */
  floorZ: number
  topZ: number
  fixtureId: string
  fixtureName: string
}

/** Fixtures that create a zone: the ones with a fixed water outlet over them. */
const WET_FIXTURES: ReadonlySet<FixtureType> = new Set<FixtureType>(['shower', 'bathtub'])

/**
 * Zone 1 for every shower and bath on a storey.
 *
 * A shower without a basin measures 1200 mm from the fixed water outlet — the 2007 figure,
 * not the 600 mm of the 1984 edition, which was measured from a different thing entirely. A
 * bath's zone 1 is the volume above the bath itself, so its own footprint is the radius.
 */
export function wetZones(project: Project, rooms: Room[]): WetZone[] {
  const byRoom = new Map(rooms.map((room) => [room.id, room]))
  const zones: WetZone[] = []

  for (const fixture of project.fixtures) {
    if (!WET_FIXTURES.has(fixture.type)) continue
    const room = byRoom.get(fixture.roomId)
    if (!room) continue
    const frame = fixtureFrame(project, fixture)
    const centre = frame ? { x: frame.origin.x, y: frame.origin.y } : fixture.position
    const def = fixtureDef(fixture.type)
    const radius =
      fixture.type === 'shower'
        ? BATHROOM_ZONE_1_RADIUS
        : Math.max(def.size.width, def.size.depth) / 2
    zones.push({
      centre,
      radius,
      floorZ: room.floorZ,
      topZ: room.floorZ + BATHROOM_ZONE_1_HEIGHT,
      fixtureId: fixture.id,
      fixtureName: fixture.name,
    })
  }
  return zones
}

/**
 * The zone a point falls in, or null — so a message can name the fixture responsible rather
 * than say "a bathroom zone". `margin` widens the radius, which is how zone 2 is asked for:
 * it is zone 1 plus a further 600 mm.
 */
export function wetZoneAt(
  zones: WetZone[],
  p: { x: number; y: number; z: number },
  margin = 0,
): WetZone | null {
  return (
    zones.find(
      (zone) =>
        p.z >= zone.floorZ && p.z <= zone.topZ && dist2(p, zone.centre) <= zone.radius + margin,
    ) ?? null
  )
}

/** True when a point in the building sits inside one of the protected volumes. */
export const inWetZone = (zones: WetZone[], p: { x: number; y: number; z: number }): boolean =>
  wetZoneAt(zones, p) !== null

/**
 * How close to a permitted fixed appliance a barred node may still be used.
 *
 * The exception in HD 60364-7-701 is for the appliance's *own* supply: a shower pump or an
 * instantaneous heater inside zone 1 has to be fed somehow. Anything further away than the
 * length of that final connection is not the appliance's supply, and stays barred.
 */
const APPLIANCE_SUPPLY_REACH = 400

/**
 * Cut the wet zones out of a wall network.
 *
 * The edges are removed from the graph rather than made expensive: an expensive route is one
 * the router takes when the alternative is worse, and there is no circumstance in which a
 * cable belongs in zone 1. Both directions of each edge go, so no half-edge is left pointing
 * at a node nothing can reach.
 *
 * Done here rather than in the wall-graph builder because the builder is shared with the
 * other services — a drain has no opinion about bathroom zones, and giving it one would put
 * electrical rules in the middle of the geometry.
 */
export function barWetZones(
  graph: RouteGraph,
  layer: Layer,
  zones: WetZone[],
  /** Ports of fixed appliances that are allowed to be fed inside a zone. */
  permittedSupplies: Vec2[] = [],
): Layer {
  if (zones.length === 0) return layer

  const barred = new Set<number>()
  for (const node of layer.nodes) {
    const p = graph.position(node)
    if (!inWetZone(zones, p)) continue
    if (permittedSupplies.some((port) => dist2(p, port) <= APPLIANCE_SUPPLY_REACH)) continue
    barred.add(node)
  }
  if (barred.size === 0) return layer

  for (const node of barred) {
    for (const edge of graph.adj[node]) {
      const back = graph.adj[edge.to]
      const index = back.findIndex((candidate) => candidate.id === edge.id)
      if (index >= 0) back.splice(index, 1)
    }
    graph.adj[node].length = 0
  }

  return restrictLayer(layer, barred)
}

/** The same layer with some of its nodes taken out of it. */
export function restrictLayer(layer: Layer, barred: Set<number>): Layer {
  const nodes = layer.nodes.filter((node) => !barred.has(node))
  const set = new Set(nodes)
  return {
    z: layer.z,
    nodes,
    at(g, p) {
      const node = layer.at(g, p)
      return node !== null && set.has(node) ? node : null
    },
    nearest(g, p) {
      let best: number | null = null
      let bestDist = Infinity
      for (const node of nodes) {
        const q = g.position(node)
        const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y)
        if (d < bestDist) {
          bestDist = d
          best = node
        }
      }
      return best
    },
  }
}

/**
 * Socket outlets are forbidden in zones 0, 1 and 2 (HD 60364-7-701.512.3) — a shaver supply
 * unit to EN 61558-2-5 is the only exception, and this catalogue has none. Luminaires and
 * fixed appliances are permitted with the right ingress rating, so they are not caught here.
 */
export const isBarredAccessory = (fixture: Fixture): boolean =>
  fixtureDef(fixture.type).loads.circuit === 'sockets'
