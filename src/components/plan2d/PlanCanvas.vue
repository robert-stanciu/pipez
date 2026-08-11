<script setup lang="ts">
/**
 * The 2-D plan. Owns the SVG surface and translates pointer events into plan coordinates;
 * everything else is delegated to the plan store's state machine and the layer components.
 */
import { useElementSize, useEventListener } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

import { useLevels } from '../../composables/useLevels.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'
import PlanDimensions from './PlanDimensions.vue'
import PlanGhostLevel from './PlanGhostLevel.vue'
import PlanFixtures from './PlanFixtures.vue'
import PlanLabels from './PlanLabels.vue'
import PlanNetwork from './PlanNetwork.vue'
import PlanRoom from './PlanRoom.vue'
import PlanServicePoints from './PlanServicePoints.vue'
import { toPoints } from './svg.ts'

const host = ref<HTMLDivElement | null>(null)
const surface = ref<SVGSVGElement | null>(null)

const plan = usePlanStore()
const projectStore = useProjectStore()
const selection = useSelectionStore()
const view = useViewStore()
const levels = useLevels()

const { width, height } = useElementSize(host)

// Frame the plan the first time the element actually has a size. Fitting before that
// divides the building by a one-pixel viewport and pins the zoom to its far limit.
let framed = false
watch(
  [width, height],
  ([w, h]) => {
    plan.setSize(w, h)
    if (!framed && w > 0 && h > 0) {
      framed = true
      plan.fitToProject()
    }
  },
  { immediate: true },
)

let pointerClient = { x: 0, y: 0 }

const rect = (): DOMRect =>
  surface.value?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1)

const worldAt = (event: PointerEvent) => plan.toWorld(event.clientX, event.clientY, rect())

function onPointerDown(event: PointerEvent): void {
  surface.value?.setPointerCapture(event.pointerId)
  pointerClient = { x: event.clientX, y: event.clientY }
  const at = worldAt(event)
  plan.cursor = at

  // Middle button always pans, whatever tool is active.
  if (event.button === 1) {
    plan.beginPan(at)
    return
  }
  if (event.button !== 0) return

  switch (view.tool.kind) {
    case 'room':
      plan.beginDrawRoom(at)
      return
    case 'fixture': {
      const created = projectStore.addFixtureAt(view.tool.fixture, plan.snap(at), levels.activeId.value)
      if (created) selection.select({ kind: 'fixture', id: created.id })
      return
    }
    case 'service': {
      const point = projectStore.placeServicePoint(view.tool.service, plan.snap(at), levels.activeId.value)
      selection.select({ kind: 'service', id: point.id })
      view.resetTool()
      return
    }
    case 'opening': {
      const opening = projectStore.addOpeningAt(at, view.tool.opening, levels.activeId.value)
      if (opening) selection.select({ kind: 'opening', id: opening.id })
      return
    }
    default:
      // Empty space with the select tool: clear the selection and pan.
      selection.clear()
      plan.beginPan(at)
  }
}

function onPointerMove(event: PointerEvent): void {
  const at = worldAt(event)
  plan.cursor = at
  if (!plan.isDragging) return
  plan.updateDrag(at, {
    dx: event.clientX - pointerClient.x,
    dy: event.clientY - pointerClient.y,
  })
}

function onPointerUp(event: PointerEvent): void {
  surface.value?.releasePointerCapture(event.pointerId)
  plan.endDrag()
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const at = plan.toWorld(event.clientX, event.clientY, rect())
  plan.zoomAt(at, event.deltaY > 0 ? 1.12 : 1 / 1.12)
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

  if (event.key === 'Escape') view.resetTool()
  if (event.key === 'f') plan.fitToProject()
  if ((event.key === 'Delete' || event.key === 'Backspace') && selection.current) {
    const { kind, id } = selection.current
    if (kind === 'fixture') projectStore.removeFixture(id)
    else if (kind === 'service') projectStore.removeServicePoint(id)
    else if (kind === 'opening') projectStore.removeOpening(id)
    else if (kind === 'room' || kind === 'wall') projectStore.removeRoom(id)
    selection.clear()
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) projectStore.redo()
    else projectStore.undo()
  }
})

/* -------------------------------------------------------------------- render */

