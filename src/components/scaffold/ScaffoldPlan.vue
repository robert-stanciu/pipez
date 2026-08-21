<script setup lang="ts">
/**
 * The scaffold in plan — where it stands, and how much ground it takes.
 *
 * This is the drawing that answers the question a schedule cannot: does it fit. A scaffold is
 * not a line round the building, it is a metre and a bit of occupied ground outside every wall,
 * and on a Romanian plot that is very often the whole distance to the boundary. Each run is
 * drawn as the band it actually occupies, from its gap off the wall to the outer standard, with
 * the letter it carries on its elevation.
 *
 * The storeys are drawn behind it: the ground floor solid, everything above it as an outline.
 * That is what makes the set-back runs legible — a band drawn over the ground floor's roof
 * rather than out on the grass is a run whose feet are on a terrace, and it is shaded to say so.
 */
import { computed } from 'vue'

import { outerOutline, roomsOnLevel, sortedLevels } from '../../domain/model.ts'
import { bounds, expandBounds, unionBounds } from '../../domain/geometry/polygon.ts'
import { add2, scale2, type Vec2 } from '../../domain/geometry/vec.ts'
import { SCAFFOLD_COLOR, type ScaffoldDesign, type ScaffoldRun } from '../../domain/scaffold.ts'
import type { Project } from '../../domain/types.ts'
import { toPoints } from '../plan2d/svg.ts'

const props = defineProps<{ project: Project; design: ScaffoldDesign }>()

/** Room outlines by storey, ground floor first. */
const storeys = computed(() =>
  sortedLevels(props.project).map((level, index) => ({
    id: level.id,
    name: level.name,
    ground: index === 0,
    outlines: roomsOnLevel(props.project, level.id).map(outerOutline),
  })),
)

/**
 * The ground a run occupies: the strip between its gap off the wall and its outer standard,
 * taken along the run and past the corner where it turns one.
 */
function band(run: ScaffoldRun): Vec2[] {
  const { wallGap, deckWidth } = props.design.settings
  const along = scale2({ x: run.b.x - run.a.x, y: run.b.y - run.a.y }, 1 / Math.max(1, run.facadeLengthMm))
  const inner = scale2(run.normal, wallGap)
  const outer = scale2(run.normal, wallGap + deckWidth)
  const end = add2(run.b, scale2(along, run.builtLengthMm - run.facadeLengthMm))
  return [
    add2(run.a, inner),
    add2(end, inner),
    add2(end, outer),
    add2(run.a, outer),
  ]
}

const midpoint = (run: ScaffoldRun): Vec2 =>
  add2(
    { x: (run.a.x + run.b.x) / 2, y: (run.a.y + run.b.y) / 2 },
    scale2(run.normal, props.design.settings.wallGap + props.design.settings.deckWidth / 2),
  )

const view = computed(() => {
  const shapes = [
    ...storeys.value.flatMap((storey) => storey.outlines),
    ...props.design.runs.map(band),
  ]
  if (shapes.length === 0) return { x: 0, y: 0, w: 1000, h: 1000 }
  const box = expandBounds(unionBounds(shapes.map(bounds)), 1200)
  return {
    x: box.min.x,
    // Plan y is north and SVG y grows down, so the top of the drawing is the largest y.
    y: -box.max.y,
    w: box.max.x - box.min.x,
    h: box.max.y - box.min.y,
  }
})

/** One stroke width that stays sensible whatever the house measures. */
const unit = computed(() => Math.max(view.value.w, view.value.h) / 320)
</script>

<template>
  <svg
    :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`"
    class="w-full"
    style="max-height: 30rem"
    role="img"
    aria-label="Scaffold plan"
  >
    <!-- The building. Ground floor filled, the storeys above it drawn as outlines, because a
         run standing over one of them is standing on its roof. -->
    <g v-for="storey in storeys" :key="storey.id">
      <polygon
        v-for="(outline, index) in storey.outlines"
        :key="index"
        :points="toPoints(outline)"
        :fill="storey.ground ? '#161c27' : 'none'"
        :stroke="storey.ground ? '#3c4859' : '#2a3444'"
        :stroke-width="unit * 0.5"
        :stroke-dasharray="storey.ground ? undefined : `${unit * 2} ${unit * 2}`"
      />
    </g>

    <!-- The scaffold. Runs standing on a roof are hatched rather than solid: they are not on
         the ground and the drawing should not pretend otherwise. -->
    <g v-for="run in design.runs" :key="run.id">
      <polygon
        :points="toPoints(band(run))"
        :fill="SCAFFOLD_COLOR"
        :fill-opacity="run.standsOn === 'roof' ? 0.14 : 0.3"
        :stroke="SCAFFOLD_COLOR"
        :stroke-width="unit * 0.6"
        :stroke-dasharray="run.standsOn === 'roof' ? `${unit * 2.5} ${unit * 1.5}` : undefined"
      />
      <circle
        :cx="midpoint(run).x"
        :cy="-midpoint(run).y"
        :r="unit * 4"
        fill="#0a0e14"
        :stroke="SCAFFOLD_COLOR"
        :stroke-width="unit * 0.6"
      />
      <text
        :x="midpoint(run).x"
        :y="-midpoint(run).y + unit * 1.7"
        fill="#e6eaf0"
        :font-size="unit * 5"
        text-anchor="middle"
      >
        {{ run.mark }}
      </text>
    </g>

    <!-- North, because every façade on this page is named after a compass point. -->
    <g :transform="`translate(${view.x + view.w - unit * 14} ${view.y + unit * 16})`">
      <line :y1="unit * 8" :y2="-unit * 6" stroke="#7c8798" :stroke-width="unit * 0.6" />
      <polygon
        :points="`0,${-unit * 9} ${unit * 2.2},${-unit * 4} ${-unit * 2.2},${-unit * 4}`"
        fill="#7c8798"
      />
      <text :y="unit * 14" :font-size="unit * 5" fill="#7c8798" text-anchor="middle">N</text>
    </g>
  </svg>
</template>
