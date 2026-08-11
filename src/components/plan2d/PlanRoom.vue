<script setup lang="ts">
/** One room: floor, wall band, and a grab strip per wall. */
import { computed } from 'vue'

import { wallsOf, outerOutline } from '../../domain/model.ts'
import type { Room } from '../../domain/types.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'
import { toPoints } from './svg.ts'

const props = defineProps<{ room: Room }>()

const plan = usePlanStore()
const selection = useSelectionStore()
const view = useViewStore()
const projectStore = useProjectStore()

const walls = computed(() => wallsOf(props.room))

/** Wall band drawn as a donut — outer ring minus the inner face, via the even-odd rule. */
const bandPath = computed(
  () => `M ${toPoints(outerOutline(props.room))} Z M ${toPoints(props.room.outline)} Z`,
)

const floorPoints = computed(() => toPoints(props.room.outline))

const isSelected = computed(() => selection.isSelected('room', props.room.id))
const isHovered = computed(
  () => selection.hovered?.kind === 'room' && selection.hovered.id === props.room.id,
)

function grabRoom(event: PointerEvent): void {
  if (view.tool.kind !== 'select' || event.button !== 0) return
  event.stopPropagation()
  selection.select({ kind: 'room', id: props.room.id })
  plan.beginMoveRoom(props.room.id, plan.cursor ?? { x: 0, y: 0 })
}

function grabWall(event: PointerEvent, wallIndex: number): void {
  if (view.tool.kind !== 'select' || event.button !== 0) return
  event.stopPropagation()
  selection.select({ kind: 'wall', id: props.room.id, wallIndex })
  plan.beginPushWall(props.room.id, wallIndex, plan.cursor ?? { x: 0, y: 0 })
}

</script>

<template>
  <g>
    <polygon
      :points="floorPoints"
      :fill="isSelected ? '#1b2a3a' : isHovered ? '#182230' : '#141b26'"
      stroke="none"
      @pointerdown="grabRoom"
      @pointerenter="selection.hover({ kind: 'room', id: room.id })"
      @pointerleave="selection.hover(null)"
    />

    <path :d="bandPath" fill-rule="evenodd" :fill="isSelected ? '#4a5a70' : '#394455'" />

    <!-- Invisible grab strips sit on the wall centrelines; the visible band is not clickable
         so that dragging a wall never fights with dragging the room. -->
    <line
      v-for="wall in walls"
      :key="wall.index"
      :x1="wall.centerA.x"
      :y1="-wall.centerA.y"
      :x2="wall.centerB.x"
      :y2="-wall.centerB.y"
      :stroke="
        selection.isSelected('wall', room.id, wall.index) ? 'var(--color-accent)' : 'transparent'
      "
      :stroke-width="room.wallThickness"
      stroke-linecap="butt"
      :opacity="selection.isSelected('wall', room.id, wall.index) ? 0.5 : 1"
      style="cursor: move"
      @pointerdown="grabWall($event, wall.index)"
      @pointerenter="selection.hover({ kind: 'wall', id: room.id, wallIndex: wall.index })"
      @pointerleave="selection.hover(null)"
    />

    <!-- Load-bearing walls are marked: the router refuses to penetrate them. -->
    <line
      v-for="wall in walls.filter((w) => w.loadBearing)"
      :key="`lb-${wall.index}`"
      :x1="wall.centerA.x"
      :y1="-wall.centerA.y"
      :x2="wall.centerB.x"
      :y2="-wall.centerB.y"
      stroke="#e2e8f0"
      :stroke-width="room.wallThickness * 0.5"
      stroke-dasharray="200 140"
      opacity="0.35"
      pointer-events="none"
    />

    <!-- Openings are drawn as gaps in the band plus a swing indicator. -->
    <g pointer-events="none">
      <template v-for="opening in projectStore.project.openings.filter((o) => o.roomId === room.id)">
        <line
          v-if="walls[opening.wallIndex]"
          :key="opening.id"
          :x1="
            walls[opening.wallIndex].centerA.x +
            walls[opening.wallIndex].dir.x * (opening.offset - opening.width / 2)
          "
          :y1="
            -(
              walls[opening.wallIndex].centerA.y +
              walls[opening.wallIndex].dir.y * (opening.offset - opening.width / 2)
            )
          "
          :x2="
            walls[opening.wallIndex].centerA.x +
            walls[opening.wallIndex].dir.x * (opening.offset + opening.width / 2)
          "
          :y2="
            -(
              walls[opening.wallIndex].centerA.y +
              walls[opening.wallIndex].dir.y * (opening.offset + opening.width / 2)
            )
          "
          :stroke="opening.kind === 'window' ? '#7dd3fc' : '#0a0e14'"
          :stroke-width="room.wallThickness * (opening.kind === 'window' ? 0.4 : 1.05)"
          stroke-linecap="butt"
        />
      </template>
    </g>
  </g>
</template>
