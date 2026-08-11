/** Autosave to IndexedDB, so a reload never costs the user their drawing. */

import { del, get, set } from 'idb-keyval'

import type { Project } from '../domain/types.ts'
import { parseProject } from './projectFile.ts'

const KEY = 'pipez:autosave'

export async function saveAutosave(project: Project): Promise<void> {
  // Stored as plain JSON: reactive proxies are not structured-cloneable, and a snapshot is
  // what we want anyway.
  await set(KEY, JSON.parse(JSON.stringify(project)))
}

/**
 * Restore the last autosave. A stored project that no longer parses is dropped rather than
 * left to break every future load.
 */
export async function loadAutosave(): Promise<Project | null> {
  try {
    const raw = await get(KEY)
    return raw ? parseProject(raw) : null
  } catch {
    await del(KEY).catch(() => undefined)
    return null
  }
}

export const clearAutosave = (): Promise<void> => del(KEY)
