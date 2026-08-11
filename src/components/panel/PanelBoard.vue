<script setup lang="ts">
/**
 * The consumer unit as a single-line diagram.
 *
 * Drawn the way a board is actually wired and read: three busbars across the top, the main
 * switch at the left, then each residual current device with its circuits hanging off it.
 * Every breaker is tapped off the bar of the line it sits on, so an unbalanced board is
 * visible at a glance rather than only in a number.
 */
import { computed } from 'vue'

import { PHASE_COLOUR } from '../../domain/standards/electrical.ts'
import type { Phase } from '../../domain/types.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useSelectionStore } from '../../stores/selection.ts'

const routing = useRoutingStore()
const selection = useSelectionStore()

const panel = computed(() => routing.result.panel)

/* Layout is in abstract units; the SVG viewBox scales it to whatever space there is. */
const WAY_WIDTH = 78
const WAY_GAP = 10
const BUS_TOP = 34
const BUS_GAP = 15
const DEVICE_TOP = 150
const DEVICE_HEIGHT = 62

interface Column {
  key: string
  x: number
  width: number
  kind: 'main' | 'rcd' | 'circuit'
  title: string
  subtitle: string
  detail: string
  phases: Phase[]
  circuitId?: string
  overDrop: boolean
}

/** Columns left to right: main switch, then each device followed by what it protects. */
const columns = computed<Column[]>(() => {
  const design = panel.value
  if (!design) return []

  const out: Column[] = []
  let x = 0
  const push = (column: Omit<Column, 'x'>) => {
    out.push({ ...column, x })
    x += column.width + WAY_GAP
  }

  const lines: Phase[] = design.supply === 'three-phase' ? ['L1', 'L2', 'L3'] : ['L1']

  push({
    key: 'main',
    width: WAY_WIDTH * 1.2,
    kind: 'main',
    title: `${design.mainBreakerAmps} A`,
    subtitle: design.supply === 'three-phase' ? 'Main switch 4P' : 'Main switch 2P',
    detail: design.supply === 'three-phase' ? '400 V 3~' : '230 V 1~',
    phases: lines,
    overDrop: false,
  })

  for (const group of design.rcdGroups) {
    push({
      key: `rcd-${group.index}`,
      width: WAY_WIDTH,
      kind: 'rcd',
      title: `${group.sensitivity} mA`,
      subtitle: `RCD ${group.index + 1} · ${group.poles}P`,
      detail: `${group.circuitIds.length} circuits`,
      phases: group.poles === 4 ? lines : lines.slice(0, 1),
      overDrop: false,
    })
    for (const id of group.circuitIds) {
      const way = design.ways.find((w) => w.circuit.id === id)
      if (!way) continue
      const circuit = way.circuit
      push({
        key: circuit.id,
        width: circuit.poles === 3 ? WAY_WIDTH * 1.35 : WAY_WIDTH,
        kind: 'circuit',
        title: `${circuit.breakerAmps} A`,
        subtitle: circuit.name,
        detail: `${circuit.cores} × ${circuit.cableMm2} mm² · ${(circuit.routeLength / 1000).toFixed(1)} m`,
        phases: circuit.phases,
        circuitId: circuit.id,
        overDrop: circuit.voltDropPercent > (circuit.kind === 'lighting' ? 3 : 5),
      })
    }
  }
  return out
})

const busLines = computed<Phase[]>(() =>
  panel.value?.supply === 'three-phase' ? ['L1', 'L2', 'L3'] : ['L1'],
)

const width = computed(() =>
  Math.max(600, columns.value.reduce((max, c) => Math.max(max, c.x + c.width), 0) + WAY_GAP),
)
const height = DEVICE_TOP + DEVICE_HEIGHT + 96

/** Where a column taps the bar of a given line. */
const busY = (phase: Phase) => BUS_TOP + busLines.value.indexOf(phase) * BUS_GAP
</script>

