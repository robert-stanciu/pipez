<script setup lang="ts">
/** Top bar: project identity, history, file operations, and solver status. */
import { ref } from 'vue'

import { downloadBom } from '../io/exportCsv.ts'
import { downloadGltf } from '../io/exportGltf.ts'
import { downloadProject, openProjectFile, ProjectFileError } from '../io/projectFile.ts'
import { usePlanStore } from '../stores/plan.ts'
import { useProjectStore } from '../stores/project.ts'
import { useRoutingStore } from '../stores/routing.ts'
import { useSelectionStore } from '../stores/selection.ts'

const projectStore = useProjectStore()
const routing = useRoutingStore()
const plan = usePlanStore()
const selection = useSelectionStore()

const message = ref<string | null>(null)
const busy = ref(false)

function flash(text: string): void {
  message.value = text
  window.setTimeout(() => {
    if (message.value === text) message.value = null
  }, 4000)
}

async function open(): Promise<void> {
  try {
    const loaded = await openProjectFile()
    if (!loaded) return
    projectStore.load(loaded)
    selection.clear()
    plan.fitToProject()
    flash(`Opened ${loaded.name}`)
  } catch (cause) {
    flash(cause instanceof ProjectFileError ? cause.message : 'Could not open that file.')
  }
}

async function exportGltf(): Promise<void> {
  busy.value = true
  try {
    await downloadGltf(projectStore.project, routing.result)
    flash('Exported glTF')
  } catch {
    flash('glTF export failed.')
  } finally {
    busy.value = false
  }
}

const buttonClass =
  'rounded border border-ink-700 bg-ink-850 px-2.5 py-1 text-ink-300 hover:border-ink-600 hover:text-ink-100 disabled:opacity-40 disabled:hover:border-ink-700'
</script>

<template>
  <header
    class="flex h-11 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900 px-3 text-[12px]"
  >
    <div class="flex items-center gap-2">
      <span class="font-semibold tracking-tight text-accent">Pipez</span>
      <input
        :value="projectStore.project.name"
        class="w-44 rounded border border-transparent bg-transparent px-1.5 py-1 text-ink-100 outline-none hover:border-ink-700 focus:border-accent"
        @change="projectStore.rename(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div class="flex items-center gap-1">
      <button
        type="button"
        :class="buttonClass"
        :disabled="!projectStore.canUndo"
        title="Undo (⌘Z)"
        @click="projectStore.undo()"
      >
        Undo
      </button>
      <button
        type="button"
        :class="buttonClass"
        :disabled="!projectStore.canRedo"
        title="Redo (⇧⌘Z)"
        @click="projectStore.redo()"
      >
        Redo
      </button>
      <button type="button" :class="buttonClass" title="Fit plan (F)" @click="plan.fitToProject()">
        Fit
      </button>
    </div>

    <div class="flex items-center gap-1">
      <button type="button" :class="buttonClass" @click="open">Open</button>
      <button type="button" :class="buttonClass" @click="downloadProject(projectStore.project)">
        Save
      </button>
      <button
        type="button"
        :class="buttonClass"
        :disabled="busy"
        @click="exportGltf"
      >
        glTF
      </button>
      <button
        type="button"
        :class="buttonClass"
        :disabled="routing.result.bom.length === 0"
        @click="downloadBom(projectStore.project, routing.result)"
      >
        CSV
      </button>
    </div>

    <div class="flex items-center gap-1">
      <button
        type="button"
        :class="buttonClass"
        @click="projectStore.loadSample(); selection.clear(); plan.fitToProject()"
      >
        Sample
      </button>
      <button
        type="button"
        :class="buttonClass"
        @click="projectStore.reset(); selection.clear(); plan.fitToProject()"
      >
        New
      </button>
    </div>

    <div class="ml-auto flex items-center gap-3">
      <span v-if="message" class="text-ink-300">{{ message }}</span>

      <span v-if="routing.errorCount" class="rounded bg-red-950/60 px-2 py-0.5 text-red-300">
        {{ routing.errorCount }} error{{ routing.errorCount === 1 ? '' : 's' }}
      </span>
      <span v-if="routing.warningCount" class="rounded bg-amber-950/50 px-2 py-0.5 text-amber-300">
        {{ routing.warningCount }} warning{{ routing.warningCount === 1 ? '' : 's' }}
      </span>

      <span class="numeric flex items-center gap-1.5 text-ink-400">
        <span
          class="inline-block size-1.5 rounded-full"
          :class="routing.solving ? 'animate-pulse bg-accent' : 'bg-emerald-500'"
        />
        {{ routing.solving ? 'routing…' : `${routing.result.stats.solveMs} ms` }}
      </span>
    </div>
  </header>
</template>
