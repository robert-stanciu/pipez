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
  opacity: number
  label: string | null
  midX: number
  midY: number
  angle: number
}

const VERTICAL_THRESHOLD = 20

const strokeFor = (segment: Segment): number =>
  segment.system === 'power' ? 26 : Math.max(24, segment.size * 0.9)

/**
 * What to write along a run.
 *
 * A heating coil is hundreds of metres of one pipe in one size, so stamping the diameter on
 * every leg of it would bury the plan under the same three characters. What is worth naming
 * is where a loop leaves the manifold, and that is the leader.
 */
function labelFor(segment: Segment): string | null {
  if (segment.role === 'loop') return null
  if (segment.system === 'power') return `${segment.size} mm²`
  if (segment.system === 'heating') return `Ø${segment.size}`
  return `DN${segment.size}`
}

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
          // A coil covers the whole floor of a room, so it is drawn back a little: it has to
          // read as a hatch over the room rather than compete with the pipe crossing it.
          opacity: segment.role === 'loop' ? 0.7 : 0.9,
          label: showLabel ? labelFor(segment) : null,
          midX: (segment.a.x + segment.b.x) / 2,
          midY: -(segment.a.y + segment.b.y) / 2,
          angle: labelAngle(dx, dy),
        },
      ]
    }),
  ),
)

/**
 * Elbows, drawn as a tick across the pipe.
 *
 * A swept drainage corner is two 45° bends with a leg between them, so you see two ticks
 * either side of the cut corner — which is exactly what gets ordered and installed. A tick
 * across the run reads as a fitting without competing with the pipe itself for space.
 */
const elbows = computed(() =>
  routing.result.networks
    .filter((network) => view.isSystemVisible(network.system))
    .flatMap((network) =>
      network.fittings.flatMap((fitting) => {
        if (fitting.kind !== 'elbow' || !fitting.dirIn || !fitting.dirOut) return []
        if (!storeyContains(levels.active.value, fitting.position.z, fitting.position.z)) return []

        // Bisector of the turn, in plan. A purely vertical bend has none, and needs no tick.
        const bx = fitting.dirIn.x + fitting.dirOut.x
        const by = fitting.dirIn.y + fitting.dirOut.y
        const length = Math.hypot(bx, by)
        if (length < 1e-6) return []

        const half = Math.max(45, fitting.size * 0.8)
        // The tick lies across the run: perpendicular to the bisector.
        const tx = (-by / length) * half
        const ty = (bx / length) * half
        return [
          {
            key: fitting.id,
            system: network.system,
            x1: fitting.position.x - tx,
            y1: -(fitting.position.y - ty),
            x2: fitting.position.x + tx,
            y2: -(fitting.position.y + ty),
          },
        ]
      }),
    ),
)

/**
 * Air admittance valves.
 *
 * Drawn as a ring with an arrow pointing into it, because that is exactly what the valve
 * does: it lets air in when a discharge drags the pressure down, and shuts against anything
 * trying to come the other way. On a plan it needs to be told apart from the stack it sits
 * on at a glance — this is a thing on the wall above the pipe, not another pipe.
 */
const valves = computed(() =>
  routing.result.networks
    .filter((network) => view.isSystemVisible(network.system))
    .flatMap((network) =>
      network.fittings.flatMap((fitting) => {
        if (fitting.kind !== 'aav') return []
        if (!storeyContains(levels.active.value, fitting.position.z, fitting.position.z)) return []
        const radius = Math.max(90, fitting.size * 0.9)
        return [
          {
            key: fitting.id,
            system: network.system,
            x: fitting.position.x,
            y: -fitting.position.y,
            radius,
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
        :opacity="run.opacity"
      />
    </g>

    <line
      v-for="elbow in elbows"
      :key="elbow.key"
      :x1="elbow.x1"
      :y1="elbow.y1"
      :x2="elbow.x2"
      :y2="elbow.y2"
      stroke="#0a0e14"
      stroke-width="26"
      stroke-linecap="round"
      opacity="0.85"
    />

    <!-- The valve at the top of a drain: a ring with the air arrow running into it. -->
    <g v-for="valve in valves" :key="valve.key">
      <circle
        :cx="valve.x"
        :cy="valve.y"
        :r="valve.radius"
        fill="#0a0e14"
        :stroke="SYSTEM_COLOR[valve.system]"
        stroke-width="26"
        opacity="0.95"
      />
      <path
        :d="`M ${valve.x - valve.radius * 1.9} ${valve.y} H ${valve.x - valve.radius * 0.2}
             M ${valve.x - valve.radius * 0.75} ${valve.y - valve.radius * 0.5}
             L ${valve.x - valve.radius * 0.2} ${valve.y}
             L ${valve.x - valve.radius * 0.75} ${valve.y + valve.radius * 0.5}`"
        fill="none"
        :stroke="SYSTEM_COLOR[valve.system]"
        stroke-width="24"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.95"
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
