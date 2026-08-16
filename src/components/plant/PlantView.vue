<script setup lang="ts">
/**
 * The plant room — the heat pump and everything piped to it, on its own screen.
 *
 * The plan answers "where does this pipe run". This answers the question the plan cannot: what
 * has to be *in* the room for the thing to work, in what order the water meets it, and why
 * each piece is there. A heat pump plant fails in ways a drawing of its pipework does not
 * show — a defrost with nothing to draw heat from, a cylinder coil too small to take the
 * unit's output, a store held at a temperature Legionella enjoys — so every line carries the
 * reason it exists next to the size it is.
 *
 * Everything here is derived from the solve. The duty is what the floor actually gives, the
 * water content is measured off the coils the router laid, and the pump duties are the ones
 * the heating solver worked out for each manifold. Nothing is typed in twice.
 */
import { computed } from 'vue'

import { designPlant, type PlantStage } from '../../domain/plant.ts'
import { DESIGN_OUTDOOR_C } from '../../domain/standards/heatpump.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import PlantElevation from './PlantElevation.vue'
import PlantSchematic from './PlantSchematic.vue'
import WaterSchematic from './WaterSchematic.vue'

const projectStore = useProjectStore()
const routing = useRoutingStore()

const design = computed(() => designPlant(projectStore.project, routing.result))

const STAGE_LABEL: Record<PlantStage, string> = {
  outdoor: 'Outside, and through the wall',
  source: 'At the unit',
  protection: 'Protecting the unit',
  safety: 'The sealed side',
  buffer: 'Volume and decoupling',
  hotwater: 'The store',
  coldfeed: 'The cold main into the store',
  recirculation: 'Keeping the taps hot',
  circuit: 'Out to the floors',
  controls: 'Controls',
  finishing: 'Filling, draining and finishing',
}

const STAGE_ORDER: PlantStage[] = [
  'outdoor',
  'source',
  'protection',
  'safety',
  'buffer',
  'hotwater',
  'coldfeed',
  'recirculation',
  'circuit',
  'controls',
  'finishing',
]

/** The schedule, grouped the way the water meets it. */
const groups = computed(() =>
  STAGE_ORDER.map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    items: design.value.components.filter((component) => component.stage === stage),
  })).filter((group) => group.items.length > 0),
)

/** The balloon this component carries on the elevation, where it has one. */
const tagOf = (componentId: string): number | null =>
  design.value.arrangement.find((item) => item.componentId === componentId)?.tag ?? null

