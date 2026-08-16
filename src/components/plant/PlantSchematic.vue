<script setup lang="ts">
/**
 * The plant room as a hydraulic schematic.
 *
 * Deliberately *not* to scale and deliberately not the plan. A plant room drawn to scale tells
 * you where the cylinder stands; it does not tell you that the dirt separator goes on the
 * return and not the flow, that the vessel hangs off the return and not off the pump's
 * discharge, or that the diverter sends all of the unit at the cylinder rather than sharing it.
 * Those are the things that get built wrong, and a schematic is the drawing that answers them.
 *
 * The topology is fixed because a heat pump plant's topology is fixed — outdoor unit, safety
 * side, diverter, store, buffer, circuits — and only the number of heating circuits varies. So
 * the layout is a handful of constants and one row per manifold, rather than a graph solver
 * for a picture with eight nodes in it.
 */
import { computed } from 'vue'

import type { PlantDesign } from '../../domain/plant.ts'
import { SYSTEM_COLOR } from '../../domain/types.ts'

const props = defineProps<{ design: PlantDesign }>()

/** Flow is the heating colour, return the same hue held back, hot water the hot one. */
const FLOW = SYSTEM_COLOR.heating
const RETURN = '#6b5b95'
const HOT = SYSTEM_COLOR.hot
const COLD = SYSTEM_COLOR.cold

const FACADE_X = 208
const FLOW_Y = 132
const ROW_0 = 300
const ROW_STEP = 108

const layout = computed(() => {
  const circuits = props.design.circuits
  const rows = circuits.map((circuit, i) => ({ circuit, y: ROW_0 + i * ROW_STEP }))
  const lastRow = rows.length > 0 ? rows[rows.length - 1].y : ROW_0
  const returnY = Math.max(lastRow + 86, 396)
  return { rows, returnY, height: returnY + 132, width: 1140 }
})

/** The vessel that sits between the diverter and the circuits, whatever it is called today. */
const vessel = computed(() =>
  props.design.components.find((component) => component.stage === 'buffer' && component.quantity > 0),
)

const litres = (value: number): string => `${Math.round(value)} l`
</script>

