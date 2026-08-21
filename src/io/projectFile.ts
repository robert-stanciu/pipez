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
import { DEFAULT_SCAFFOLD } from '../domain/standards/scaffold.ts'
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

const covering = z.enum(['tile', 'stone', 'laminate', 'wood', 'carpet'])

const roomHeating = z.object({
  enabled: z.boolean().default(true),
  spacing: z.number().positive().nullable().default(null),
  roomTempC: z.number().nullable().default(null),
  covering: covering.nullable().default(null),
  manifoldId: z.string().nullable().default(null),
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
  // Added with underfloor heating. A room written before it is heated on the project's own
  // terms, which is what an unannotated room has always meant.
  heating: roomHeating.optional(),
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
  kind: z.enum(['waterEntry', 'wasteOutlet', 'electricalPanel', 'heatingManifold']),
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
      cableRoute: z.enum(['ceiling', 'floor']).default('floor'),
      voltage: z.number().positive().default(230),
      lineVoltage: z.number().positive().default(400),
      mainBreakerAmps: z.number().positive().default(25),
      circuitsPerRcd: z.number().int().positive().default(4),
      // Added once earthing, reference method and surge protection became real inputs. A
      // file written before them is a TN-C-S house wired in method B1 behind a Type 2
      // arrester, which is what it was being designed as all along.
      earthing: z.enum(['TN-S', 'TN-C-S', 'TT']).default('TN-C-S'),
      installationMethod: z.enum(['A1', 'A2', 'B1', 'B2', 'C']).default('B1'),
      surgeProtection: z.enum(['none', 'type-1', 'type-2', 'type-1+2']).default('type-2'),
      modulesPerRow: z.union([z.literal(12), z.literal(18)]).default(12),
    })
    .default({
      supply: 'three-phase',
      cableRoute: 'floor',
      voltage: 230,
      lineVoltage: 400,
      mainBreakerAmps: 25,
      circuitsPerRcd: 4,
      earthing: 'TN-C-S',
      installationMethod: 'B1',
      surgeProtection: 'type-2',
      modulesPerRow: 12,
    }),
  standards: z.literal('EN'),
  // Added after the pipe material became a choice; a file written before it is simply a
  // PP-R house on a 3 bar main, which is what it would have been drawn as anyway.
  supply: z
    .object({
      material: z.enum(['copper', 'PPR', 'PEX-AL-PEX', 'PE-X']).default('PPR'),
      // Ceiling distribution is what the solver drew before the choice existed, so a file
      // written without it still comes back as the drawing its author saved.
      route: z.enum(['ceiling', 'floor']).default('floor'),
      entryPressureKpa: z.number().positive().default(300),
    })
    .default({ material: 'PPR', route: 'floor', entryPressureKpa: 300 }),
  drainage: z.object({
    // Added after the first release, so older files simply get the original behaviour.
    strategy: z.enum(['rectilinear', 'diagonal']).default('rectilinear'),
    minSlope: z.number().positive(),
    designSlope: z.number().positive(),
    maxSlope: z.number().positive(),
  }),
  // Added with underfloor heating. A file written before it has no manifolds in it, so the
  // heating solver has nothing to do and the defaults are never consulted.
  heating: z
    .object({
      pipe: z.enum(['pert16', 'pert17', 'pert20', 'multi16']).default('pert16'),
      spacing: z.number().positive().default(150),
      flowTempC: z.number().positive().default(38),
      deltaTK: z.number().positive().default(8),
      roomTempC: z.number().default(20),
      covering: covering.default('tile'),
      pattern: z.enum(['serpentine', 'perimeter']).default('serpentine'),
      screedCover: z.number().nonnegative().default(45),
      insulationR: z.number().nonnegative().default(1.25),
    })
    .default({
      pipe: 'pert16',
      spacing: 150,
      flowTempC: 38,
      deltaTK: 8,
      roomTempC: 20,
      covering: 'tile',
      pattern: 'serpentine',
      screedCover: 45,
      insulationR: 1.25,
    }),
  // Added with the scaffold schedule. A file written before it is a house nobody has priced a
  // scaffold for yet, so it simply gets the hire everybody books.
  scaffold: z
    .object({
      system: z.enum(['italian', 'facade-frame']).default('italian'),
      deckWidth: z.number().positive().default(1000),
      loadClass: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
      wallGap: z.number().nonnegative().default(300),
      roofRise: z.number().nonnegative().default(500),
      months: z.number().positive().default(2),
      ratePerM2Month: z.number().nonnegative().nullable().default(null),
      deckEveryLift: z.boolean().default(true),
      netting: z.boolean().default(true),
    })
    .default(DEFAULT_SCAFFOLD),
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
    supply: { ...DEFAULT_SETTINGS.supply, ...(partial.supply ?? {}) },
    heating: { ...DEFAULT_SETTINGS.heating, ...(partial.heating ?? {}) },
    scaffold: { ...DEFAULT_SCAFFOLD, ...(partial.scaffold ?? {}) },
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

/**
 * A filename from a project name.
 *
 * Diacritics are folded to their base letters rather than deleted: "Casă Popescu" is
 * `casa-popescu`, not `cas-popescu`. Romanian carries five of them — ă â î ș ț — and a house
 * named after its street or its owner will very often have one, so dropping them turns the
 * file name into something the person who saved it cannot recognise. Decomposing to NFD
 * splits each letter into a base plus a combining mark, which the range below then strips;
 * the comma-below on ș and ț is in that same block, so no per-letter table is needed.
 */
export const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project'

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
