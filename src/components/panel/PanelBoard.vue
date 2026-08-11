<script setup lang="ts">
/**
 * The consumer unit drawn as the thing on the wall.
 *
 * A single-line diagram answers "what feeds what"; this answers "what will I be looking at
 * when I open the door", which is the question that catches mistakes — a four-pole RCCB where
 * a two-pole one was meant, a row that will not close because it is two modules over, a board
 * whose gear is all on one line.
 *
 * Everything is drawn at true scale in millimetres: a module is 17.5 mm, a rail holds twelve
 * of them, a device front is 85 mm tall. The viewBox does the rest, so the proportions on
 * screen are the proportions in the cupboard.
 */
import { computed } from 'vue'

import { PHASE_COLOUR, PHASE_CORE_NAME } from '../../domain/standards/electrical.ts'
import type { PanelDesign } from '../../domain/types.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import {
  MODULES_PER_ROW,
  MODULE_MM,
  layOutBoard,
  type BoardDevice,
  type PoleLine,
} from './boardLayout.ts'

const props = defineProps<{ panel: PanelDesign }>()

const selection = useSelectionStore()

/* Enclosure geometry, millimetres. */
const FRAME = 9
const SIDE = 16
const TOP = 22
const DEVICE_H = 85
const ROW_PITCH = 110
const RAIL_H = 35
const RAIL_Y = 40
const TERMINAL_H = 15
const TERMINAL_GAP = 8

const RAIL_WIDTH = MODULES_PER_ROW * MODULE_MM
const INNER_LEFT = FRAME + SIDE
const BOARD_WIDTH = 2 * INNER_LEFT + RAIL_WIDTH

/**
 * Core colours, HD 308 S2. The three lines come from the standards module so the board, the
 * plan overlay and the schedule cannot drift apart; neutral blue and the green-yellow of the
 * protective conductor are only ever drawn here.
 */
const NEUTRAL_COLOUR = '#1e6fd9'
const LINE_COLOUR: Record<PoleLine, string> = { ...PHASE_COLOUR, N: NEUTRAL_COLOUR }
const LINE_NAME: Record<PoleLine, string> = { ...PHASE_CORE_NAME, N: 'blue' }

const board = computed(() => layOutBoard(props.panel))
const rowIndexes = computed(() => Array.from({ length: board.value.rows }, (_, i) => i))

const rowY = (row: number) => FRAME + TOP + row * ROW_PITCH
const columnX = (column: number) => INNER_LEFT + column * MODULE_MM

/* A hair of clearance each side, because two devices on a rail never quite touch. */
const deviceX = (device: BoardDevice) => columnX(device.column) + 0.6
const deviceW = (device: BoardDevice) => device.modules * MODULE_MM - 1.2
const deviceMid = (device: BoardDevice) => columnX(device.column) + (device.modules * MODULE_MM) / 2

const terminalsY = computed(() => rowY(board.value.rows - 1) + DEVICE_H + 22)
const boardHeight = computed(
  () => terminalsY.value + 2 * TERMINAL_H + TERMINAL_GAP + FRAME + 8,
)

/** Mounting slots punched along the rail, and the two screws that actually hold it down. */
const RAIL_SLOT_W = 6.5
const railSlots = Array.from(
  { length: Math.floor((BOARD_WIDTH - 2 * FRAME - 12) / 12) },
  (_, i) => FRAME + 6 + i * 12,
)
const railScrews = [
  railSlots[0] + RAIL_SLOT_W / 2,
  railSlots[railSlots.length - 1] + RAIL_SLOT_W / 2,
]

/** Screw positions along a terminal block, spaced like the ways they serve. */
const terminalScrews = computed(() => {
  const first = INNER_LEFT + 12
  const count = Math.max(6, MODULES_PER_ROW * board.value.rows)
  const step = (RAIL_WIDTH - 12) / (count - 1)
  return Array.from({ length: count }, (_, i) => first + i * step)
})

/**
 * The loop wiring from an RCCB down and back up into the left-hand end of its comb.
 *
 * Built here rather than in the template because it is geometry, and because the run only
 * exists for the row the device itself sits on — a group that spills onto the next rail is
 * combed again there.
 */
