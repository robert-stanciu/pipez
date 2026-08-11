/** View state: the active tool, which systems are visible, and how the 3D scene is displayed. */

import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { FixtureType, ServiceKind, SystemKind } from '../domain/types.ts'
import { SYSTEM_KINDS } from '../domain/types.ts'

export type Tool =
  | { kind: 'select' }
  | { kind: 'room' }
  | { kind: 'fixture'; fixture: FixtureType }
  | { kind: 'service'; service: ServiceKind }
  | { kind: 'opening'; opening: 'door' | 'window' }

export const useViewStore = defineStore('view', () => {
  const tool = ref<Tool>({ kind: 'select' })

  /**
   * The storey being edited. Null means "not chosen yet" and resolves to the ground floor —
   * the plan store owns the resolution so this store never has to know about the project.
   */
  const activeLevelId = ref<string | null>(null)
  const setActiveLevel = (id: string | null) => {
    activeLevelId.value = id
  }

  /** Draw the storey below as a faint underlay, so walls can be lined up for a stack. */
  const showLevelBelow = ref(true)
  /** Limit the 3-D view to the active storey. */
  const isolateLevel = ref(false)

  const visibleSystems = ref<Set<SystemKind>>(new Set(SYSTEM_KINDS))
  const showNetworks = ref(true)
  const showDimensions = ref(true)
  const showFixtures = ref(true)
  /** Walls drawn translucent in 3D so the pipes inside them can be seen. */
  const xray = ref(true)

  const setTool = (next: Tool) => {
    tool.value = next
  }
  const resetTool = () => {
    tool.value = { kind: 'select' }
  }

  function toggleSystem(system: SystemKind): void {
    const next = new Set(visibleSystems.value)
    if (next.has(system)) next.delete(system)
    else next.add(system)
    visibleSystems.value = next
  }

  const isSystemVisible = (system: SystemKind): boolean =>
    showNetworks.value && visibleSystems.value.has(system)

  return {
    tool,
    setTool,
    resetTool,
    activeLevelId,
    setActiveLevel,
    showLevelBelow,
    isolateLevel,
    visibleSystems,
    toggleSystem,
    isSystemVisible,
    showNetworks,
    showDimensions,
    showFixtures,
    xray,
  }
})
