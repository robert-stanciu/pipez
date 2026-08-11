<script setup lang="ts">
/**
 * The panel view — the board on its own, away from the plan.
 *
 * Wiring and layout answer different questions. On the plan you want to know where a cable
 * runs; here you want to know what is on which way, behind which device, on which line, and
 * whether the incomer can carry it. Sharing one screen would serve neither.
 */
import { computed } from 'vue'

import { PHASE_COLOUR } from '../../domain/standards/electrical.ts'
import type { Phase } from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import CircuitSchedule from './CircuitSchedule.vue'
import PanelBoard from './PanelBoard.vue'

const routing = useRoutingStore()
const projectStore = useProjectStore()

const panel = computed(() => routing.result.panel)
const electrical = computed(() => projectStore.project.settings.electrical)

const lines = computed<Phase[]>(() =>
  panel.value?.supply === 'three-phase' ? ['L1', 'L2', 'L3'] : ['L1'],
)

const demandHeadroom = computed(() => {
  const design = panel.value
  if (!design) return null
  return (design.maximumDemand / design.mainBreakerAmps) * 100
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto bg-ink-950">
    <!-- Summary strip: the four numbers you check first. -->
    <div class="flex flex-wrap gap-3 border-b border-ink-800 bg-ink-900 px-4 py-3">
      <div class="min-w-[9rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Supply</div>
        <div class="numeric text-ink-100">
          {{
            electrical.supply === 'three-phase'
              ? `${electrical.lineVoltage} V 3~ + N`
              : `${electrical.voltage} V 1~`
          }}
        </div>
      </div>

      <div class="min-w-[10rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Maximum demand</div>
        <div
          class="numeric"
          :class="demandHeadroom !== null && demandHeadroom > 100 ? 'text-red-300' : 'text-ink-100'"
        >
          {{ panel ? `${panel.maximumDemand.toFixed(1)} A` : '—' }}
          <span class="text-ink-400">/ {{ electrical.mainBreakerAmps }} A</span>
        </div>
      </div>

      <div v-if="panel && panel.supply === 'three-phase'" class="min-w-[13rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">
          Line balance · {{ panel.imbalanceAmps.toFixed(1) }} A apart
        </div>
        <div class="mt-1 flex items-end gap-1.5">
          <div v-for="phase in lines" :key="phase" class="flex flex-col items-center gap-0.5">
            <span class="numeric text-[10px] text-ink-300">
              {{ panel.phaseLoad[phase].toFixed(1) }}
            </span>
            <span
              class="w-7 rounded-sm"
              :style="{
                background: PHASE_COLOUR[phase],
                height: `${Math.max(3, (panel.phaseLoad[phase] / Math.max(1, panel.maximumDemand)) * 26)}px`,
              }"
            />
            <span class="text-[9px] text-ink-400">{{ phase }}</span>
          </div>
        </div>
      </div>

      <div class="min-w-[9rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Enclosure</div>
        <div class="numeric text-ink-100">
          {{ panel ? `${panel.modulesUsed} of ${panel.enclosureModules} modules` : '—' }}
          <span v-if="panel" class="text-ink-400">· {{ panel.rows }} row{{ panel.rows === 1 ? '' : 's' }}</span>
        </div>
      </div>

      <div class="min-w-[7rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Ways</div>
        <div class="numeric text-ink-100">
          {{ panel ? panel.ways.length : 0 }}
          <span v-if="panel" class="text-ink-400">
            · {{ panel.rcdGroups.length }} RCD{{ panel.rcdGroups.length === 1 ? '' : 's' }}
          </span>
        </div>
      </div>
    </div>

    <section class="border-b border-ink-800 px-4 py-4">
      <h3 class="mb-3 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
        Consumer unit
      </h3>
      <PanelBoard />
    </section>

    <section class="min-h-0 flex-1 px-4 py-4">
      <h3 class="mb-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
        Circuit schedule
      </h3>
      <CircuitSchedule />
    </section>
  </div>
</template>