const severityClass = (severity: string): string =>
  severity === 'error'
    ? 'border-red-900/60 bg-red-950/30 text-red-200'
    : severity === 'warning'
      ? 'border-amber-900/60 bg-amber-950/25 text-amber-200'
      : 'border-ink-700 bg-ink-850 text-ink-300'
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto bg-ink-950">
    <!-- Summary strip: the numbers you check before looking at anything else. -->
    <div class="flex flex-wrap gap-x-7 gap-y-3 border-b border-ink-800 bg-ink-900 px-4 py-3">
      <div class="min-w-[11rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Plant room</div>
        <div class="text-ink-100">
          {{ design.room ? design.room.name : 'not placed' }}
          <span v-if="design.room" class="numeric text-ink-400">
            · {{ design.room.areaM2.toFixed(1) }} m²
          </span>
        </div>
        <div v-if="design.room" class="numeric text-[10px] text-ink-400">
          {{ design.room.levelName }} ·
          {{ design.hasExternalWall ? 'on the facade' : 'no external wall' }} ·
          {{ design.hasFloorDrain ? 'drained' : 'no drain' }}
        </div>
      </div>

      <div class="min-w-[10rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Unit</div>
        <div class="numeric text-ink-100">
          {{ design.heatPump.capacityKw }} kW
          <span class="text-ink-400">at {{ DESIGN_OUTDOOR_C }} °C</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          floor gives {{ design.heatPump.demandKw.toFixed(1) }} kW at
          {{ design.heatPump.flowTempC }}/{{ design.heatPump.returnTempC }} °C
        </div>
      </div>

      <div class="min-w-[10rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">System water</div>
        <div
          class="numeric"
          :class="design.water.bufferL > 0 ? 'text-amber-200' : 'text-ink-100'"
        >
          {{ Math.round(design.water.systemL) }} l
          <span class="text-ink-400">/ {{ Math.round(design.water.requiredL) }} l needed</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{
            design.water.bufferL > 0
              ? `${design.water.bufferL} l buffer makes it up`
              : 'the floor holds enough for a defrost'
          }}
        </div>
      </div>

      <div class="min-w-[9rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Hot water</div>
        <div class="numeric text-ink-100">
          {{ design.cylinder.litres }} l
          <span class="text-ink-400">· coil {{ design.cylinder.coilM2.toFixed(1) }} m²</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{ Math.round(design.cylinder.reheatMinutes) }} min from cold ·
          {{ design.cylinder.bathrooms }} bathroom{{ design.cylinder.bathrooms === 1 ? '' : 's' }}
        </div>
      </div>

      <div class="min-w-[9rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Sealed system</div>
        <div class="numeric text-ink-100">
          {{ design.vessel.litres }} l
          <span class="text-ink-400">at {{ design.vessel.prechargeBar.toFixed(1) }} bar</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{ design.vessel.safetyValveBar }} bar relief ·
          {{ Math.round(design.glycolL) }} l glycol
        </div>
      </div>
    </div>

    <!-- The wall first, because it is the drawing you set out from. -->
    <div v-if="design.wall" class="border-b border-ink-800 bg-ink-900 px-4 py-4">
      <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
        The plant wall, to scale
      </h2>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        Looking at the wall the heat source is fixed to, from inside the room. Everything is at
        its catalogue size at its real height, and the numbers are the ones in the schedule
        below. Confirm the sizes against the units actually bought before anything is built.
      </p>
      <PlantElevation :design="design" />
    </div>

    <!-- Two schematics, because they are two circuits. The heating side is sealed, glycol
         filled and relieved at 3 bar; the domestic side is the main, potable and relieved at
         6. All they share is the coil in the cylinder. -->
    <div class="border-b border-ink-800 bg-ink-900 px-4 py-4">
      <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
        Source and heating
      </h2>
      <PlantSchematic :design="design" />
    </div>

    <div class="border-b border-ink-800 bg-ink-900 px-4 py-4">
      <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
        Domestic hot water
      </h2>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        The other circuit. Each stop along the cold feed is there because of the one before it:
        the check valve stops stored hot water pushing back into the main, and having stopped
        it, the expansion has nowhere to go — so the vessel is not optional, and the relief is
        what covers the vessel failing.
      </p>
      <WaterSchematic :design="design" />
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 xl:flex-row">
      <!-- What stands in the room, in the order the water meets it. -->
      <div class="min-w-0 flex-1">
        <h2 class="mb-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          What goes in, and why
        </h2>
        <div v-for="group in groups" :key="group.stage" class="mb-4">
          <div class="mb-1.5 text-[10px] tracking-wide text-ink-400 uppercase">
            {{ group.label }}
          </div>
          <div
            v-for="item in group.items"
            :key="item.id"
            class="mb-1.5 rounded border border-ink-800 bg-ink-900 px-3 py-2"
            :class="item.quantity === 0 ? 'opacity-60' : ''"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-x-3">
              <span class="text-[13px] text-ink-100">
                <span
                  v-if="tagOf(item.id)"
                  class="numeric mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-heating text-[9px] text-heating"
                  >{{ tagOf(item.id) }}</span
                >
                <span v-if="item.quantity > 1" class="numeric text-ink-400">
                  {{ item.quantity }}× </span
                >{{ item.name }}
              </span>
              <span class="numeric text-[11px] text-heating">{{ item.size }}</span>
            </div>
            <div class="text-[10.5px] text-ink-400 italic">{{ item.nameRo }}</div>
            <p class="mt-1 text-[11.5px] leading-relaxed text-ink-400">{{ item.why }}</p>
          </div>
        </div>
      </div>

      <!-- What to watch. -->
      <div class="min-w-0 xl:w-[26rem] xl:shrink-0">
        <h2 class="mb-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          Checks
        </h2>
        <div
          v-for="check in design.checks"
          :key="check.id"
          class="mb-1.5 rounded border px-3 py-2 text-[11.5px] leading-relaxed"
          :class="severityClass(check.severity)"
        >
          {{ check.message }}
        </div>

        <h2 class="mt-5 mb-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          Where the water is
        </h2>
        <dl class="grid grid-cols-2 gap-y-1 rounded border border-ink-800 bg-ink-900 px-3 py-2 text-[11.5px]">
          <dt class="text-ink-400">In the coils and leaders</dt>
          <dd class="numeric text-right text-ink-200">
            {{ design.water.emitterL.toFixed(0) }} l
          </dd>
          <dt class="text-ink-400">In the primary</dt>
          <dd class="numeric text-right text-ink-200">
            {{ design.water.primaryL.toFixed(0) }} l
          </dd>
          <dt class="text-ink-400">In the buffer</dt>
          <dd class="numeric text-right text-ink-200">{{ design.water.bufferL }} l</dd>
          <dt class="border-t border-ink-800 pt-1 text-ink-300">Total fill</dt>
          <dd class="numeric border-t border-ink-800 pt-1 text-right text-ink-100">
            {{ Math.round(design.water.systemL + design.water.bufferL) }} l
          </dd>
        </dl>
        <p class="mt-2 text-[11px] leading-relaxed text-ink-400">
          Measured off the pipe the router actually laid — every metre of coil, leader and
          primary at its own bore — rather than off a rule of thumb per square metre. It is the
          number the buffer, the vessel and the glycol order all come from.
        </p>
      </div>
    </div>
  </div>
</template>