const combLinks = computed(() => {
  const links: { key: string; d: string; colour: string }[] = []
  for (const comb of board.value.combs) {
    const source = comb.sourceColumn
    if (source === null) continue
    const top = rowY(comb.row)
    const centre = columnX(source) + (comb.sourceModules * MODULE_MM) / 2
    comb.phases.forEach((phase, index) => {
      const spread = index - (comb.phases.length - 1) / 2
      links.push({
        key: `${comb.key}-${phase}`,
        colour: PHASE_COLOUR[phase],
        d:
          `M ${centre + spread * 2.4} ${top + 78}` +
          ` V ${top + DEVICE_H + 7 + index * 2}` +
          ` H ${columnX(comb.fromColumn) + spread * 1.6}` +
          ` V ${top + 6}`,
      })
    })
  }
  return links
})

const isSelected = (device: BoardDevice) =>
  device.circuitId !== null && selection.isSelected('circuit', device.circuitId)

const isHovered = (device: BoardDevice) =>
  device.circuitId !== null &&
  selection.hovered?.kind === 'circuit' &&
  selection.hovered.id === device.circuitId

function enter(device: BoardDevice): void {
  if (device.circuitId) selection.hover({ kind: 'circuit', id: device.circuitId })
}

function leave(device: BoardDevice): void {
  if (isHovered(device)) selection.hover(null)
}

function click(device: BoardDevice): void {
  if (device.circuitId) selection.select({ kind: 'circuit', id: device.circuitId })
}

/**
 * What fits in the label window.
 *
 * A one-module window is 17.5 mm wide and holds a way number, nothing more — which is exactly
 * what the label strip on a real board carries, the name being the schedule's job. Wider gear
 * has room for the name, so it gets it.
 */
function windowText(device: BoardDevice): string {
  if (device.kind === 'blank') return ''
  const chars = Math.floor(deviceW(device) / 2.4)
  if (device.way !== null && chars < 9) return String(device.way)
  const label = device.way !== null ? `${device.way} ${device.label}` : device.label
  if (label.length <= chars) return label
  return `${label.slice(0, Math.max(1, chars - 1))}…`
}

/** Toggle window width: a ganged device gets one lever across all its poles. */
const leverW = (device: BoardDevice) =>
  Math.min(deviceW(device) - 4, 11 + (device.modules - 1) * MODULE_MM)

const leverFill = (device: BoardDevice) =>
  device.kind === 'main' ? '#c0392b' : device.kind === 'rcd' ? '#2b3948' : '#242a31'
</script>

