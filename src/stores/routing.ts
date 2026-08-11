/**
 * Drives the solver.
 *
 * The solve runs in a worker, debounced behind project edits, and the previous result stays
 * on screen while a new one computes — so dragging a fixture never leaves the views blank
 * or stutters the editor.
 */

import { watchDebounced } from '@vueuse/core'
import * as Comlink from 'comlink'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { solve as solveInline } from '../domain/routing/index.ts'
import type { Project, RoutingResult, Segment, SystemKind } from '../domain/types.ts'
import { EMPTY_RESULT } from '../domain/types.ts'
import type { RouteApi } from '../workers/route.worker.ts'
import { useProjectStore } from './project.ts'

export const useRoutingStore = defineStore('routing', () => {
  const result = shallowRef<RoutingResult>(EMPTY_RESULT)
  const solving = ref(false)
  const error = ref<string | null>(null)

  let api: Comlink.Remote<RouteApi> | null = null
  try {
    const worker = new Worker(new URL('../workers/route.worker.ts', import.meta.url), {
      type: 'module',
    })
    api = Comlink.wrap<RouteApi>(worker)
  } catch {
    // No worker available (older browser, or a test environment) — fall back to solving on
    // the main thread. Slower on big plans, but never broken.
    api = null
  }

  /** Serial number so a slow solve cannot overwrite a newer, faster one. */
  let generation = 0

  async function run(project: Project): Promise<void> {
    const mine = ++generation
    solving.value = true
    error.value = null
    // Reactive proxies are not structured-cloneable, so send plain JSON.
    const payload = JSON.parse(JSON.stringify(project)) as Project
    try {
      const next = api ? await api.solve(payload) : solveInline(payload)
      if (mine !== generation) return
      result.value = next
    } catch (cause) {
      if (mine !== generation) return
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (mine === generation) solving.value = false
    }
  }

  function watchProject(): void {
    const projectStore = useProjectStore()
    watchDebounced(
      () => projectStore.project,
      (project) => void run(project),
      { deep: true, debounce: 200, maxWait: 1000, immediate: true },
    )
  }

  const warnings = computed(() => result.value.warnings)
  const errorCount = computed(() => warnings.value.filter((w) => w.severity === 'error').length)
  const warningCount = computed(() => warnings.value.filter((w) => w.severity === 'warning').length)

  const segmentsFor = (system: SystemKind): Segment[] =>
    result.value.networks.find((n) => n.system === system)?.segments ?? []

  const totalLengthFor = (system: SystemKind): number =>
    result.value.networks.find((n) => n.system === system)?.totalLength ?? 0

  /** Fixtures the solver could not connect, for highlighting in the plan. */
  const unreachedFixtureIds = computed(
    () => new Set(result.value.networks.flatMap((n) => n.unreachedFixtureIds)),
  )

  return {
    result,
    solving,
    error,
    warnings,
    errorCount,
    warningCount,
    segmentsFor,
    totalLengthFor,
    unreachedFixtureIds,
    run,
    watchProject,
  }
})
