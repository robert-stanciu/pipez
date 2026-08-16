<script setup lang="ts">
/**
 * The plant wall, to scale, as an elevation you can set out from.
 *
 * The schematics on this page answer *what order* the water meets things in. This one answers
 * the question that actually stops a plant room being built: does it go on the wall. A 250 l
 * heat pump cylinder is 600 across and 1,6 m tall, an 18 l vessel wants a bracket at chest
 * height, and the two of them plus a buffer, two circulators and a safety group have to fit
 * along a wall somebody also has to stand in front of.
 *
 * Drawn from inside the room looking at the wall the heat source is fixed to — which is the
 * wall the flow and return cross, so the outdoor unit is directly behind it and is drawn
 * dashed, the way anything hidden behind the plane of a drawing is. Every item is at its real
 * size, at its real height above the floor, and carries the balloon it is numbered by in the
 * schedule underneath.
 */
import { computed } from 'vue'

import type { PlantDesign } from '../../domain/plant.ts'
import { OUTDOOR_PLINTH_MM, outdoorBulk } from '../../domain/standards/heatpump.ts'
import { SYSTEM_COLOR } from '../../domain/types.ts'

const props = defineProps<{ design: PlantDesign }>()

const FLOW = SYSTEM_COLOR.heating

/** One svg unit is four millimetres, which puts a 4,2 m wall on a screen at a readable size. */
const S = 0.25
const LEFT = 62
const TOP = 44
const BOTTOM = 118

/** Where the flow and return come through, measured along the wall from its start. */
const PENETRATION_MM = 180
const PENETRATION_HEIGHT_MM = 380

const view = computed(() => {
  const wall = props.design.wall
  const lengthMm = wall?.lengthMm ?? 4000
  const heightMm = wall?.heightMm ?? 2600
  return {
    lengthMm,
    heightMm,
    w: lengthMm * S,
    h: heightMm * S,
    width: LEFT + lengthMm * S + 34,
    height: TOP + heightMm * S + BOTTOM,
  }
})

/** Millimetres along the wall, and up from the floor, in drawing coordinates. */
const px = (alongMm: number): number => LEFT + alongMm * S
const py = (upMm: number): number => TOP + (view.value.heightMm - upMm) * S

const outdoor = computed(() => outdoorBulk(props.design.heatPump.capacityKw))

/** Items sorted so the big floor-standing things are drawn behind the small wall gear. */
const items = computed(() =>
  [...props.design.arrangement].sort((a, b) => b.mount.widthMm - a.mount.widthMm),
)

const overruns = computed(
  () => props.design.wall !== null && props.design.wallUsedMm > props.design.wall.lengthMm,
)
</script>