<template>
  <div class="overflow-x-auto">
    <svg
      class="h-auto w-full"
      style="min-width: 420px; max-width: 560px"
      :viewBox="`0 0 ${BOARD_WIDTH} ${boardHeight}`"
      role="img"
      :aria-label="`${panel.name}: ${panel.modulesUsed} of ${panel.enclosureModules} modules over ${board.rows} rows`"
    >
      <defs>
        <linearGradient id="pb-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f3f5f8" />
          <stop offset="0.55" stop-color="#dde2e9" />
          <stop offset="1" stop-color="#bac2cc" />
        </linearGradient>
        <linearGradient id="pb-blank" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#b7bec7" />
          <stop offset="1" stop-color="#8d949e" />
        </linearGradient>
        <linearGradient id="pb-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3d4653" />
          <stop offset="1" stop-color="#212832" />
        </linearGradient>
        <linearGradient id="pb-rail" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#828b96" />
          <stop offset="0.5" stop-color="#5d656f" />
          <stop offset="1" stop-color="#454c55" />
        </linearGradient>
        <!-- Green-yellow, the one colour combination reserved for the protective conductor. -->
        <pattern
          id="pb-pe"
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="7" height="7" fill="#0f9d58" />
          <rect width="3.5" height="7" fill="#efd018" />
        </pattern>
      </defs>

      <!-- Enclosure: pressed steel box, then the aperture the gear sits in. -->
      <rect
        x="0.5"
        y="0.5"
        :width="BOARD_WIDTH - 1"
        :height="boardHeight - 1"
        rx="4"
        fill="url(#pb-steel)"
        stroke="#4a5464"
        stroke-width="1"
      />
      <rect
        :x="FRAME"
        :y="FRAME"
        :width="BOARD_WIDTH - 2 * FRAME"
        :height="boardHeight - 2 * FRAME"
        rx="2"
        fill="#10151d"
        stroke="#525c6b"
        stroke-width="0.6"
      />
      <circle
        v-for="corner in [
          [FRAME / 2 + 1.5, FRAME / 2 + 1.5],
          [BOARD_WIDTH - FRAME / 2 - 1.5, FRAME / 2 + 1.5],
          [FRAME / 2 + 1.5, boardHeight - FRAME / 2 - 1.5],
          [BOARD_WIDTH - FRAME / 2 - 1.5, boardHeight - FRAME / 2 - 1.5],
        ]"
        :key="`screw-${corner[0]}-${corner[1]}`"
        :cx="corner[0]"
        :cy="corner[1]"
        r="1.6"
        fill="#6b7480"
        stroke="#151a22"
        stroke-width="0.3"
      />

      <!-- The engraved plate every board carries. -->
      <text :x="INNER_LEFT" :y="FRAME + 11" font-size="7" font-weight="600" fill="#9aa3b0">
        {{ panel.name }}
      </text>
      <text
        :x="BOARD_WIDTH - INNER_LEFT"
        :y="FRAME + 11"
        text-anchor="end"
        font-size="5.5"
        fill="#6d7787"
        class="numeric"
      >
        {{ panel.supply === 'three-phase' ? '400/230 V 3~ + N + PE' : '230 V 1~ + N + PE' }}
      </text>

      <!--
        DIN rails, top-hat section: a flat face with a lipped flange top and bottom. The gear
        covers all but the ends, which is exactly what you see when you take the cover off.
      -->
      <g v-for="row in rowIndexes" :key="`rail-${row}`">
        <rect
          :x="FRAME + 3"
          :y="rowY(row) + RAIL_Y"
          :width="BOARD_WIDTH - 2 * FRAME - 6"
          :height="RAIL_H"
          fill="url(#pb-rail)"
          stroke="#2b323c"
          stroke-width="0.4"
        />
        <rect
          :x="FRAME + 3"
          :y="rowY(row) + RAIL_Y"
          :width="BOARD_WIDTH - 2 * FRAME - 6"
          height="2.6"
          fill="#9aa3ae"
        />
        <rect
          :x="FRAME + 3"
          :y="rowY(row) + RAIL_Y + RAIL_H - 2.6"
          :width="BOARD_WIDTH - 2 * FRAME - 6"
          height="2.6"
          fill="#3a414a"
        />
        <rect
          v-for="slot in railSlots"
          :key="`slot-${row}-${slot}`"
          :x="slot"
          :y="rowY(row) + RAIL_Y + RAIL_H / 2 - 2"
          :width="RAIL_SLOT_W"
          height="4"
          rx="1"
          fill="#333a44"
        />
        <!-- The rail is screwed to the back plate through the slots at its ends. -->
        <circle
          v-for="end in railScrews"
          :key="`rail-screw-${row}-${end}`"
          :cx="end"
          :cy="rowY(row) + RAIL_Y + RAIL_H / 2"
          r="1.8"
          fill="#8a939e"
          stroke="#2b323c"
          stroke-width="0.35"
        />
      </g>

      <!-- Loop wiring from each RCCB to the comb that feeds its breakers; behind the gear. -->
      <path
        v-for="link in combLinks"
        :key="link.key"
        :d="link.d"
        fill="none"
        :stroke="link.colour"
        stroke-width="1.6"
        stroke-linejoin="round"
      />

      <!-- Devices -->
      <g
        v-for="device in board.devices"
        :key="device.key"
        :style="device.circuitId ? 'cursor: pointer' : ''"
        @mouseenter="enter(device)"
        @mouseleave="leave(device)"
        @click="click(device)"
      >
        <title>{{ device.title }}</title>

        <rect
          :x="deviceX(device)"
          :y="rowY(device.row)"
          :width="deviceW(device)"
          :height="DEVICE_H"
          rx="1.6"
          :fill="device.kind === 'blank' ? 'url(#pb-blank)' : 'url(#pb-front)'"
          stroke="#0a0e14"
          stroke-width="0.4"
        />

        <!-- Ganged poles are separate mouldings tied together, so the seams show. -->
        <line
          v-for="seam in device.modules - 1"
          :key="`seam-${device.key}-${seam}`"
          :x1="columnX(device.column) + seam * MODULE_MM"
          :y1="rowY(device.row) + 1"
          :x2="columnX(device.column) + seam * MODULE_MM"
          :y2="rowY(device.row) + DEVICE_H - 1"
          stroke="#9aa3ad"
          stroke-width="0.35"
        />

        <template v-if="device.kind !== 'blank'">
          <!-- Terminals, top and bottom, coloured by the core that lands in them. -->
          <template v-for="band in [0, 1]" :key="`band-${device.key}-${band}`">
            <rect
              :x="deviceX(device) + 1.4"
              :y="rowY(device.row) + (band === 0 ? 2.5 : DEVICE_H - 12.5)"
              :width="deviceW(device) - 2.8"
              height="10"
              rx="0.8"
              fill="#262c35"
            />
            <g v-for="(line, pole) in device.poleLines" :key="`pole-${device.key}-${band}-${pole}`">
              <rect
                :x="columnX(device.column) + pole * MODULE_MM + 2.6"
                :y="rowY(device.row) + (band === 0 ? 3.6 : DEVICE_H - 11.4)"
                :width="MODULE_MM - 5.2"
                height="7.8"
                rx="0.6"
                :fill="LINE_COLOUR[line]"
              >
                <title>{{ line }} — {{ LINE_NAME[line] }}</title>
              </rect>
              <circle
                :cx="columnX(device.column) + (pole + 0.5) * MODULE_MM"
                :cy="rowY(device.row) + (band === 0 ? 7.5 : DEVICE_H - 7.5)"
                r="2.4"
                fill="#aeb6c0"
                stroke="#5a626c"
                stroke-width="0.3"
              />
            </g>
          </template>

          <!-- Label window: the strip you write the way number on. -->
          <rect
            :x="deviceX(device) + 1.4"
            :y="rowY(device.row) + 15"
            :width="deviceW(device) - 2.8"
            height="8"
            rx="0.6"
            fill="#fbfcfd"
            stroke="#a9b1bb"
            stroke-width="0.3"
          />
          <text
            :x="deviceMid(device)"
            :y="rowY(device.row) + 21"
            text-anchor="middle"
            font-size="4.6"
            fill="#2b3038"
          >
            {{ windowText(device) }}
          </text>

          <!-- Toggle, drawn closed. -->
          <rect
            :x="deviceMid(device) - leverW(device) / 2"
            :y="rowY(device.row) + 27"
            :width="leverW(device)"
            :height="device.kind === 'rcd' ? 20 : 23"
            rx="1"
            fill="#3a414b"
          />
          <rect
            :x="deviceMid(device) - leverW(device) / 2 + 1.4"
            :y="rowY(device.row) + 28.6"
            :width="leverW(device) - 2.8"
            :height="device.kind === 'rcd' ? 9 : 10"
            rx="0.8"
            :fill="leverFill(device)"
            stroke="#12161c"
            stroke-width="0.3"
          />
          <!-- Closed: the lever stands at I, and the flag under it shows red. -->
          <rect
            :x="deviceMid(device) - 3"
            :y="rowY(device.row) + (device.kind === 'rcd' ? 40 : 42)"
            width="6"
            height="3"
            rx="0.6"
            fill="#c0392b"
          />
          <text
            :x="deviceMid(device)"
            :y="rowY(device.row) + (device.kind === 'rcd' ? 39 : 41)"
            text-anchor="middle"
            font-size="3.6"
            fill="#c8cfd8"
          >
            I
          </text>

          <!-- The test button is what makes an RCCB an RCCB at a glance. -->
          <template v-if="device.kind === 'rcd'">
            <rect
              :x="deviceMid(device) - 4"
              :y="rowY(device.row) + 50"
              width="8"
              height="8"
              rx="1"
              fill="#4e5661"
              stroke="#2b3038"
              stroke-width="0.4"
            />
            <text
              :x="deviceMid(device)"
              :y="rowY(device.row) + 56.2"
              text-anchor="middle"
              font-size="5"
              font-weight="700"
              fill="#eef1f5"
            >
              T
            </text>
          </template>

          <!-- Printed markings. -->
          <text
            :x="deviceMid(device)"
            :y="rowY(device.row) + (device.kind === 'rcd' ? 66 : 64)"
            text-anchor="middle"
            :font-size="device.modules > 1 ? 8 : 7"
            font-weight="700"
            fill="#1d232c"
            class="numeric"
          >
            {{ device.marking }}
          </text>
          <text
            v-if="device.note"
            :x="deviceMid(device)"
            :y="rowY(device.row) + 71"
            text-anchor="middle"
            font-size="4.4"
            fill="#4b5563"
            class="numeric"
          >
            {{ device.note }}
          </text>
        </template>

        <!-- Blanking plates: the moulded groove is all there is to see. -->
        <line
          v-else
          :x1="deviceX(device) + 3"
          :y1="rowY(device.row) + DEVICE_H / 2"
          :x2="deviceX(device) + deviceW(device) - 3"
          :y2="rowY(device.row) + DEVICE_H / 2"
          stroke="#7b838d"
          stroke-width="0.6"
        />

        <!-- Selection and hover, shared with the schedule. -->
        <rect
          v-if="isSelected(device) || isHovered(device) || device.overDrop"
          :x="deviceX(device) - 1"
          :y="rowY(device.row) - 1"
          :width="deviceW(device) + 2"
          :height="DEVICE_H + 2"
          rx="2.4"
          fill="none"
          :stroke="
            isSelected(device)
              ? 'var(--color-accent)'
              : isHovered(device)
                ? '#9fd8f0'
                : 'var(--color-power)'
          "
          :stroke-width="isSelected(device) ? 2 : 1.4"
        />
      </g>

      <!--
        Comb busbars: an insulated bar lying across the incoming terminals with a pin dropped
        into each pole it feeds, which is how a row of breakers behind one RCCB is bridged.
      -->
      <g v-for="comb in board.combs" :key="comb.key">
        <rect
          :x="columnX(comb.fromColumn) + 0.6"
          :y="rowY(comb.row) + 1.4"
          :width="(comb.toColumn - comb.fromColumn) * MODULE_MM - 1.2"
          height="5.2"
          rx="1.6"
          fill="#414954"
          stroke="#161c25"
          stroke-width="0.35"
        />
        <rect
          :x="columnX(comb.fromColumn) + 1.6"
          :y="rowY(comb.row) + 2.2"
          :width="(comb.toColumn - comb.fromColumn) * MODULE_MM - 3.2"
          height="1.2"
          rx="0.6"
          fill="#5d6674"
        />
        <template v-for="pin in comb.pins" :key="`pin-${comb.key}-${pin.column}`">
          <rect
            v-for="(phase, index) in pin.phases"
            :key="`pin-${comb.key}-${pin.column}-${phase}`"
            :x="columnX(pin.column) + (index + 0.5) * MODULE_MM - 2"
            :y="rowY(comb.row) + 4"
            width="4"
            height="7"
            rx="0.8"
            :fill="PHASE_COLOUR[phase]"
            stroke="#161c25"
            stroke-width="0.3"
          />
        </template>
      </g>

      <!-- Neutral and earth terminal blocks along the bottom. -->
      <g v-for="(bar, index) in ['N', 'PE']" :key="bar">
        <rect
          :x="FRAME + 6"
          :y="terminalsY + index * (TERMINAL_H + TERMINAL_GAP)"
          :width="BOARD_WIDTH - 2 * (FRAME + 6)"
          :height="TERMINAL_H"
          rx="1.5"
          fill="#1a202a"
          stroke="#39424f"
          stroke-width="0.5"
        />
        <rect
          :x="FRAME + 6"
          :y="terminalsY + index * (TERMINAL_H + TERMINAL_GAP)"
          width="15"
          :height="TERMINAL_H"
          rx="1.5"
          :fill="index === 0 ? NEUTRAL_COLOUR : 'url(#pb-pe)'"
        />
        <text
          :x="FRAME + 13.5"
          :y="terminalsY + index * (TERMINAL_H + TERMINAL_GAP) + TERMINAL_H / 2 + 2.2"
          text-anchor="middle"
          font-size="5.5"
          font-weight="700"
          :fill="index === 0 ? '#eef1f5' : '#123018'"
        >
          {{ bar }}
        </text>
        <circle
          v-for="x in terminalScrews"
          :key="`${bar}-${x}`"
          :cx="x"
          :cy="terminalsY + index * (TERMINAL_H + TERMINAL_GAP) + TERMINAL_H / 2"
          r="2.6"
          fill="#aeb6c0"
          stroke="#5a626c"
          stroke-width="0.35"
        />
        <line
          :x1="FRAME + 22"
          :y1="terminalsY + index * (TERMINAL_H + TERMINAL_GAP) + TERMINAL_H - 1.6"
          :x2="BOARD_WIDTH - FRAME - 8"
          :y2="terminalsY + index * (TERMINAL_H + TERMINAL_GAP) + TERMINAL_H - 1.6"
          :stroke="index === 0 ? NEUTRAL_COLOUR : '#0f9d58'"
          stroke-width="1"
        />
      </g>
    </svg>
  </div>
</template>
