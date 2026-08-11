<script setup lang="ts">
/**
 * Dimension chains on the selected room's walls.
 *
 * Only the selected (or hovered) room is dimensioned. Showing every wall of every room at
 * once turns the drawing into a wall of numbers, and the number you actually want is always
 * the one on the thing you are working on.
 */
import { computed } from 'vue'

import { wallsOf } from '../../domain/model.ts'
import type { Room } from '../../domain/types.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'
import { labelAngle } from './svg.ts'

const plan = usePlanStore()
const projectStore = useProjectStore()
const selection = useSelectionStore()
const view = useViewStore()

const target = computed<Room | null>(() => {
  const active = selection.current ?? selection.hovered
  if (!active || (active.kind !== 'room' && active.kind !== 'wall')) return null
  return projectStore.project.rooms.find((r) => r.id === active.id) ?? null
})

interface Dim {
  index: number
  x1: number
  y1: number
  x2: number
  y2: number
  tx: number
  ty: number
  angle: number
  text: string
  highlighted: boolean
}

/** Dimension lines are drawn outside the wall so they never sit on top of the drawing. */
const OFFSET = 380

const dimensions = computed<Dim[]>(() => {
  const room = target.value
  if (!room) return []
  const active = selection.current
  const offset = OFFSET + room.wallThickness

  return wallsOf(room).map((wall) => {
    const ox = wall.normal.x * offset
    const oy = wall.normal.y * offset
    const a = { x: wall.a.x + ox, y: wall.a.y + oy }
    const b = { x: wall.b.x + ox, y: wall.b.y + oy }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    return {
      index: wall.index,
      x1: a.x,
      y1: -a.y,
      x2: b.x,
      y2: -b.y,
      tx: mid.x,
      ty: -mid.y,
      angle: labelAngle(wall.dir.x, wall.dir.y),
      text: `${Math.round(wall.length)}`,
      highlighted: active?.kind === 'wall' && active.wallIndex === wall.index,
    }
  })
})

const fontSize = computed(() => 11 * plan.mmPerPx)
const tick = computed(() => 60)
</script>

<template>
  <g v-if="view.showDimensions" pointer-events="none">
    <g v-for="dim in dimensions" :key="dim.index">
      <line
        :x1="dim.x1"
        :y1="dim.y1"
        :x2="dim.x2"
        :y2="dim.y2"
        :stroke="dim.highlighted ? 'var(--color-accent)' : '#7c8798'"
        :stroke-width="1.2 * plan.mmPerPx"
      />
      <circle
        :cx="dim.x1"
        :cy="dim.y1"
        :r="tick"
        :fill="dim.highlighted ? 'var(--color-accent)' : '#7c8798'"
      />
      <circle
        :cx="dim.x2"
        :cy="dim.y2"
        :r="tick"
        :fill="dim.highlighted ? 'var(--color-accent)' : '#7c8798'"
      />
      <text
        :x="dim.tx"
        :y="dim.ty"
        :font-size="fontSize"
        :transform="`rotate(${dim.angle} ${dim.tx} ${dim.ty})`"
        text-anchor="middle"
        :dy="-fontSize * 0.4"
        :fill="dim.highlighted ? 'var(--color-accent)' : '#cbd5e1'"
        class="numeric"
      >
        {{ dim.text }}
      </text>
    </g>
  </g>
</template>