<template>
  <svg
    :viewBox="`0 0 ${view.width} ${view.height}`"
    class="w-full"
    :style="{ maxHeight: `${view.height * 1.1}px` }"
    role="img"
    aria-label="Plant wall elevation"
  >
    <!-- The room: floor, ceiling, and the face of the wall between them. -->
    <rect
      :x="LEFT"
      :y="TOP"
      :width="view.w"
      :height="view.h"
      fill="#11161f"
      stroke="#2a3444"
      stroke-width="2"
    />
    <line
      :x1="LEFT - 22"
      :y1="py(0)"
      :x2="LEFT + view.w + 22"
      :y2="py(0)"
      stroke="#3c4859"
      stroke-width="5"
    />
    <line
      :x1="LEFT - 10"
      :y1="py(view.heightMm)"
      :x2="LEFT + view.w + 10"
      :y2="py(view.heightMm)"
      stroke="#2a3444"
      stroke-width="3"
    />

    <!-- The unit, behind this wall and therefore dashed. It lines up with the penetration
         because the penetration is the reason it is where it is. -->
    <g opacity="0.32">
      <rect
        :x="px(PENETRATION_MM + 120)"
        :y="py(OUTDOOR_PLINTH_MM + outdoor.heightMm)"
        :width="outdoor.widthMm * S"
        :height="outdoor.heightMm * S"
        fill="none"
        :stroke="FLOW"
        stroke-width="2.5"
        stroke-dasharray="9 6"
      />
    </g>

    <!-- Everything that has to be found room for. -->
    <g v-for="item in items" :key="item.componentId">
      <rect
        :x="px(item.atMm)"
        :y="py(item.mount.baseMm + item.mount.heightMm)"
        :width="item.mount.widthMm * S"
        :height="item.mount.heightMm * S"
        rx="3"
        fill="#0a0e14"
        :stroke="item.atMm + item.mount.widthMm > view.lengthMm ? '#ef4444' : FLOW"
        stroke-width="2.5"
      />
      <!-- Its bracket, where it hangs rather than stands. -->
      <line
        v-if="item.mount.baseMm > 0"
        :x1="px(item.atMm + item.mount.widthMm / 2)"
        :y1="py(item.mount.baseMm)"
        :x2="px(item.atMm + item.mount.widthMm / 2)"
        :y2="py(item.mount.baseMm) + 7"
        stroke="#3c4859"
        stroke-width="2.5"
      />
      <circle
        :cx="px(item.atMm + item.mount.widthMm / 2)"
        :cy="py(item.mount.baseMm + item.mount.heightMm / 2)"
        r="10"
        fill="#11161f"
        :stroke="FLOW"
        stroke-width="2"
      />
      <text
        :x="px(item.atMm + item.mount.widthMm / 2)"
        :y="py(item.mount.baseMm + item.mount.heightMm / 2) + 3.5"
        fill="#e6eaf0"
        font-size="11"
        text-anchor="middle"
      >
        {{ item.tag }}
      </text>
    </g>

    <!-- Flow and return through the wall, low, where the buried run comes up to meet them. -->
    <g>
      <circle :cx="px(PENETRATION_MM)" :cy="py(PENETRATION_HEIGHT_MM)" r="7" fill="#11161f" :stroke="FLOW" stroke-width="3" />
      <circle :cx="px(PENETRATION_MM + 110)" :cy="py(PENETRATION_HEIGHT_MM)" r="7" fill="#11161f" :stroke="FLOW" stroke-width="3" />
      <text
        :x="px(PENETRATION_MM + 55)"
        :y="py(PENETRATION_HEIGHT_MM) + 24"
        :fill="FLOW"
        font-size="10"
        text-anchor="middle"
      >
        Ø{{ design.heatPump.pipeOd }} flow &amp; return
      </text>
    </g>

    <!-- Standing height, so the gear is not set out where nobody can reach it. -->
    <line
      :x1="LEFT - 30"
      :y1="py(1800)"
      :x2="LEFT + view.w"
      :y2="py(1800)"
      stroke="#2a3444"
      stroke-width="1.5"
      stroke-dasharray="7 7"
    />
    <text :x="LEFT - 34" :y="py(1800) + 4" fill="#7c8798" font-size="9.5" text-anchor="end">
      1800
    </text>
    <text :x="LEFT - 34" :y="py(0) + 4" fill="#7c8798" font-size="9.5" text-anchor="end">0</text>
    <text
      :x="LEFT - 34"
      :y="py(view.heightMm) + 4"
      fill="#7c8798"
      font-size="9.5"
      text-anchor="end"
    >
      {{ view.heightMm }}
    </text>

    <!-- What the wall is, and what the plant takes of it. -->
    <g :transform="`translate(0 ${TOP + view.h + 34})`">
      <line :x1="LEFT" y1="0" :x2="LEFT + view.w" y2="0" stroke="#3c4859" stroke-width="2" />
      <line :x1="LEFT" y1="-6" :x2="LEFT" y2="6" stroke="#3c4859" stroke-width="2" />
      <line
        :x1="LEFT + view.w"
        y1="-6"
        :x2="LEFT + view.w"
        y2="6"
        stroke="#3c4859"
        stroke-width="2"
      />
      <text :x="LEFT + view.w / 2" y="-8" fill="#7c8798" font-size="10.5" text-anchor="middle">
        {{ view.lengthMm }} mm of wall
      </text>

      <line
        :x1="LEFT"
        y1="20"
        :x2="LEFT + Math.min(design.wallUsedMm, view.lengthMm) * S"
        y2="20"
        :stroke="overruns ? '#ef4444' : FLOW"
        stroke-width="3"
      />
      <text
        :x="LEFT"
        y="38"
        :fill="overruns ? '#ef4444' : '#7c8798'"
        font-size="10.5"
      >
        {{ Math.round(design.wallUsedMm) }} mm set out along it{{
          overruns ? ' — more than there is' : ''
        }}
      </text>
      <text :x="LEFT" y="56" fill="#7c8798" font-size="10.5">
        Dashed: the {{ outdoor.widthMm }} × {{ outdoor.heightMm }} mm unit standing outside on
        a {{ OUTDOOR_PLINTH_MM }} mm plinth, behind this wall and lined up with the penetration.
      </text>
    </g>

    <text :x="LEFT" :y="TOP - 14" fill="#7c8798" font-size="11">
      {{ design.room ? design.room.name : 'plant room' }} — the wall the unit is on the other
      side of, from inside the room
    </text>
  </svg>
</template>