<template>
  <svg
    :viewBox="`0 0 ${layout.width} ${layout.height}`"
    class="w-full"
    :style="{ maxHeight: `${layout.height * 0.85}px` }"
    role="img"
    aria-label="Heat pump plant room schematic"
  >
    <defs>
      <marker
        id="plant-arrow-flow"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="5"
        markerHeight="5"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" :fill="FLOW" />
      </marker>
      <marker
        id="plant-arrow-return"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="5"
        markerHeight="5"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" :fill="RETURN" />
      </marker>
    </defs>

    <!-- The facade. Everything left of it is weather; everything right of it is the plant
         room, and the two pipes crossing it are the only things that may. -->
    <line
      :x1="FACADE_X"
      y1="24"
      :x2="FACADE_X"
      :y2="layout.height - 20"
      stroke="#2a3444"
      stroke-width="7"
      stroke-dasharray="14 9"
    />
    <text x="216" y="40" fill="#7c8798" font-size="12" letter-spacing="1.2">PLANT ROOM</text>
    <text x="196" y="40" fill="#7c8798" font-size="12" letter-spacing="1.2" text-anchor="end">
      OUTSIDE
    </text>

    <!-- ------------------------------------------------------ the outdoor unit -->
    <g>
      <rect
        x="24"
        y="88"
        width="150"
        height="112"
        rx="7"
        fill="#11161f"
        :stroke="FLOW"
        stroke-width="3"
      />
      <line x1="44" y1="112" x2="154" y2="112" stroke="#2a3444" stroke-width="3" />
      <line x1="44" y1="126" x2="154" y2="126" stroke="#2a3444" stroke-width="3" />
      <circle cx="99" cy="162" r="24" fill="none" stroke="#3c4859" stroke-width="3" />
      <path d="M 99 145 A 17 17 0 0 1 113 170" fill="none" stroke="#7c8798" stroke-width="3" />
      <text x="99" y="220" fill="#e6eaf0" font-size="13" text-anchor="middle">
        Heat pump {{ design.heatPump.capacityKw }} kW
      </text>
      <text x="99" y="236" fill="#7c8798" font-size="11" text-anchor="middle">
        monobloc · {{ design.heatPump.flowTempC }}/{{ design.heatPump.returnTempC }} °C
      </text>
    </g>

    <!-- ------------------------------------------------------------- the flow main -->
    <path
      :d="`M 174 ${FLOW_Y} H ${vessel ? 620 : 780}`"
      fill="none"
      :stroke="FLOW"
      stroke-width="5"
      marker-end="url(#plant-arrow-flow)"
    />
    <text x="228" y="162" :fill="FLOW" font-size="11">
      Ø{{ design.heatPump.pipeOd }} · {{ Math.round(design.heatPump.flowLh) }} l/h
    </text>

    <!-- Anti-vibration hose: the one thing between a compressor and the building. -->
    <path
      :d="`M 228 ${FLOW_Y} l 6 -9 l 9 18 l 9 -18 l 9 18 l 6 -9`"
      fill="none"
      :stroke="FLOW"
      stroke-width="4"
    />
    <!-- Isolating valve. -->
    <g :transform="`translate(292 ${FLOW_Y})`">
      <path d="M -11 -10 L -11 10 L 0 0 Z M 11 -10 L 11 10 L 0 0 Z" :fill="FLOW" />
    </g>
    <!-- Air separator, with its automatic vent standing on top. -->
    <g :transform="`translate(348 ${FLOW_Y})`">
      <rect x="-14" y="-13" width="28" height="26" rx="4" fill="#11161f" :stroke="FLOW" stroke-width="3" />
      <circle cx="0" cy="-30" r="9" fill="#11161f" :stroke="FLOW" stroke-width="3" />
      <line x1="0" y1="-21" x2="0" y2="-13" :stroke="FLOW" stroke-width="3" />
      <text x="0" y="-26" :fill="FLOW" font-size="10" text-anchor="middle">A</text>
    </g>
    <text x="348" y="72" fill="#7c8798" font-size="10" text-anchor="middle">air</text>

    <!-- --------------------------------------------- the diverter and the cylinder -->
    <g :transform="`translate(452 ${FLOW_Y})`">
      <path d="M -12 -11 L -12 11 L 0 0 Z M 12 -11 L 12 11 L 0 0 Z" :fill="HOT" />
      <path d="M -11 22 L 11 22 L 0 0 Z" :fill="HOT" />
      <rect x="-9" y="-30" width="18" height="12" rx="2" fill="#11161f" :stroke="HOT" stroke-width="2.5" />
    </g>
    <text x="452" y="66" :fill="HOT" font-size="11" text-anchor="middle">3-way</text>
    <text x="452" y="80" fill="#7c8798" font-size="10" text-anchor="middle">DHW priority</text>

    <!-- Down into the store, and back out of its coil to the return. -->
    <path :d="`M 452 ${FLOW_Y + 24} V 250`" fill="none" :stroke="HOT" stroke-width="5" />
    <g>
      <rect x="388" y="250" width="128" height="118" rx="10" fill="#11161f" :stroke="HOT" stroke-width="3" />
      <!-- The coil, which on a heat pump cylinder is most of what you are buying. -->
      <path
        d="M 404 276 q 24 -14 48 0 q 24 14 48 0 M 404 300 q 24 -14 48 0 q 24 14 48 0
           M 404 324 q 24 -14 48 0 q 24 14 48 0 M 404 348 q 24 -14 48 0 q 24 14 48 0"
        fill="none"
        :stroke="HOT"
        stroke-width="3"
        opacity="0.75"
      />
      <text x="452" y="388" fill="#e6eaf0" font-size="12" text-anchor="middle">
        {{ litres(design.cylinder.litres) }} cylinder
      </text>
      <text x="452" y="403" fill="#7c8798" font-size="10.5" text-anchor="middle">
        coil ≥ {{ design.cylinder.coilM2.toFixed(1) }} m² · store {{ 48 }} °C
      </text>
    </g>
    <!-- The store's domestic side is the other drawing: different water, different pressure,
         different relief, and only the coil in common. -->
    <path d="M 388 300 H 336" fill="none" :stroke="COLD" stroke-width="4" stroke-dasharray="8 6" />
    <path d="M 388 266 H 336" fill="none" :stroke="HOT" stroke-width="4" stroke-dasharray="8 6" />
    <text x="330" y="272" fill="#7c8798" font-size="10" text-anchor="end">domestic side</text>
    <text x="330" y="286" fill="#7c8798" font-size="10" text-anchor="end">— see below</text>

    <!-- ------------------------------------------------------- buffer / low-loss header -->
    <template v-if="vessel">
      <rect x="620" y="88" width="112" height="132" rx="8" fill="#11161f" :stroke="FLOW" stroke-width="3" />
      <line x1="620" y1="154" x2="732" y2="154" stroke="#2a3444" stroke-width="2" stroke-dasharray="6 5" />
      <text x="676" y="240" fill="#e6eaf0" font-size="12" text-anchor="middle">
        {{ vessel.name.includes('header') && design.water.bufferL === 0 ? 'Low-loss header' : litres(design.water.bufferL) + ' buffer' }}
      </text>
      <text x="676" y="255" fill="#7c8798" font-size="10.5" text-anchor="middle">
        {{ design.circuits.length }} circuit{{ design.circuits.length === 1 ? '' : 's' }} decoupled
      </text>
    </template>
    <template v-else>
      <text x="676" y="128" fill="#7c8798" font-size="11" text-anchor="middle">no buffer needed</text>
      <text x="676" y="144" fill="#3c4859" font-size="10" text-anchor="middle">
        {{ litres(design.water.systemL) }} in the floor
      </text>
      <path :d="`M 700 ${FLOW_Y} H 780`" fill="none" :stroke="FLOW" stroke-width="5" />
    </template>

    <!-- ---------------------------------------------------------------- the circuits -->
    <g v-for="row in layout.rows" :key="row.circuit.id">
      <!-- Down off the header, through the circulator, out to the manifold. -->
      <path
        :d="`M 780 ${FLOW_Y} V ${row.y} H 816`"
        fill="none"
        :stroke="FLOW"
        stroke-width="5"
      />
      <path
        :d="`M 732 ${FLOW_Y} H 780`"
        v-if="vessel"
        fill="none"
        :stroke="FLOW"
        stroke-width="5"
      />
      <!-- Isolating valve, circulator, check valve: the three things that come as a set,
           because a pump is what gets changed and a stopped pump is a path backwards. -->
      <g :transform="`translate(816 ${row.y})`">
        <path d="M -9 -9 L -9 9 L 0 0 Z M 9 -9 L 9 9 L 0 0 Z" :fill="FLOW" />
      </g>
      <!-- Circulator: the circle with the flag in it, as it is drawn everywhere. -->
      <g :transform="`translate(852 ${row.y})`">
        <circle cx="0" cy="0" r="16" fill="#11161f" :stroke="FLOW" stroke-width="3" />
        <path d="M -6 -8 L 8 0 L -6 8 Z" :fill="FLOW" />
      </g>
      <g :transform="`translate(892 ${row.y})`">
        <path d="M -9 -9 L -9 9 L 0 0 Z M 9 -9 L 9 9 L 0 0 Z" :fill="FLOW" />
        <line x1="9" y1="-11" x2="9" y2="11" :stroke="FLOW" stroke-width="3" />
      </g>
      <path :d="`M 868 ${row.y} H 934`" fill="none" :stroke="FLOW" stroke-width="5" />

      <!-- The manifold, as the comb it is. -->
      <g :transform="`translate(934 ${row.y})`">
        <rect x="0" y="-26" width="94" height="16" rx="4" fill="#11161f" :stroke="FLOW" stroke-width="3" />
        <rect x="0" y="10" width="94" height="16" rx="4" fill="#11161f" :stroke="RETURN" stroke-width="3" />
        <line
          v-for="k in 5"
          :key="k"
          :x1="12 + (k - 1) * 18"
          y1="-10"
          :x2="12 + (k - 1) * 18"
          y2="10"
          stroke="#3c4859"
          stroke-width="3"
        />
        <text x="47" y="-38" fill="#e6eaf0" font-size="11.5" text-anchor="middle">
          {{ row.circuit.name }}
        </text>
        <text x="47" y="46" fill="#7c8798" font-size="10.5" text-anchor="middle">
          {{ row.circuit.loops }} loops · {{ (row.circuit.outputW / 1000).toFixed(1) }} kW
        </text>
      </g>

      <text :x="848" :y="row.y - 26" fill="#7c8798" font-size="10" text-anchor="middle">
        {{ Math.round(row.circuit.flowLh) }} l/h
      </text>
      <text :x="848" :y="row.y + 32" fill="#3c4859" font-size="10" text-anchor="middle">
        {{ (row.circuit.headKpa / 9.81).toFixed(1) }} m
      </text>

      <!-- Back down to the return main. -->
      <path
        :d="`M 1028 ${row.y + 18} V ${layout.returnY}`"
        fill="none"
        :stroke="RETURN"
        stroke-width="5"
      />
    </g>

    <!-- If nothing is heated yet there is still a plant, and it should look like one. -->
    <text
      v-if="layout.rows.length === 0"
      x="900"
      y="300"
      fill="#7c8798"
      font-size="12"
      text-anchor="middle"
    >
      no manifold placed yet
    </text>

    <!-- ------------------------------------------------------------- the return main -->
    <path
      :d="`M 1028 ${layout.returnY} H 174`"
      fill="none"
      :stroke="RETURN"
      stroke-width="5"
      marker-end="url(#plant-arrow-return)"
    />
    <!-- The store's coil rejoins the return, off the side so the label under it stays legible. -->
    <path :d="`M 516 352 H 552 V ${layout.returnY}`" fill="none" :stroke="RETURN" stroke-width="5" />

    <!-- The low point of the whole circuit, which is where it is emptied from. A glycol fill
         is pumped in and has to come out again, and it only comes out of the bottom. -->
    <g :transform="`translate(430 ${layout.returnY})`">
      <path d="M -10 -9 L 10 -9 L 0 2 Z" :fill="RETURN" />
      <path d="M -10 15 L 10 15 L 0 4 Z" :fill="RETURN" />
      <path d="M 0 15 V 26 M -7 26 H 7" :stroke="RETURN" stroke-width="3" fill="none" />
    </g>
    <text x="430" :y="layout.returnY + 46" fill="#7c8798" font-size="10" text-anchor="middle">
      drain
    </text>

    <!-- Dirt separator, on the return and nowhere else: it protects the plate exchanger,
         so it has to be the last thing the water passes before the unit. -->
    <g :transform="`translate(300 ${layout.returnY})`">
      <rect x="-17" y="-15" width="34" height="30" rx="4" fill="#11161f" :stroke="RETURN" stroke-width="3" />
      <path d="M -8 -6 L 8 -6 M -8 0 L 8 0 M -8 6 L 8 6" :stroke="RETURN" stroke-width="2.5" />
      <text x="0" y="34" fill="#7c8798" font-size="10" text-anchor="middle">magnetic</text>
      <text x="0" y="46" fill="#7c8798" font-size="10" text-anchor="middle">separator</text>
    </g>
    <g :transform="`translate(240 ${layout.returnY})`">
      <path d="M -11 -10 L -11 10 L 0 0 Z M 11 -10 L 11 10 L 0 0 Z" :fill="RETURN" />
    </g>

    <!-- Expansion vessel and safety group, both on the return, both below it. -->
    <path :d="`M 620 ${layout.returnY} V ${layout.returnY + 34}`" fill="none" :stroke="RETURN" stroke-width="4" />
    <g :transform="`translate(620 ${layout.returnY + 34})`">
      <rect x="-26" y="0" width="52" height="46" rx="10" fill="#11161f" :stroke="RETURN" stroke-width="3" />
      <line x1="-26" y1="26" x2="26" y2="26" :stroke="RETURN" stroke-width="2.5" stroke-dasharray="5 4" />
      <text x="0" y="64" fill="#e6eaf0" font-size="11" text-anchor="middle">
        {{ litres(design.vessel.litres) }} vessel
      </text>
      <text x="0" y="78" fill="#7c8798" font-size="10" text-anchor="middle">
        {{ design.vessel.prechargeBar.toFixed(1) }} bar pre-charge
      </text>
    </g>

    <path :d="`M 800 ${layout.returnY} V ${layout.returnY + 34}`" fill="none" :stroke="RETURN" stroke-width="4" />
    <g :transform="`translate(800 ${layout.returnY + 34})`">
      <path d="M -11 12 L -11 -8 L 0 2 Z M 11 12 L 11 -8 L 0 2 Z" :fill="RETURN" />
      <path d="M 0 2 L 0 -14 M -8 -14 L 8 -14 M -5 -20 L 5 -20" :stroke="RETURN" stroke-width="2.5" fill="none" />
      <text x="0" y="40" fill="#e6eaf0" font-size="11" text-anchor="middle">
        {{ design.vessel.safetyValveBar }} bar relief
      </text>
      <text x="0" y="54" fill="#7c8798" font-size="10" text-anchor="middle">to the floor drain</text>
    </g>

    <!-- Condensate: outside, and the one pipe here that must not be allowed to freeze. -->
    <path d="M 99 200 V 236" fill="none" :stroke="COLD" stroke-width="0" />
    <path
      :d="`M 24 172 H 8 V ${layout.returnY + 60}`"
      fill="none"
      :stroke="COLD"
      stroke-width="4"
      stroke-dasharray="9 6"
    />
    <text x="14" :y="layout.returnY + 76" :fill="COLD" font-size="10">condensate</text>
  </svg>
</template>
