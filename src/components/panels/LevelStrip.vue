<script setup lang="ts">
/**
 * Storey switcher.
 *
 * Listed top-down, the way a section drawing reads, so "up" on screen is up in the building.
 */
import { computed } from 'vue'

import { roomsOnLevel } from '../../domain/model.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'

const projectStore = useProjectStore()
const view = useViewStore()
const selection = useSelectionStore()
const plan = usePlanStore()
const levels = useLevels()

const descending = computed(() => [...levels.levels.value].reverse())

const roomCount = (levelId: string) => roomsOnLevel(projectStore.project, levelId).length

function choose(levelId: string): void {
  view.setActiveLevel(levelId)
  // Selections belong to a storey; keeping one alive across a switch means the inspector
  // shows something that is no longer on screen.
  selection.clear()
}

function add(): void {
  const level = projectStore.addLevel()
  choose(level.id)
  plan.fitToProject()
}

function remove(levelId: string): void {
  projectStore.removeLevel(levelId)
  choose(levels.levels.value[levels.levels.value.length - 1]?.id ?? '')
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div
      v-for="level in descending"
      :key="level.id"
      class="group flex items-center gap-1 rounded border px-2 py-1.5"
      :class="
        levels.isActive(level.id)
          ? 'border-accent bg-accent/15 text-ink-100'
          : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
      "
    >
      <button type="button" class="flex min-w-0 flex-1 items-baseline gap-2 text-left" @click="choose(level.id)">
        <span class="truncate">{{ level.name }}</span>
        <span class="numeric ml-auto shrink-0 text-[10px] text-ink-400">
          +{{ (level.elevation / 1000).toFixed(2) }} m · {{ roomCount(level.id) }}
        </span>
      </button>
      <button
        v-if="levels.levels.value.length > 1"
        type="button"
        class="shrink-0 px-1 text-ink-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
        :title="`Delete ${level.name} and everything on it`"
        @click="remove(level.id)"
      >
        ✕
      </button>
    </div>

    <button
      type="button"
      class="rounded border border-dashed border-ink-700 py-1.5 text-ink-400 hover:border-ink-600 hover:text-ink-200"
      @click="add"
    >
      + Add storey
    </button>

    <label class="mt-1 flex items-center justify-between py-0.5 text-[11px]">
      <span class="text-ink-400">Ghost storey below</span>
      <input v-model="view.showLevelBelow" type="checkbox" class="size-3.5 accent-[var(--color-accent)]" />
    </label>
  </div>
</template>
