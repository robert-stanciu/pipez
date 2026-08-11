<script setup lang="ts">
/**
 * The routed networks, projected into the plan.
 *
 * Vertical runs collapse to a point in plan, so they are drawn as a ring rather than a
 * zero-length line — otherwise every drop and riser would simply vanish from the drawing.
 */
import { computed } from 'vue'

import { SYSTEM_COLOR, SYSTEM_KINDS, type Segment, type SystemKind } from '../../domain/types.ts'
import { storeyContains, useLevels } from '../../composables/useLevels.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useViewStore } from '../../stores/view.ts'
import { labelAngle } from './svg.ts'

const plan = usePlanStore()
const routing = useRoutingStore()
const view = useViewStore()
const levels = useLevels()

/**
 * Runs belonging to the storey on screen.
 *
 * Drainage sits just *below* its own floor, so the band reaches down past the slab; runs
 * from other storeys would otherwise pile onto the drawing and make it unreadable.
 */
const onActiveStorey = (segment: Segment): boolean =>
  storeyContains(
    levels.active.value,
    Math.min(segment.a.z, segment.b.z),
    Math.max(segment.a.z, segment.b.z),
  )

interface Run {
  key: string
  system: SystemKind
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  label: string | null
  midX: number
  midY: number
  angle: number
}

const VERTICAL_THRESHOLD = 20

const strokeFor = (segment: Segment): number =>
  segment.system === 'power' ? 26 : Math.max(24, segment.size * 0.9)

const visible = computed(() => SYSTEM_KINDS.filter((s) => view.isSystemVisible(s)))

const runs = computed<Run[]>(() =>
  visible.value.flatMap((system) =>
    routing.segmentsFor(system).filter(onActiveStorey).flatMap((segment) => {
      const dx = segment.b.x - segment.a.x
      const dy = segment.b.y - segment.a.y
      const planLength = Math.hypot(dx, dy)
      if (planLength < VERTICAL_THRESHOLD) return []
      // Label only runs long enough for the text to fit inside them.
      const showLabel = planLength > 40 * plan.mmPerPx && plan.mmPerPx < 12
      return [
        {
          key: segment.id,
          system,
          x1: segment.a.x,
          y1: -segment.a.y,
          x2: segment.b.x,
          y2: -segment.b.y,
          width: strokeFor(segment),
          label: showLabel
            ? system === 'power'
              ? `${segment.size} mm²`
              : `DN${segment.size}`
            : null,
          midX: (segment.a.x + segment.b.x) / 2,
          midY: -(segment.a.y + segment.b.y) / 2,
          angle: labelAngle(dx, dy),
        },
      ]
    }),
  ),
)

/** Risers and drops — the parts of the network that go up or down. */
const verticals = computed(() =>
  visible.value.flatMap((system) =>
    routing.segmentsFor(system).filter(onActiveStorey).flatMap((segment) => {
      const planLength = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
      if (planLength >= VERTICAL_THRESHOLD) return []
      return [
        {
          key: segment.id,
          system,
          x: segment.a.x,
          y: -segment.a.y,
          size: segment.size,
          isStack: segment.role === 'stack',
        },
      ]
    }),
  ),
)
</script>

<template>
  <g v-if="view.showNetworks" pointer-events="none">
    <g v-for="run in runs" :key="run.key">
      <line
        :x1="run.x1"
        :y1="run.y1"
        :x2="run.x2"
        :y2="run.y2"
        :stroke="SYSTEM_COLOR[run.system]"
        :stroke-width="run.width"
        stroke-linecap="round"
        opacity="0.9"
      />
    </g>

    <!-- A drop is a ring; a stack passing through the storey gets a filled centre and a
         cross, the conventional way to say "this continues to the floors above and below". -->
    <g v-for="drop in verticals" :key="drop.key">
      <circle
        :cx="drop.x"
        :cy="drop.y"
        :r="Math.max(drop.isStack ? 70 : 35, drop.size * 0.7)"
        :fill="drop.isStack ? '#0a0e14' : 'none'"
        :stroke="SYSTEM_COLOR[drop.system]"
        :stroke-width="drop.isStack ? 32 : 22"
        opacity="0.95"
      />
      <template v-if="drop.isStack">
        <line
          :x1="drop.x - Math.max(70, drop.size * 0.7) * 0.7"
          :y1="drop.y - Math.max(70, drop.size * 0.7) * 0.7"
          :x2="drop.x + Math.max(70, drop.size * 0.7) * 0.7"
          :y2="drop.y + Math.max(70, drop.size * 0.7) * 0.7"
          :stroke="SYSTEM_COLOR[drop.system]"
          stroke-width="26"
        />
        <line
          :x1="drop.x - Math.max(70, drop.size * 0.7) * 0.7"
          :y1="drop.y + Math.max(70, drop.size * 0.7) * 0.7"
          :x2="drop.x + Math.max(70, drop.size * 0.7) * 0.7"
          :y2="drop.y - Math.max(70, drop.size * 0.7) * 0.7"
          :stroke="SYSTEM_COLOR[drop.system]"
          stroke-width="26"
        />
      </template>
    </g>

    <text
      v-for="run in runs.filter((r) => r.label)"
      :key="`${run.key}-label`"
      :x="run.midX"
      :y="run.midY"
      :font-size="9 * plan.mmPerPx"
      :transform="`rotate(${run.angle} ${run.midX} ${run.midY})`"
      text-anchor="middle"
      dominant-baseline="middle"
      fill="#0a0e14"
      font-weight="600"
      class="numeric"
    >
      {{ run.label }}
    </text>
  </g>
</template>
