/**
 * The `.pipez` file format.
 *
 * A project file outlives the code that wrote it, so it is validated on the way in rather
 * than trusted: a hand-edited or older file produces a clear message instead of a view that
 * renders half a building. `schemaVersion` plus the migration hook is what makes it safe to
 * change the model later.
 */

import { z } from 'zod'

import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '../domain/project.ts'
import type { Project } from '../domain/types.ts'

const vec2 = z.object({ x: z.number(), y: z.number() })

const wall = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  loadBearing: z.boolean(),
})

const level = z.object({
  id: z.string(),
  name: z.string(),
  index: z.number().int().nonnegative(),
  elevation: z.number(),
  height: z.number().positive(),
  slabThickness: z.number().nonnegative(),
})

const room = z.object({
  id: z.string(),
  name: z.string(),
  levelId: z.string(),
  outline: z.array(vec2).min(3),
  height: z.number().positive(),
  floorZ: z.number(),
  wallThickness: z.number().positive(),
  walls: z.array(wall),
})

const opening = z.object({
  id: z.string(),
  kind: z.enum(['door', 'passage', 'window']),
  roomId: z.string(),
  wallIndex: z.number().int().nonnegative(),
  offset: z.number(),
  width: z.number().positive(),
  sillHeight: z.number(),
  height: z.number().positive(),
  connectsRoomId: z.string().nullable(),
})

const fixture = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  roomId: z.string(),
  // Added after the first release; older fixtures simply follow the project default.
  entry: z.enum(['bottom', 'back']).nullable().default(null),
  threePhase: z.boolean().nullable().default(null),
  wallIndex: z.number().int().nullable(),
  wallOffset: z.number(),
  position: vec2,
  rotation: z.number(),
  z: z.number(),
})

const servicePoint = z.object({
  id: z.string(),
  kind: z.enum(['waterEntry', 'wasteOutlet', 'electricalPanel']),
  name: z.string(),
  levelId: z.string(),
  roomId: z.string().nullable(),
  position: vec2,
  z: z.number(),
})

const settings = z.object({
  wallThickness: z.number().positive(),
  wallHeight: z.number().positive(),
  slabThickness: z.number().nonnegative(),
  floorBuildUp: z.number().nonnegative(),
  ceilingVoid: z.number().nonnegative(),
  gridPitch: z.number().positive(),
  connectionEntry: z.enum(['bottom', 'back']).default('bottom'),
  electrical: z
    .object({
      supply: z.enum(['single-phase', 'three-phase']).default('three-phase'),
      voltage: z.number().positive().default(230),
      lineVoltage: z.number().positive().default(400),
      mainBreakerAmps: z.number().positive().default(25),
      circuitsPerRcd: z.number().int().positive().default(4),
    })
    .default({
      supply: 'three-phase',
      voltage: 230,
      lineVoltage: 400,
      mainBreakerAmps: 25,
      circuitsPerRcd: 4,
    }),
  standards: z.literal('EN'),
  drainage: z.object({
    // Added after the first release, so older files simply get the original behaviour.
    strategy: z.enum(['rectilinear', 'diagonal']).default('rectilinear'),
    minSlope: z.number().positive(),
    designSlope: z.number().positive(),
    maxSlope: z.number().positive(),
  }),
})

export const projectSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: settings.partial().transform((partial) => ({
    ...DEFAULT_SETTINGS,
    ...partial,
    drainage: { ...DEFAULT_SETTINGS.drainage, ...(partial.drainage ?? {}) },
    electrical: { ...DEFAULT_SETTINGS.electrical, ...(partial.electrical ?? {}) },
  })),
  levels: z.array(level).min(1),
  rooms: z.array(room),
  openings: z.array(opening).default([]),
  fixtures: z.array(fixture),
  servicePoints: z.array(servicePoint).default([]),
})

export class ProjectFileError extends Error {}

/** Bring an older file up to the current schema. */
function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const data = { ...(raw as Record<string, unknown>) }

  // v0 files had no explicit version and no openings array.
  if (typeof data.schemaVersion !== 'number') data.schemaVersion = 1
  if (!Array.isArray(data.openings)) data.openings = []

  // v1 → v2: storeys. Everything a v1 file contains was, by definition, on the ground floor.
  if ((data.schemaVersion as number) < 2) {
    const settings = (data.settings ?? {}) as Record<string, unknown>
    const height = typeof settings.wallHeight === 'number' ? settings.wallHeight : 2600
    const slabThickness =
      typeof settings.slabThickness === 'number' ? settings.slabThickness : DEFAULT_SETTINGS.slabThickness
    const groundId = 'lvl_ground'

    data.levels = [
      { id: groundId, name: 'Ground floor', index: 0, elevation: 0, height, slabThickness },
    ]
    data.settings = { ...settings, slabThickness }
    data.rooms = (Array.isArray(data.rooms) ? data.rooms : []).map((room) => ({
      ...(room as Record<string, unknown>),
      levelId: groundId,
    }))
    data.servicePoints = (Array.isArray(data.servicePoints) ? data.servicePoints : []).map(
      (point) => ({ ...(point as Record<string, unknown>), levelId: groundId }),
    )
    data.schemaVersion = 2
  }

  return data
}

export function parseProject(raw: unknown): Project {
  const result = projectSchema.safeParse(migrate(raw))
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first?.path.join('.') || 'file'
    throw new ProjectFileError(`${where}: ${first?.message ?? 'not a valid Pipez project'}`)
  }
  if (result.data.schemaVersion > SCHEMA_VERSION) {
    throw new ProjectFileError(
      `This file was written by a newer version of Pipez (schema ${result.data.schemaVersion}).`,
    )
  }
  return result.data as Project
}

export const serializeProject = (project: Project): string => JSON.stringify(project, null, 2)

const slug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

export function download(filename: string, contents: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export const downloadProject = (project: Project): void =>
  download(`${slug(project.name)}.pipez`, serializeProject(project))

/** Prompt for a file and parse it. Resolves to null when the user cancels. */
export function openProjectFile(): Promise<Project | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pipez,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        resolve(parseProject(JSON.parse(await file.text())))
      } catch (cause) {
        reject(
          cause instanceof ProjectFileError
            ? cause
            : new ProjectFileError('That file is not valid JSON.'),
        )
      }
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}
