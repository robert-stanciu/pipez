<script setup lang="ts">
/**
 * One run of scaffold, drawn against the wall it stands on, to scale.
 *
 * The schedule says how many frames. This says where they land — which is the thing that is
 * actually wrong when a scaffold does not work: the top deck a lift short of the eaves, the
 * bays not reaching the corner, the ties landing in a window. Every piece is at its real size at
 * its real height, in the same scale as every other elevation on the page, so two façades can be
 * compared by looking at them.
 *
 * Behind the scaffold is the building: the storey floor lines it passes and the top of the work
 * it has to reach. Where the run does not start at the ground, the terrace it stands on is drawn
 * as the solid line under its feet — that base is a slab somebody has to check, and a drawing
 * that shows the frames starting in mid-air is the honest one.
 */
import { computed } from 'vue'

import { SCAFFOLD_COLOR, type ScaffoldDesign, type ScaffoldRun } from '../../domain/scaffold.ts'
import {
  GUARDRAIL_MM,
  LIFT_MM,
  TIE_HORIZONTAL_MM,
  TIE_VERTICAL_MM,
  TOEBOARD_MM,
} from '../../domain/standards/scaffold.ts'

const props = defineProps<{
  run: ScaffoldRun
  design: ScaffoldDesign
  /** SVG units per millimetre. Shared across the page so the elevations compare. */
  scale: number
}>()

const LEFT = 52
const TOP = 22
const BOTTOM = 40

/** Everything is measured off the run's own base, and drawn from a little below it. */
const bottomZ = computed(() => props.run.baseMm - 500)
const topZ = computed(() => props.run.baseMm + props.run.standingHeightMm + 400)

const view = computed(() => ({
  w: props.run.builtLengthMm * props.scale,
  h: (topZ.value - bottomZ.value) * props.scale,
  width: LEFT + props.run.builtLengthMm * props.scale + 90,
  height: TOP + (topZ.value - bottomZ.value) * props.scale + BOTTOM,
}))

const px = (alongMm: number): number => LEFT + alongMm * props.scale
const py = (z: number): number => TOP + (topZ.value - z) * props.scale

/** Where each frame stands, in millimetres along the run. */
const standards = computed(() => {
  const out = [0]
  let at = 0
  for (const bay of props.run.bays) {
    at += bay
    out.push(at)
  }
  return out
})

const lifts = computed(() =>
  Array.from({ length: props.run.lifts }, (_, index) => props.run.baseMm + (index + 1) * LIFT_MM),
)

/** Which lifts carry a deck: all of them, or the top two moved up as the work rises. */
const decked = computed(() => {
  const all = lifts.value
  return props.design.settings.deckEveryLift ? all : all.slice(-2)
})

/** Braced bays — every bay on the Italian kit, every fifth on a system scaffold. */
const braced = computed(() => {
  const every = props.design.system.bracedEvery
  return props.run.bays
    .map((bay, index) => ({ bay, index, from: standards.value[index], to: standards.value[index + 1] }))
    .filter((entry) => entry.index % every === 0)
})

/**
 * The ties, on the grid the schedule counted them to: every second lift and every 8 m, moved
 * onto the nearest frame because that is the only place a tie can actually be fixed.
 */
const ties = computed(() => {
  const out: { x: number; z: number }[] = []
  const rows = Math.max(1, Math.round((props.run.lifts * LIFT_MM) / TIE_VERTICAL_MM))
  const columns = Math.floor(props.run.builtLengthMm / TIE_HORIZONTAL_MM) + 1
  for (let row = 1; row <= rows; row++) {
    const z = props.run.baseMm + Math.min(row * TIE_VERTICAL_MM, props.run.lifts * LIFT_MM)
    for (let column = 0; column < columns; column++) {
      const wanted = ((column + 0.5) * props.run.builtLengthMm) / columns
      const at = standards.value.reduce((best, s) =>
        Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best,
      )
      out.push({ x: at, z })
    }
  }
  return out
})

