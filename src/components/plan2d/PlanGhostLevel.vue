<script setup lang="ts">
/**
 * The storey below, drawn faintly and not clickable.
 *
 * This is the single most useful thing on a multi-storey plan: a stack may only drop through
 * a wall that exists on both floors, so seeing where the walls underneath run is what tells
 * you where an upstairs bathroom can go.
 */
import { computed } from 'vue'

import { centrelineOutline, outerOutline } from '../../domain/model.ts'
import type { Room } from '../../domain/types.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { toPoints } from './svg.ts'

const props = defineProps<{ rooms: Room[] }>()

const plan = usePlanStore()

const ghosts = computed(() =>
  props.rooms.map((room) => ({
    id: room.id,
    band: `M ${toPoints(outerOutline(room))} Z M ${toPoints(room.outline)} Z`,
    centreline: toPoints(centrelineOutline(room)),
  })),
)
</script>

<template>
  <g pointer-events="none">
    <path
      v-for="ghost in ghosts"
      :key="ghost.id"
      :d="ghost.band"
      fill-rule="evenodd"
      fill="#394455"
      opacity="0.28"
    />
    <!-- The centreline is what actually matters: it is where a riser may pass. -->
    <polygon
      v-for="ghost in ghosts"
      :key="`c-${ghost.id}`"
      :points="ghost.centreline"
      fill="none"
      stroke="#7c8798"
      :stroke-width="1.2 * plan.mmPerPx"
      stroke-dasharray="180 140"
      opacity="0.5"
    />
  </g>
</template>
