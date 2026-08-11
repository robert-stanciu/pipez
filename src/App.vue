<script setup lang="ts">
/** Layout shell: library · plan | 3D · results. */
import { useEventListener, watchDebounced } from '@vueuse/core'
import { onMounted, ref } from 'vue'

import AppToolbar from './components/AppToolbar.vue'
import FixtureLibrary from './components/panels/FixtureLibrary.vue'
import InspectorPanel from './components/panels/InspectorPanel.vue'
import ResultsPanel from './components/panels/ResultsPanel.vue'
import PlanCanvas from './components/plan2d/PlanCanvas.vue'
import Scene3d from './components/view3d/Scene3d.vue'
import { loadAutosave, saveAutosave } from './io/autosave.ts'
import { usePlanStore } from './stores/plan.ts'
import { useProjectStore } from './stores/project.ts'
import { useRoutingStore } from './stores/routing.ts'

const projectStore = useProjectStore()
const routing = useRoutingStore()
const plan = usePlanStore()

routing.watchProject()

/** Fraction of the centre area given to the plan. */
const split = ref(0.55)
const centre = ref<HTMLDivElement | null>(null)
const resizing = ref(false)

function startResize(): void {
  resizing.value = true
}

useEventListener(window, 'pointermove', (event: PointerEvent) => {
  if (!resizing.value || !centre.value) return
  const rect = centre.value.getBoundingClientRect()
  split.value = Math.min(0.85, Math.max(0.15, (event.clientX - rect.left) / rect.width))
})
useEventListener(window, 'pointerup', () => {
  resizing.value = false
})

onMounted(async () => {
  const restored = await loadAutosave()
  if (restored) {
    projectStore.load(restored)
    plan.fitToProject()
  }
})

// Autosave trails the edits rather than racing them; losing the last second of work to a
// crash is acceptable, writing to IndexedDB on every pointer move is not.
watchDebounced(() => projectStore.project, (project) => void saveAutosave(project), {
  deep: true,
  debounce: 800,
  maxWait: 5000,
})
</script>

<template>
  <div class="flex h-full flex-col bg-ink-950">
    <AppToolbar />

    <div class="flex min-h-0 flex-1">
      <aside class="w-56 shrink-0 border-r border-ink-800">
        <FixtureLibrary />
      </aside>

      <div ref="centre" class="flex min-w-0 flex-1">
        <div class="min-w-0" :style="{ flexBasis: `${split * 100}%` }">
          <PlanCanvas />
        </div>

        <div
          class="w-1 shrink-0 cursor-col-resize bg-ink-800 transition-colors hover:bg-accent"
          :class="resizing ? 'bg-accent' : ''"
          @pointerdown.prevent="startResize"
        />

        <div class="min-w-0 flex-1">
          <Scene3d />
        </div>
      </div>

      <aside class="flex w-72 shrink-0 flex-col border-l border-ink-800 bg-ink-900">
        <div class="min-h-0 flex-1 overflow-y-auto border-b border-ink-800">
          <InspectorPanel />
        </div>
        <div class="min-h-0 flex-[1.4] overflow-y-auto">
          <ResultsPanel />
        </div>
      </aside>
    </div>
  </div>
</template>
