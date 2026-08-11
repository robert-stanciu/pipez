/** What is selected and what the pointer is over — shared by the plan, the 3D view and the inspectors. */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type SelectionKind = 'room' | 'wall' | 'fixture' | 'service' | 'opening' | 'circuit'

export interface Selection {
  kind: SelectionKind
  id: string
  /** Only meaningful when kind is 'wall'. */
  wallIndex?: number
}

export const useSelectionStore = defineStore('selection', () => {
  const current = ref<Selection | null>(null)
  const hovered = ref<Selection | null>(null)

  const select = (selection: Selection | null) => {
    current.value = selection
  }
  const clear = () => {
    current.value = null
  }
  const hover = (selection: Selection | null) => {
    hovered.value = selection
  }

  const isSelected = (kind: SelectionKind, id: string, wallIndex?: number): boolean =>
    current.value?.kind === kind &&
    current.value.id === id &&
    (wallIndex === undefined || current.value.wallIndex === wallIndex)

  const selectedRoomId = computed(() =>
    current.value?.kind === 'room' || current.value?.kind === 'wall' ? current.value.id : null,
  )

  return { current, hovered, select, clear, hover, isSelected, selectedRoomId }
})