const gridLines = computed(() => {
  const step = plan.gridStep
  const w = plan.size.width * plan.mmPerPx
  const h = plan.size.height * plan.mmPerPx
  const left = plan.centre.x - w / 2
  const top = -plan.centre.y - h / 2
  const xs: number[] = []
  const ys: number[] = []
  for (let x = Math.ceil(left / step) * step; x < left + w; x += step) xs.push(x)
  for (let y = Math.ceil(top / step) * step; y < top + h; y += step) ys.push(y)
  return { xs, ys, left, top, right: left + w, bottom: top + h }
})

const draftPoints = computed(() => (plan.draftRoom ? toPoints(plan.draftRoom.outline) : ''))

const cursorStyle = computed(() => {
  if (plan.drag.kind === 'pan') return 'grabbing'
  if (view.tool.kind === 'select') return 'default'
  return 'crosshair'
})
</script>

<template>
  <div ref="host" class="relative h-full w-full overflow-hidden bg-ink-950">
    <svg
      ref="surface"
      class="plan-surface h-full w-full"
      :viewBox="plan.viewBox"
      preserveAspectRatio="none"
      :style="{ cursor: cursorStyle }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
      @contextmenu.prevent
    >
      <!-- Grid -->
      <g pointer-events="none" :opacity="0.5">
        <line
          v-for="x in gridLines.xs"
          :key="`gx-${x}`"
          :x1="x"
          :y1="gridLines.top"
          :x2="x"
          :y2="gridLines.bottom"
          :stroke="x === 0 ? '#3c4859' : '#1c2330'"
          :stroke-width="plan.mmPerPx"
        />
        <line
          v-for="y in gridLines.ys"
          :key="`gy-${y}`"
          :x1="gridLines.left"
          :y1="y"
          :x2="gridLines.right"
          :y2="y"
          :stroke="y === 0 ? '#3c4859' : '#1c2330'"
          :stroke-width="plan.mmPerPx"
        />
      </g>

      <!-- The storey below, so a wall can be lined up to carry a stack. -->
      <PlanGhostLevel v-if="view.showLevelBelow" :rooms="levels.belowRooms.value" />

      <PlanRoom v-for="room in levels.activeRooms.value" :key="room.id" :room="room" />

      <PlanNetwork />
      <PlanFixtures />
      <PlanServicePoints />
      <PlanLabels />
      <PlanDimensions />

      <!-- Snap guides -->
      <g pointer-events="none" stroke="var(--color-accent)" :stroke-width="plan.mmPerPx" opacity="0.7">
        <line
          v-if="plan.guides.x !== null"
          :x1="plan.guides.x"
          :y1="gridLines.top"
          :x2="plan.guides.x"
          :y2="gridLines.bottom"
          stroke-dasharray="120 90"
        />
        <line
          v-if="plan.guides.y !== null"
          :x1="gridLines.left"
          :y1="-plan.guides.y"
          :x2="gridLines.right"
          :y2="-plan.guides.y"
          stroke-dasharray="120 90"
        />
      </g>

      <!-- Room being dragged out -->
      <g v-if="plan.draftRoom" pointer-events="none">
        <polygon
          :points="draftPoints"
          fill="#38bdf822"
          stroke="var(--color-accent)"
          :stroke-width="2 * plan.mmPerPx"
          stroke-dasharray="140 100"
        />
        <text
          :x="(plan.draftRoom.outline[0].x + plan.draftRoom.outline[2].x) / 2"
          :y="-(plan.draftRoom.outline[0].y + plan.draftRoom.outline[2].y) / 2"
          :font-size="14 * plan.mmPerPx"
          text-anchor="middle"
          fill="#e6eaf0"
          class="numeric"
        >
          {{ Math.round(plan.draftRoom.width) }} × {{ Math.round(plan.draftRoom.depth) }}
        </text>
      </g>
    </svg>

    <div
      class="pointer-events-none absolute bottom-2 left-3 flex gap-3 text-[11px] text-ink-400 numeric"
    >
      <span v-if="plan.cursor">
        {{ Math.round(plan.cursor.x) }}, {{ Math.round(plan.cursor.y) }} mm
      </span>
      <span>grid {{ plan.gridStep }} mm</span>
      <span>1 px ≈ {{ plan.mmPerPx.toFixed(1) }} mm</span>
    </div>
  </div>
</template>
