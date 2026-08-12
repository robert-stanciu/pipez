/**
 * The solver entry point: takes a project, returns every network, circuit, warning and the
 * bill of materials.
 *
 * Deterministic by construction — ids come from a counter, iteration order is fixed, and
 * nothing consults the clock or a random source. The same project always yields the same
 * result, which is what makes the golden-case tests meaningful and stops the 3D scene
 * from churning on every re-solve.
 */

import { makeIdFactory } from '../ids.ts'
import { ufhPipe } from '../standards/en1264.ts'
import type { Project, RoutingResult } from '../types.ts'
import { routeElectrical } from './electrical.ts'
import { buildBom } from './fittings.ts'
import { routeHeating } from './heating.ts'
import { levelShapes } from './layers.ts'
import { routeSupply } from './supply.ts'
import { routeWaste } from './waste.ts'

export function solve(project: Project): RoutingResult {
  const startedAt = performance.now()
  const nextId = makeIdFactory('r')

  if (project.rooms.length === 0) {
    return {
      networks: [],
      circuits: [],
      panels: [],
      manifolds: [],
      loops: [],
      warnings: [],
      bom: [],
      stats: { solveMs: 0, graphNodes: 0, graphEdges: 0 },
    }
  }

  // Plan geometry is resolved per storey once and shared by all five solvers.
  const shapes = levelShapes(project)

  const waste = routeWaste(project, shapes, nextId)
  const cold = routeSupply(project, shapes, 'cold', nextId)
  const hot = routeSupply(project, shapes, 'hot', nextId)
  const power = routeElectrical(project, shapes, nextId)
  const heating = routeHeating(project, shapes, nextId)

  const parts = [waste, cold, hot, power, heating]
  const networks = parts.map((p) => p.network).filter((n) => n.segments.length > 0)
  const warnings = parts.flatMap((p) => p.warnings)

  return {
    networks,
    circuits: power.circuits,
    panels: power.panels,
    manifolds: heating.manifolds,
    loops: heating.loops,
    warnings,
    bom: buildBom(networks, power.circuits, {
      material: project.settings.supply.material,
      heatingPipe: ufhPipe(project.settings.heating.pipe).label,
      extra: heating.bom,
    }),
    stats: {
      solveMs: Math.round(performance.now() - startedAt),
      graphNodes: parts.reduce((sum, p) => sum + p.graphNodes, 0),
      graphEdges: parts.reduce((sum, p) => sum + p.graphEdges, 0),
    },
  }
}

export { buildingShape, levelShapes } from './layers.ts'
export { groupCircuits } from './electrical.ts'
export { routeHeating } from './heating.ts'
export type { SystemSolution } from './waste.ts'
