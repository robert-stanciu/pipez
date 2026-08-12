<script setup lang="ts">
/** The three roots the solver connects everything to. */
import { computed } from 'vue'

import type { ServiceKind } from '../../domain/types.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'

const plan = usePlanStore()
const levels = useLevels()
const projectStore = useProjectStore()
const selection = useSelectionStore()
const view = useViewStore()

const STYLE: Record<ServiceKind, { fill: string; glyph: string }> = {
  waterEntry: { fill: '#3b82f6', glyph: 'W' },
  wasteOutlet: { fill: '#a1887f', glyph: 'D' },
  electricalPanel: { fill: '#f59e0b', glyph: 'E' },
  heatingManifold: { fill: '#a855f7', glyph: 'M' },
}

const onActiveLevel = computed(() =>
  projectStore.project.servicePoints.filter((p) => p.levelId === levels.activeId.value),
)

const radius = computed(() => Math.max(120, 11 * plan.mmPerPx))

function grab(event: PointerEvent, id: string): void {
  if (view.tool.kind !== 'select' || event.button !== 0) return
  event.stopPropagation()
  selection.select({ kind: 'service', id })
  plan.beginMoveService(id)
}
</script>

<template>
  <g>
    <g
      v-for="point in onActiveLevel"
      :key="point.id"
      style="cursor: move"
      @pointerdown="grab($event, point.id)"
    >
      <circle
        :cx="point.position.x"
        :cy="-point.position.y"
        :r="radius"
        :fill="STYLE[point.kind].fill"
        :stroke="selection.isSelected('service', point.id) ? '#ffffff' : '#0a0e14'"
        :stroke-width="2.5 * plan.mmPerPx"
      />
      <text
        :x="point.position.x"
        :y="-point.position.y"
        :font-size="radius * 1.1"
        text-anchor="middle"
        dominant-baseline="central"
        fill="#0a0e14"
        font-weight="700"
        pointer-events="none"
      >
        {{ STYLE[point.kind].glyph }}
      </text>
    </g>
  </g>
</template>
