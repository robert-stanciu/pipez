<script setup lang="ts">
/**
 * The domestic side of the store, as its own schematic.
 *
 * It is drawn apart from the heating one because it *is* apart: different water, different
 * pressure, different relief, and the only thing the two share is the coil in the cylinder.
 * Drawing them together is how the cold feed's check valve and the store's own expansion
 * vessel get left off — they look like duplicates of the heating side's until you notice they
 * are on the other circuit entirely.
 *
 * The chain along the cold feed is the part worth reading. Each item is there because of the
 * one before it: the check valve stops stored hot water pushing back into the main, and having
 * stopped it, the expansion has nowhere to go, so the vessel is no longer optional and the
 * relief is what covers the vessel failing.
 */
import { computed } from 'vue'

import type { PlantDesign } from '../../domain/plant.ts'
import { LEGIONELLA_TEMP_C, STORE_TEMP_C } from '../../domain/standards/heatpump.ts'
import { SYSTEM_COLOR } from '../../domain/types.ts'

const props = defineProps<{ design: PlantDesign }>()

const HOT = SYSTEM_COLOR.hot
const COLD = SYSTEM_COLOR.cold
const RETURN = '#6b5b95'

const FEED_Y = 300
const layout = computed(() => ({
  width: 1140,
  height: props.design.recirculation ? 530 : 400,
}))

/** The cold feed reads left to right; each stop on it is one component. */
const stops = computed(() => {
  const feed = props.design.coldFeed
  const out: Array<{ x: number; kind: 'valve' | 'reducer' | 'check' | 'tee'; label: string; sub: string }> = []
  out.push({ x: 130, kind: 'valve', label: 'isolate', sub: 'Ø22' })
  if (feed.reducedToBar !== null) {
    out.push({ x: 236, kind: 'reducer', label: 'reduce', sub: `${feed.reducedToBar.toFixed(1)} bar` })
  }
  out.push({ x: feed.reducedToBar !== null ? 342 : 260, kind: 'check', label: 'check valve', sub: 'one way only' })
  return out
})

const vesselX = computed(() => (props.design.coldFeed.reducedToBar !== null ? 470 : 400))
const reliefX = computed(() => vesselX.value + 150)
</script>

