<script setup lang="ts">
/**
 * The circuit schedule — the table that goes on the wall next to the board it describes.
 *
 * One board, one schedule: a sub-board's ways are numbered from its own way one, and a
 * schedule that mixed two enclosures would be useless to whoever opens either of them.
 */
import { computed } from 'vue'

import {
  CIRCUIT_RULES,
  PHASE_COLOUR,
  PHASE_CORE_NAME,
  VOLT_DROP_LIMIT,
} from '../../domain/standards/electrical.ts'
import type { PanelDesign } from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'

const props = defineProps<{ panel: PanelDesign }>()

const projectStore = useProjectStore()
const selection = useSelectionStore()

const rows = computed(() =>
  props.panel.ways.map((way, index) => {
    const circuit = way.circuit
    const limit =
      (circuit.kind === 'lighting' ? VOLT_DROP_LIMIT.lighting : VOLT_DROP_LIMIT.other) * 100
    return {
      way: index + 1,
      circuit,
      limit,
      overDrop: circuit.voltDropPercent > limit,
      served: circuit.fixtureIds
        .map((id) => projectStore.project.fixtures.find((f) => f.id === id)?.name)
        .filter(Boolean)
        .join(', '),
    }
  }),
)

const isHovered = (circuitId: string) =>
  selection.hovered?.kind === 'circuit' && selection.hovered.id === circuitId
</script>

<template>
  <div v-if="rows.length === 0" class="px-6 py-6 text-[12px] text-ink-400">
    Nothing scheduled yet.
  </div>
  <!-- Wide table, narrow pane: the scroll belongs to the table, never to the page. -->
  <div v-else class="overflow-x-auto">
    <table class="w-full min-w-[54rem] text-[11px]">
      <thead class="sticky top-0 bg-ink-900 text-left text-ink-400">
        <tr class="border-b border-ink-700">
          <th class="py-1.5 pr-2 font-medium">Way</th>
          <th class="py-1.5 pr-2 font-medium">Circuit</th>
          <th class="py-1.5 pr-2 font-medium">Type</th>
          <th class="py-1.5 pr-2 font-medium">Line</th>
          <th class="py-1.5 pr-2 font-medium">Poles</th>
          <th class="py-1.5 pr-2 font-medium">MCB</th>
          <th class="py-1.5 pr-2 font-medium">RCD</th>
          <th class="py-1.5 pr-2 text-right font-medium">Cores</th>
          <th class="py-1.5 pr-2 text-right font-medium">mm²</th>
          <th class="py-1.5 pr-2 text-right font-medium">Length</th>
          <th class="py-1.5 pr-2 text-right font-medium">Load</th>
          <th class="py-1.5 pr-2 text-right font-medium">Design</th>
          <th class="py-1.5 pr-2 text-right font-medium">ΔU</th>
          <th class="py-1.5 font-medium">Serves</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.circuit.id"
          class="cursor-pointer border-b border-ink-850 last:border-0"
          :class="
            selection.isSelected('circuit', row.circuit.id)
              ? 'bg-accent/10'
              : isHovered(row.circuit.id)
                ? 'bg-ink-850'
                : 'hover:bg-ink-850'
          "
          @click="selection.select({ kind: 'circuit', id: row.circuit.id })"
          @mouseenter="selection.hover({ kind: 'circuit', id: row.circuit.id })"
          @mouseleave="selection.hover(null)"
        >
          <td class="numeric py-1 pr-2 text-ink-400">{{ row.way }}</td>
          <td class="py-1 pr-2 text-ink-100">{{ row.circuit.name }}</td>
          <td class="py-1 pr-2 text-ink-400">{{ CIRCUIT_RULES[row.circuit.kind].label }}</td>
          <td class="py-1 pr-2">
            <span class="flex items-center gap-1">
              <span
                v-for="phase in row.circuit.phases"
                :key="phase"
                class="inline-block size-2 rounded-sm"
                :style="{ background: PHASE_COLOUR[phase] }"
                :title="PHASE_CORE_NAME[phase]"
              />
              <span class="numeric text-ink-300">
                {{ row.circuit.poles === 3 ? '3~' : row.circuit.phases[0] }}
              </span>
            </span>
          </td>
          <td class="numeric py-1 pr-2 text-ink-300">{{ row.circuit.poles }}P</td>
          <td class="numeric py-1 pr-2 text-ink-200">{{ row.circuit.breakerAmps }} A</td>
          <td class="numeric py-1 pr-2 text-ink-400">
            {{ row.circuit.rcdProtected ? `#${row.circuit.rcdGroup + 1}` : '—' }}
          </td>
          <td class="numeric py-1 pr-2 text-right text-ink-300">{{ row.circuit.cores }}</td>
          <td class="numeric py-1 pr-2 text-right text-ink-200">{{ row.circuit.cableMm2 }}</td>
          <td class="numeric py-1 pr-2 text-right text-ink-300">
            {{ (row.circuit.routeLength / 1000).toFixed(1) }} m
          </td>
          <td class="numeric py-1 pr-2 text-right text-ink-300">{{ row.circuit.totalWatts }} W</td>
          <td class="numeric py-1 pr-2 text-right text-ink-300">
            {{ row.circuit.designCurrent.toFixed(1) }} A
          </td>
          <td
            class="numeric py-1 pr-2 text-right"
            :class="row.overDrop ? 'text-amber-300' : 'text-ink-300'"
            :title="`Limit ${row.limit}%, assessed at ${row.circuit.assessedCurrent.toFixed(1)} A`"
          >
            {{ row.circuit.voltDropPercent.toFixed(2) }} %
          </td>
          <td class="truncate py-1 text-ink-400">{{ row.served }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
