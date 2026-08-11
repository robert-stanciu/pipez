<script setup lang="ts">
/**
 * The panel view — the boards on their own, away from the plan.
 *
 * Wiring and layout answer different questions. On the plan you want to know where a cable
 * runs; here you want to know what is on which way, behind which device, on which line, and
 * whether the incomer can carry it. Sharing one screen would serve neither.
 *
 * An installation can have more than one enclosure — a main board and a sub-board upstairs is
 * the usual arrangement — and each is read on its own: its own ways, its own rails, its own
 * schedule. The selector picks which one is on the bench.
 */
import { computed, ref } from 'vue'

import { PHASE_COLOUR } from '../../domain/standards/electrical.ts'
import type { Phase } from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import CircuitSchedule from './CircuitSchedule.vue'
import PanelBoard from './PanelBoard.vue'

const routing = useRoutingStore()
const projectStore = useProjectStore()

const panels = computed(() => routing.result.panels)
const electrical = computed(() => projectStore.project.settings.electrical)

/**
 * Which board is on screen.
 *
 * The choice is held as an id and resolved against the current solve, so a re-solve that
 * renames, adds or removes a board never leaves this view pointing at nothing. The main board
 * is the default, because it is the one that exists in every project.
 */
const chosenId = ref<string | null>(null)

const panel = computed(
  () =>
    panels.value.find((board) => board.id === chosenId.value) ??
    panels.value.find((board) => board.isMain) ??
    panels.value[0] ??
    null,
)

const levelName = (levelId: string): string =>
  projectStore.levels.find((level) => level.id === levelId)?.name ?? 'unplaced'

const lines = computed<Phase[]>(() =>
  panel.value?.supply === 'three-phase' ? ['L1', 'L2', 'L3'] : ['L1'],
)

/** Demand against the device that has to carry it, as a percentage. */
const demandHeadroom = computed(() => {
  const design = panel.value
  if (!design) return null
  return (design.maximumDemand / design.mainBreakerAmps) * 100
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto bg-ink-950">
    <!-- With one board a selector would be a control with nothing to choose. -->
    <div
      v-if="panels.length > 1"
      class="flex flex-wrap gap-1.5 border-b border-ink-800 bg-ink-900 px-4 py-2"
    >
      <button
        v-for="board in panels"
        :key="board.id"
        type="button"
        class="rounded border px-2.5 py-1 text-left"
        :class="
          board.id === panel?.id
            ? 'border-accent bg-accent/15 text-ink-100'
            : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
        "
        @click="chosenId = board.id"
      >
        <span class="flex items-baseline gap-2">
          <span class="text-[12px]">{{ board.name }}</span>
          <span
            class="rounded-sm px-1 text-[9px] tracking-wide uppercase"
            :class="board.isMain ? 'bg-power/20 text-power' : 'bg-ink-700 text-ink-300'"
          >
            {{ board.isMain ? 'Main' : 'Sub' }}
          </span>
        </span>
        <span class="numeric block text-[10px] text-ink-400">
          {{ levelName(board.levelId) }} · {{ board.ways.length }} ways
        </span>
      </button>
    </div>

    <div v-if="!panel" class="px-6 py-10 text-[13px] leading-relaxed text-ink-400">
      No consumer unit yet. Place one on the plan and add something that draws power, and the
      board will be laid out here.
    </div>

    <template v-else>
      <!-- Summary strip: the numbers you check before looking at anything else. -->
      <div class="flex flex-wrap gap-x-6 gap-y-3 border-b border-ink-800 bg-ink-900 px-4 py-3">
        <div class="min-w-[9rem]">
          <div class="text-[10px] tracking-wide text-ink-400 uppercase">Supply</div>
          <div class="numeric text-ink-100">
            {{
              panel.supply === 'three-phase'
                ? `${electrical.lineVoltage} V 3~ + N`
                : `${electrical.voltage} V 1~`
            }}
          </div>
        </div>

        <div class="min-w-[8rem]">
          <div class="text-[10px] tracking-wide text-ink-400 uppercase">
            {{ panel.isMain ? 'Main switch' : 'Isolator' }}
          </div>
          <div class="numeric text-ink-100">
            {{ panel.mainBreakerAmps }} A
            <span class="text-ink-400">· {{ panel.mainSwitchModules }}P</span>
          </div>
        </div>

        <div class="min-w-[10rem]">
          <div class="text-[10px] tracking-wide text-ink-400 uppercase">Maximum demand</div>
          <div
            class="numeric"
            :class="
              demandHeadroom !== null && demandHeadroom > 100 ? 'text-red-300' : 'text-ink-100'
            "
          >
            {{ panel.maximumDemand.toFixed(1) }} A
            <span class="text-ink-400">/ line</span>
          </div>
        </div>

        <div v-if="panel.supply === 'three-phase'" class="min-w-[13rem]">
          <div class="text-[10px] tracking-wide text-ink-400 uppercase">
            Line balance · {{ panel.imbalanceAmps.toFixed(1) }} A apart
            <span class="text-ink-600">({{ panel.imbalancePercent.toFixed(0) }}%)</span>
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
            {{ panel.modulesUsed }} of {{ panel.enclosureModules }} modules
            <span class="text-ink-400">· {{ panel.rows }} row{{ panel.rows === 1 ? '' : 's' }}</span>
          </div>
        </div>

        <div class="min-w-[7rem]">
          <div class="text-[10px] tracking-wide text-ink-400 uppercase">Ways</div>
          <div class="numeric text-ink-100">
            {{ panel.ways.length }}
            <span class="text-ink-400">
              · {{ panel.rcdGroups.length }} RCD{{ panel.rcdGroups.length === 1 ? '' : 's' }}
            </span>
          </div>
        </div>

        <!-- A sub-board is only as good as the cable that reaches it. -->
        <div v-if="!panel.isMain" class="min-w-[10rem]">
          <div class="text-[10px] tracking-wide text-ink-400 uppercase">Submain</div>
          <div class="numeric text-ink-100">
            {{ panel.submainMm2 === null ? '—' : `${panel.submainMm2} mm²` }}
            <span class="text-ink-400">· {{ (panel.submainLength / 1000).toFixed(1) }} m</span>
          </div>
        </div>
      </div>

      <section class="border-b border-ink-800 px-4 py-4">
        <h3 class="mb-3 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          {{ panel.name }} · {{ levelName(panel.levelId) }}
        </h3>
        <PanelBoard :panel="panel" />
      </section>

      <section class="min-h-0 flex-1 px-4 py-4">
        <h3 class="mb-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          Circuit schedule
        </h3>
        <CircuitSchedule :panel="panel" />
      </section>
    </template>
  </div>
</template>