<template>
  <svg
    :viewBox="`0 0 ${layout.width} ${layout.height}`"
    class="w-full"
    :style="{ maxHeight: `${layout.height * 0.9}px` }"
    role="img"
    aria-label="Domestic hot water schematic"
  >
    <defs>
      <marker
        id="water-arrow"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="5"
        markerHeight="5"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" :fill="COLD" />
      </marker>
      <marker
        id="water-arrow-hot"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="5"
        markerHeight="5"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" :fill="HOT" />
      </marker>
    </defs>

    <!-- --------------------------------------------------------- the cold feed in -->
    <text x="24" y="272" :fill="COLD" font-size="12">cold main</text>
    <text x="24" y="288" fill="#7c8798" font-size="10.5">
      {{ design.coldFeed.mainBar.toFixed(1) }} bar at the entry
    </text>
    <path :d="`M 24 ${FEED_Y} H ${vesselX}`" fill="none" :stroke="COLD" stroke-width="5" />

    <g v-for="stop in stops" :key="stop.x">
      <!-- An isolating valve is a bowtie; a check valve is a bowtie with the disc that only
           lets it one way; a reducer is a valve with its spring drawn on top. -->
      <g :transform="`translate(${stop.x} ${FEED_Y})`">
        <path d="M -12 -11 L -12 11 L 0 0 Z M 12 -11 L 12 11 L 0 0 Z" :fill="COLD" />
        <template v-if="stop.kind === 'check'">
          <line x1="12" y1="-13" x2="12" y2="13" :stroke="COLD" stroke-width="3.5" />
          <path d="M 20 -7 L 30 0 L 20 7" fill="none" :stroke="COLD" stroke-width="3" />
        </template>
        <template v-if="stop.kind === 'reducer'">
          <path d="M 0 -12 L 0 -24 M -8 -24 L 8 -24 M -6 -30 L 6 -30" :stroke="COLD" stroke-width="3" fill="none" />
        </template>
      </g>
      <text :x="stop.x" :y="FEED_Y + 34" fill="#e6eaf0" font-size="10.5" text-anchor="middle">
        {{ stop.label }}
      </text>
      <text :x="stop.x" :y="FEED_Y + 47" fill="#7c8798" font-size="10" text-anchor="middle">
        {{ stop.sub }}
      </text>
    </g>

    <!-- The store's own expansion vessel, hanging off the feed after the check valve. -->
    <path :d="`M ${vesselX} ${FEED_Y} V ${FEED_Y + 62}`" fill="none" :stroke="COLD" stroke-width="4" />
    <g :transform="`translate(${vesselX} ${FEED_Y + 62})`">
      <rect x="-28" y="0" width="56" height="48" rx="11" fill="#11161f" :stroke="COLD" stroke-width="3" />
      <line x1="-28" y1="27" x2="28" y2="27" :stroke="COLD" stroke-width="2.5" stroke-dasharray="5 4" />
      <text x="0" y="66" fill="#e6eaf0" font-size="11" text-anchor="middle">
        {{ design.coldFeed.vesselL }} l vessel
      </text>
      <text x="0" y="79" fill="#7c8798" font-size="10" text-anchor="middle">potable diaphragm</text>
    </g>

    <!-- The relief, which is what covers that vessel failing. -->
    <path :d="`M ${vesselX} ${FEED_Y} H ${reliefX} V ${FEED_Y - 46}`" fill="none" :stroke="COLD" stroke-width="4" />
    <g :transform="`translate(${reliefX} ${FEED_Y - 46})`">
      <path d="M -11 12 L -11 -8 L 0 2 Z M 11 12 L 11 -8 L 0 2 Z" :fill="COLD" />
      <path d="M 0 2 L 0 -14 M -8 -14 L 8 -14 M -5 -20 L 5 -20" :stroke="COLD" stroke-width="2.5" fill="none" />
      <text x="0" y="-32" fill="#e6eaf0" font-size="11" text-anchor="middle">
        {{ design.coldFeed.reliefBar }} bar + T&amp;P
      </text>
      <text x="0" y="-19" fill="#7c8798" font-size="10" text-anchor="middle">to a tundish</text>
    </g>
    <path :d="`M ${reliefX} ${FEED_Y} H 700 V 348`" fill="none" :stroke="COLD" stroke-width="5" />

    <!-- ------------------------------------------------------------------ the store -->
    <g>
      <rect x="700" y="150" width="140" height="200" rx="12" fill="#11161f" :stroke="HOT" stroke-width="3" />
      <path
        d="M 718 200 q 26 -14 52 0 q 26 14 52 0 M 718 228 q 26 -14 52 0 q 26 14 52 0
           M 718 256 q 26 -14 52 0 q 26 14 52 0 M 718 284 q 26 -14 52 0 q 26 14 52 0"
        fill="none"
        :stroke="RETURN"
        stroke-width="3"
        opacity="0.8"
      />
      <!-- The immersion, low in the store where it can lift all of it. -->
      <rect x="716" y="312" width="46" height="12" rx="3" fill="#11161f" stroke="#f59e0b" stroke-width="2.5" />
      <text x="640" y="382" fill="#e6eaf0" font-size="12" text-anchor="middle">
        {{ design.cylinder.litres }} l store
      </text>
      <text x="640" y="396" fill="#7c8798" font-size="10.5" text-anchor="middle">
        {{ STORE_TEMP_C }} °C · coil ≥ {{ design.cylinder.coilM2.toFixed(1) }} m²
      </text>
      <text x="770" y="140" fill="#f59e0b" font-size="10" text-anchor="middle">
        immersion to {{ LEGIONELLA_TEMP_C }} °C weekly
      </text>
    </g>
    <!-- A quarter of a tonne of water leaves through this or through the floor. -->
    <path d="M 770 350 V 372" fill="none" :stroke="COLD" stroke-width="4" />
    <g transform="translate(770 372)">
      <path d="M -10 -9 L 10 -9 L 0 2 Z" :fill="COLD" />
      <path d="M -10 15 L 10 15 L 0 4 Z" :fill="COLD" />
      <path d="M 0 15 V 26 M -7 26 H 7" :stroke="COLD" stroke-width="3" fill="none" />
    </g>
    <text x="792" y="392" fill="#7c8798" font-size="10">drain</text>

    <!-- Cold in at the bottom so it does not stir the store; hot off the top. -->
    <text x="694" y="344" :fill="COLD" font-size="10" text-anchor="end">cold in</text>
    <path d="M 840 178 H 900" fill="none" :stroke="HOT" stroke-width="5" />

    <!-- ---------------------------------------------------- blended, and off to the taps -->
    <g transform="translate(900 178)">
      <path d="M -12 -11 L -12 11 L 0 0 Z M 12 -11 L 12 11 L 0 0 Z" :fill="HOT" />
      <path d="M -11 26 L 11 26 L 0 0 Z" :fill="COLD" />
      <rect x="-9" y="-30" width="18" height="12" rx="2" fill="#11161f" :stroke="HOT" stroke-width="2.5" />
    </g>
    <text x="900" y="130" :fill="HOT" font-size="11" text-anchor="middle">mixing valve</text>
    <text x="900" y="144" fill="#7c8798" font-size="10" text-anchor="middle">blended to 45 °C</text>
    <path d="M 900 204 V 300" fill="none" :stroke="COLD" stroke-width="4" stroke-dasharray="8 6" />
    <text x="908" y="270" :fill="COLD" font-size="10">cold to blend</text>

    <path
      d="M 912 178 H 1060"
      fill="none"
      :stroke="HOT"
      stroke-width="5"
      marker-end="url(#water-arrow-hot)"
    />
    <text x="990" y="160" :fill="HOT" font-size="12" text-anchor="middle">to the taps</text>

    <!-- --------------------------------------------------------- the circulation loop -->
    <template v-if="design.recirculation">
      <!-- Back from the far end of the hot network into a tapping partway up the store, so it
           returns into water it can still warm rather than into the coldest part of it. -->
      <path
        :d="`M 1060 178 V ${layout.height - 70} H 880 V 250 H 846`"
        fill="none"
        :stroke="HOT"
        stroke-width="4"
        opacity="0.75"
        marker-end="url(#water-arrow-hot)"
      />
      <g :transform="`translate(1040 ${layout.height - 70})`">
        <circle cx="0" cy="0" r="15" fill="#11161f" :stroke="HOT" stroke-width="3" />
        <path d="M -5 -7 L 7 0 L -5 7 Z" :fill="HOT" />
      </g>
      <g :transform="`translate(965 ${layout.height - 70})`">
        <path d="M -11 -10 L -11 10 L 0 0 Z M 11 -10 L 11 10 L 0 0 Z" :fill="HOT" />
        <line x1="-11" y1="-12" x2="-11" y2="12" :stroke="HOT" stroke-width="3" />
      </g>
      <g :transform="`translate(900 ${layout.height - 70})`">
        <path d="M -11 -10 L -11 10 L 0 0 Z M 11 -10 L 11 10 L 0 0 Z" :fill="HOT" />
        <path d="M 0 -11 V -22 M -7 -22 H 7" :stroke="HOT" stroke-width="3" fill="none" />
      </g>
      <text :x="1040" :y="layout.height - 44" fill="#e6eaf0" font-size="10.5" text-anchor="middle">
        pump
      </text>
      <text :x="965" :y="layout.height - 44" fill="#e6eaf0" font-size="10.5" text-anchor="middle">
        check
      </text>
      <text :x="900" :y="layout.height - 44" fill="#e6eaf0" font-size="10.5" text-anchor="middle">
        balance
      </text>
      <text :x="900" :y="layout.height - 104" fill="#7c8798" font-size="10.5" text-anchor="middle">
        circulation return — {{ design.recirculation.deadLegs }} outlet{{
          design.recirculation.deadLegs === 1 ? '' : 's'
        }}
        past the dead-leg limit
      </text>
    </template>
    <template v-else>
      <text x="880" y="368" fill="#7c8798" font-size="11" text-anchor="middle">
        no circulation loop — every outlet is inside the dead-leg limit
      </text>
    </template>
  </svg>
</template>
