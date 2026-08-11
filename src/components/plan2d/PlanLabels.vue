<script setup lang="ts">
/**
 * Room names and areas, drawn last so nothing is written underneath a pipe run.
 *
 * Labels are suppressed when zoomed out far enough that the text would be larger than the
 * room it names.
 */
import { computed } from 'vue'

import { area } from '../../domain/geometry/polygon.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { usePlanStore } from '../../stores/plan.ts'

const plan = usePlanStore()
const levels = useLevels()

const labels = computed(() => {
  if (plan.mmPerPx > 14) return []
  return levels.activeRooms.value.map((room) => {
    const xs = room.outline.map((p) => p.x)
    const ys = room.outline.map((p) => p.y)
    return {
      id: room.id,
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: -(Math.min(...ys) + Math.max(...ys)) / 2,
      name: room.name,
      detail: `${(area(room.outline) / 1e6).toFixed(2)} m² · h ${(room.height / 1000).toFixed(2)} m`,
    }
  })
})

const title = computed(() => 13 * plan.mmPerPx)
const detail = computed(() => 11 * plan.mmPerPx)
</script>

<template>
  <g pointer-events="none" text-anchor="middle">
    <g v-for="label in labels" :key="label.id">
      <!-- A dark halo keeps the name readable where it crosses a run. -->
      <text
        :x="label.x"
        :y="label.y"
        :font-size="title"
        fill="#cbd5e1"
        stroke="#0a0e14"
        :stroke-width="4 * plan.mmPerPx"
        paint-order="stroke"
        stroke-linejoin="round"
      >
        {{ label.name }}
      </text>
      <text
        :x="label.x"
        :y="label.y + detail * 1.4"
        :font-size="detail"
        fill="#8b94a3"
        stroke="#0a0e14"
        :stroke-width="4 * plan.mmPerPx"
        paint-order="stroke"
        stroke-linejoin="round"
        class="numeric"
      >
        {{ label.detail }}
      </text>
    </g>
  </g>
</template>