/** Storey floors that fall inside what this elevation shows. */
const storeyLines = computed(() =>
  props.design.storeys.filter(
    (storey) => storey.floorMm > props.run.baseMm + 100 && storey.floorMm < topZ.value,
  ),
)

const m = (mm: number): string => (mm / 1000).toFixed(2).replace('.', ',')
</script>

<template>
  <figure class="m-0">
    <figcaption class="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
      <span
        class="numeric inline-flex size-4 items-center justify-center rounded-full border text-[9px]"
        :style="{ borderColor: SCAFFOLD_COLOR, color: SCAFFOLD_COLOR }"
        >{{ run.mark }}</span
      >
      <span class="text-ink-100">{{ run.face }} façade</span>
      <span class="numeric text-ink-400">
        {{ m(run.builtLengthMm) }} × {{ m(run.standingHeightMm) }} m ·
        {{ run.bays.length }} bays × {{ run.lifts }} lifts · {{ Math.round(run.areaM2) }} m²
      </span>
      <span v-if="run.standsOn === 'roof'" class="numeric text-amber-300">
        stands on the terrace at +{{ m(run.baseMm) }}
      </span>
    </figcaption>

    <svg
      :viewBox="`0 0 ${view.width} ${view.height}`"
      class="w-full"
      :style="{ maxHeight: `${view.height * 1.15}px` }"
      role="img"
      :aria-label="`Scaffold elevation ${run.mark}`"
    >
      <!-- The wall behind it, from whatever this run stands on up to the top of the work. -->
      <rect
        :x="px(0)"
        :y="py(run.workTopMm)"
        :width="run.facadeLengthMm * scale"
        :height="(run.workTopMm - bottomZ) * scale"
        fill="#11161f"
        stroke="#2a3444"
        stroke-width="1"
      />
      <line
        v-for="storey in storeyLines"
        :key="storey.id"
        :x1="px(0)"
        :y1="py(storey.floorMm)"
        :x2="px(run.facadeLengthMm)"
        :y2="py(storey.floorMm)"
        stroke="#2a3444"
        stroke-width="1"
        stroke-dasharray="6 5"
      />
      <text
        v-for="storey in storeyLines"
        :key="`${storey.id}-label`"
        :x="px(0) + 5"
        :y="py(storey.floorMm) - 3"
        fill="#5c6879"
        font-size="8.5"
      >
        {{ storey.name }}
      </text>

      <!-- The top of the work: the eaves, the gutter, the last course of insulation. -->
      <line
        :x1="LEFT - 16"
        :y1="py(run.workTopMm)"
        :x2="px(run.builtLengthMm) + 10"
        :y2="py(run.workTopMm)"
        stroke="#7c8798"
        stroke-width="1.2"
        stroke-dasharray="4 4"
      />
      <text :x="px(run.builtLengthMm) + 14" :y="py(run.workTopMm) + 3" fill="#7c8798" font-size="8.5">
        top of work
      </text>

      <!-- What it stands on. -->
      <line
        :x1="LEFT - 16"
        :y1="py(run.baseMm)"
        :x2="px(run.builtLengthMm) + 16"
        :y2="py(run.baseMm)"
        :stroke="run.standsOn === 'roof' ? '#f59e0b' : '#3c4859'"
        stroke-width="3"
      />
      <text :x="LEFT - 20" :y="py(run.baseMm) + 3" fill="#7c8798" font-size="8.5" text-anchor="end">
        {{ run.standsOn === 'roof' ? `+${m(run.baseMm)}` : '0,00' }}
      </text>

      <!-- Braces first, so the frames and decks draw over them. -->
      <g :stroke="SCAFFOLD_COLOR" stroke-width="0.8" opacity="0.45">
        <template v-for="lift in lifts" :key="`brace-${lift}`">
          <template v-for="bay in braced" :key="`${lift}-${bay.index}`">
            <line :x1="px(bay.from)" :y1="py(lift - LIFT_MM)" :x2="px(bay.to)" :y2="py(lift)" />
            <line :x1="px(bay.from)" :y1="py(lift)" :x2="px(bay.to)" :y2="py(lift - LIFT_MM)" />
          </template>
        </template>
      </g>

      <!-- The frames. -->
      <line
        v-for="at in standards"
        :key="`std-${at}`"
        :x1="px(at)"
        :y1="py(run.baseMm)"
        :x2="px(at)"
        :y2="py(run.baseMm + run.deckHeightMm + GUARDRAIL_MM)"
        :stroke="SCAFFOLD_COLOR"
        stroke-width="1.6"
      />

      <!-- Decks, with the toe board and both rails that have to be on every one of them. -->
      <g v-for="lift in lifts" :key="`lift-${lift}`">
        <rect
          v-if="decked.includes(lift)"
          :x="px(0)"
          :y="py(lift) - 2"
          :width="run.builtLengthMm * scale"
          height="3"
          :fill="SCAFFOLD_COLOR"
        />
        <rect
          v-if="decked.includes(lift)"
          :x="px(0)"
          :y="py(lift + TOEBOARD_MM)"
          :width="run.builtLengthMm * scale"
          :height="Math.max(1.5, TOEBOARD_MM * scale)"
          :fill="SCAFFOLD_COLOR"
          fill-opacity="0.35"
        />
        <line
          :x1="px(0)"
          :y1="py(lift + GUARDRAIL_MM)"
          :x2="px(run.builtLengthMm)"
          :y2="py(lift + GUARDRAIL_MM)"
          :stroke="SCAFFOLD_COLOR"
          stroke-width="1"
        />
        <line
          :x1="px(0)"
          :y1="py(lift + GUARDRAIL_MM / 2)"
          :x2="px(run.builtLengthMm)"
          :y2="py(lift + GUARDRAIL_MM / 2)"
          :stroke="SCAFFOLD_COLOR"
          stroke-width="0.7"
          opacity="0.7"
        />
      </g>

      <!-- Ties. The one item that gets left out, so it is drawn rather than counted. -->
      <g v-for="(tie, index) in ties" :key="`tie-${index}`">
        <line
          :x1="px(tie.x)"
          :y1="py(tie.z)"
          :x2="px(tie.x) - 5"
          :y2="py(tie.z)"
          stroke="#f59e0b"
          stroke-width="1.4"
        />
        <circle :cx="px(tie.x)" :cy="py(tie.z)" r="2.6" fill="none" stroke="#f59e0b" stroke-width="1.2" />
      </g>

      <!-- The length, bay by bay, because that is how it gets set out on the ground. -->
      <g :transform="`translate(0 ${TOP + view.h + 16})`">
        <line :x1="px(0)" y1="0" :x2="px(run.builtLengthMm)" y2="0" stroke="#3c4859" stroke-width="1" />
        <g v-for="at in standards" :key="`tick-${at}`">
          <line :x1="px(at)" y1="-4" :x2="px(at)" y2="4" stroke="#3c4859" stroke-width="1" />
        </g>
        <text :x="px(run.builtLengthMm / 2)" y="16" fill="#7c8798" font-size="9" text-anchor="middle">
          {{ run.bays.length }} bays — {{ m(run.builtLengthMm) }} m over
          {{ m(run.facadeLengthMm) }} m of wall<template v-if="run.returnMm > 0">
            + {{ m(run.returnMm) }} m round the corner</template
          >
        </text>
      </g>

      <!-- The height, which is the number an extra lift is argued about in. -->
      <text
        :x="LEFT - 20"
        :y="py(run.baseMm + run.deckHeightMm) + 3"
        fill="#7c8798"
        font-size="8.5"
        text-anchor="end"
      >
        {{ m(run.deckHeightMm) }}
      </text>
    </svg>
  </figure>
</template>