<template>
  <div v-if="!panel" class="px-6 py-10 text-[13px] leading-relaxed text-ink-400">
    No consumer unit yet. Place one on the plan and add something that draws power, and the
    board will be laid out here.
  </div>

  <svg
    v-else
    class="w-full"
    :viewBox="`-40 0 ${width + 56} ${height}`"
    :style="{ maxHeight: `${height * 1.6}px` }"
  >
    <!-- Busbars -->
    <g>
      <template v-for="phase in busLines" :key="phase">
        <line
          :x1="0"
          :y1="busY(phase)"
          :x2="width"
          :y2="busY(phase)"
          :stroke="PHASE_COLOUR[phase]"
          stroke-width="4"
          stroke-linecap="round"
        />
        <text :x="-8" :y="busY(phase) + 4" text-anchor="end" font-size="11" fill="#a8b2c1">
          {{ phase }}
        </text>
      </template>
      <line
        :x1="0"
        :y1="busY(busLines[busLines.length - 1]) + BUS_GAP"
        :x2="width"
        :y2="busY(busLines[busLines.length - 1]) + BUS_GAP"
        stroke="#3b82f6"
        stroke-width="3"
        stroke-dasharray="10 6"
      />
      <text
        :x="-8"
        :y="busY(busLines[busLines.length - 1]) + BUS_GAP + 4"
        text-anchor="end"
        font-size="11"
        fill="#7c8798"
      >
        N
      </text>
    </g>

    <!-- Devices -->
    <g v-for="column in columns" :key="column.key">
      <!-- Tap off each line the device is connected to. -->
      <line
        v-for="phase in column.phases"
        :key="`${column.key}-${phase}`"
        :x1="column.x + column.width / 2"
        :y1="busY(phase)"
        :x2="column.x + column.width / 2"
        :y2="DEVICE_TOP"
        :stroke="PHASE_COLOUR[phase]"
        stroke-width="2.5"
      />

      <rect
        :x="column.x"
        :y="DEVICE_TOP"
        :width="column.width"
        :height="DEVICE_HEIGHT"
        rx="4"
        :fill="column.kind === 'circuit' ? '#161c27' : '#1c2330'"
        :stroke="
          column.circuitId && selection.isSelected('circuit', column.circuitId)
            ? 'var(--color-accent)'
            : column.overDrop
              ? '#f59e0b'
              : '#2a3444'
        "
        stroke-width="1.5"
        :style="column.circuitId ? 'cursor: pointer' : ''"
        @click="column.circuitId && selection.select({ kind: 'circuit', id: column.circuitId })"
      />

      <!-- Phase stripe: the colour of the core that actually lands on this breaker. -->
      <rect
        v-for="(phase, index) in column.phases"
        :key="`stripe-${column.key}-${phase}`"
        :x="column.x + 6 + index * 9"
        :y="DEVICE_TOP + 6"
        width="6"
        height="6"
        rx="1"
        :fill="PHASE_COLOUR[phase]"
        stroke="#0a0e14"
        stroke-width="0.5"
      />

      <text
        :x="column.x + column.width - 6"
        :y="DEVICE_TOP + 15"
        text-anchor="end"
        font-size="13"
        font-weight="600"
        fill="#e6eaf0"
        class="numeric"
      >
        {{ column.title }}
      </text>
      <text :x="column.x + 6" :y="DEVICE_TOP + 32" font-size="9" fill="#a8b2c1">
        {{ column.subtitle.length > 18 ? `${column.subtitle.slice(0, 17)}…` : column.subtitle }}
      </text>
      <text :x="column.x + 6" :y="DEVICE_TOP + 46" font-size="8" fill="#7c8798" class="numeric">
        {{ column.detail }}
      </text>

      <!-- The outgoing run, drawn down out of the board. -->
      <line
        v-if="column.kind === 'circuit'"
        :x1="column.x + column.width / 2"
        :y1="DEVICE_TOP + DEVICE_HEIGHT"
        :x2="column.x + column.width / 2"
        :y2="DEVICE_TOP + DEVICE_HEIGHT + 22"
        :stroke="PHASE_COLOUR[column.phases[0] ?? 'L1']"
        stroke-width="2"
      />
      <circle
        v-if="column.kind === 'circuit'"
        :cx="column.x + column.width / 2"
        :cy="DEVICE_TOP + DEVICE_HEIGHT + 26"
        r="3"
        :fill="PHASE_COLOUR[column.phases[0] ?? 'L1']"
      />
    </g>
  </svg>
</template>
