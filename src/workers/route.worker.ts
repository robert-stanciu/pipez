/**
 * The solver runs here so a re-route never blocks the editor.
 *
 * Projects arrive as plain JSON (Vue's reactive proxies are not structured-cloneable), and
 * the result goes back the same way.
 */

import * as Comlink from 'comlink'

import { solve } from '../domain/routing/index.ts'
import type { Project, RoutingResult } from '../domain/types.ts'

export interface RouteApi {
  solve(project: Project): RoutingResult
}

const api: RouteApi = { solve }

Comlink.expose(api)
