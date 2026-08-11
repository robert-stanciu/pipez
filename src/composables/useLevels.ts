/**
 * Resolving the active storey.
 *
 * The view store holds only an id, which may be null on a fresh project or stale after a
 * level is deleted. Everything that needs the actual level goes through here, so there is one
 * definition of "the storey being edited" and it always resolves to something real.
 */

import { computed, type ComputedRef } from 'vue'

import { levelBelow, roomsOnLevel, sortedLevels } from '../domain/model.ts'
import type { Level, Room } from '../domain/types.ts'
import { useProjectStore } from '../stores/project.ts'
import { useViewStore } from '../stores/view.ts'

/**
 * Does a run at these elevations belong to this storey?
 *
 * The band reaches a little below the finished floor, because drainage is buried under it,
 * but not so far that it swallows the ceiling void of the storey underneath — that void
 * belongs to the floor below and its pipes should be drawn there.
 */
const BELOW_FLOOR = 200

export function storeyContains(level: Level | null, lo: number, hi: number): boolean {
  if (!level) return true
  return hi >= level.elevation - BELOW_FLOOR && lo <= level.elevation + level.height
}

export interface LevelContext {
  levels: ComputedRef<Level[]>
  active: ComputedRef<Level | null>
  activeId: ComputedRef<string | null>
  below: ComputedRef<Level | null>
  activeRooms: ComputedRef<Room[]>
  belowRooms: ComputedRef<Room[]>
  isActive: (levelId: string) => boolean
}

export function useLevels(): LevelContext {
  const projectStore = useProjectStore()
  const view = useViewStore()

  const levels = computed(() => sortedLevels(projectStore.project))

  const active = computed(() => {
    const chosen = levels.value.find((l) => l.id === view.activeLevelId)
    return chosen ?? levels.value[0] ?? null
  })

  const activeId = computed(() => active.value?.id ?? null)

  const below = computed(() =>
    active.value ? levelBelow(projectStore.project, active.value.id) : null,
  )

  const activeRooms = computed(() =>
    active.value ? roomsOnLevel(projectStore.project, active.value.id) : [],
  )

  const belowRooms = computed(() =>
    below.value ? roomsOnLevel(projectStore.project, below.value.id) : [],
  )

  return {
    levels,
    active,
    activeId,
    below,
    activeRooms,
    belowRooms,
    isActive: (levelId: string) => activeId.value === levelId,
  }
}
