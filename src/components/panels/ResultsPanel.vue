<script setup lang="ts">
/** Solver output: what is visible, what is wrong, and what it would take to build. */
import { computed } from 'vue'

import {
  SYSTEM_COLOR,
  SYSTEM_KINDS,
  SYSTEM_LABEL,
  type BomLine,
  type ConnectionEntry,
  type DrainageStrategy,
} from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'
import PanelSection from '../ui/PanelSection.vue'

const routing = useRoutingStore()
const view = useViewStore()
const projectStore = useProjectStore()
const selection = useSelectionStore()

const SEVERITY_STYLE = {
  error: 'border-red-900/70 bg-red-950/40 text-red-200',
  warning: 'border-amber-900/70 bg-amber-950/30 text-amber-200',
  info: 'border-ink-700 bg-ink-850 text-ink-300',
} as const

const bomBySystem = computed(() => {
  const groups = new Map<string, BomLine[]>()
  for (const line of routing.result.bom) {
    const list = groups.get(line.system)
    if (list) list.push(line)
    else groups.set(line.system, [line])
  }
  return [...groups.entries()]
})

const totals = computed(() =>
  SYSTEM_KINDS.map((system) => ({
    system,
    metres: routing.totalLengthFor(system) / 1000,
  })).filter((entry) => entry.metres > 0),
)

function focusWarning(fixtureId?: string): void {
  if (fixtureId) selection.select({ kind: 'fixture', id: fixtureId })
}
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <PanelSection title="Systems">
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-300">Show networks</span>
        <input v-model="view.showNetworks" type="checkbox" class="size-4 accent-[var(--color-accent)]" />
      </label>
      <div class="mt-1 flex flex-col gap-1">
        <label
          v-for="entry in SYSTEM_KINDS"
          :key="entry"
          class="flex cursor-pointer items-center justify-between rounded px-1 py-1 hover:bg-ink-850"
        >
          <span class="flex items-center gap-2">
            <input
              type="checkbox"
              class="size-3.5"
              :style="{ accentColor: SYSTEM_COLOR[entry] }"
              :checked="view.visibleSystems.has(entry)"
              @change="view.toggleSystem(entry)"
            />
            <span class="inline-block size-2.5 rounded-sm" :style="{ background: SYSTEM_COLOR[entry] }" />
            <span class="text-ink-300">{{ SYSTEM_LABEL[entry] }}</span>
          </span>
          <span class="numeric text-[11px] text-ink-400">
            {{ (routing.totalLengthFor(entry) / 1000).toFixed(1) }} m
          </span>
        </label>
      </div>

      <div class="mt-3 flex flex-col gap-1 border-t border-ink-800 pt-2">
        <label class="flex items-center justify-between py-0.5">
          <span class="text-ink-400">Dimensions</span>
          <input v-model="view.showDimensions" type="checkbox" class="size-4 accent-[var(--color-accent)]" />
        </label>
        <label class="flex items-center justify-between py-0.5">
          <span class="text-ink-400">Fixtures</span>
          <input v-model="view.showFixtures" type="checkbox" class="size-4 accent-[var(--color-accent)]" />
        </label>
        <label class="flex items-center justify-between py-0.5">
          <span class="text-ink-400">See-through walls (3D)</span>
          <input v-model="view.xray" type="checkbox" class="size-4 accent-[var(--color-accent)]" />
        </label>
        <label class="flex items-center justify-between py-0.5">
          <span class="text-ink-400">Only this storey (3D)</span>
          <input
            v-model="view.isolateLevel"
            type="checkbox"
            class="size-4 accent-[var(--color-accent)]"
          />
        </label>
      </div>
    </PanelSection>

    <PanelSection title="Checks" :badge="routing.warnings.length">
      <p v-if="routing.warnings.length === 0" class="py-1 text-[12px] text-ink-400">
        No problems found. Every fixture is connected and every run is within the standard.
      </p>
      <ul v-else class="flex flex-col gap-1.5">
        <li
          v-for="warning in routing.warnings"
          :key="warning.id"
          class="cursor-pointer rounded border px-2 py-1.5 text-[11px] leading-relaxed"
          :class="SEVERITY_STYLE[warning.severity]"
          @click="focusWarning(warning.fixtureId)"
        >
          <span class="font-semibold uppercase opacity-70">{{ SYSTEM_LABEL[warning.system] }}</span>
          <p class="mt-0.5">{{ warning.message }}</p>
        </li>
      </ul>
    </PanelSection>

    <PanelSection v-if="routing.result.circuits.length" title="Circuits" :badge="routing.result.circuits.length">
      <ul class="flex flex-col gap-1">
        <li
          v-for="circuit in routing.result.circuits"
          :key="circuit.id"
          class="flex items-center justify-between gap-2 rounded bg-ink-850 px-2 py-1.5"
        >
          <span class="truncate text-ink-200">{{ circuit.name }}</span>
          <span class="numeric shrink-0 text-[11px] text-ink-400">
            {{ circuit.breakerAmps }} A · {{ circuit.cableMm2 }} mm²
          </span>
        </li>
      </ul>
    </PanelSection>

    <PanelSection title="Bill of materials" :badge="routing.result.bom.length">
      <div v-if="routing.result.bom.length === 0" class="py-1 text-[12px] text-ink-400">
        Nothing routed yet.
      </div>
      <div v-for="[system, lines] in bomBySystem" :key="system" class="mb-3 last:mb-0">
        <h4 class="mb-1 flex items-center gap-2 text-[11px] font-semibold text-ink-300">
          <span
            class="inline-block size-2 rounded-sm"
            :style="{ background: SYSTEM_COLOR[system as keyof typeof SYSTEM_COLOR] }"
          />
          {{ SYSTEM_LABEL[system as keyof typeof SYSTEM_LABEL] }}
        </h4>
        <table class="w-full text-[11px]">
          <tbody>
            <tr v-for="line in lines" :key="line.item" class="border-b border-ink-850 last:border-0">
              <td class="py-0.5 pr-2 text-ink-300">{{ line.item }}</td>
              <td class="numeric py-0.5 text-right whitespace-nowrap text-ink-100">
                {{ line.quantity }} {{ line.unit }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="totals.length" class="mt-2 border-t border-ink-800 pt-2 text-[11px] text-ink-400">
        {{ totals.map((t) => `${SYSTEM_LABEL[t.system]} ${t.metres.toFixed(1)} m`).join(' · ') }}
      </p>
    </PanelSection>

    <PanelSection title="Project settings">
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Drain layout</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.drainage.strategy"
          @change="
            projectStore.updateSettings({
              drainage: {
                ...projectStore.project.settings.drainage,
                strategy: ($event.target as HTMLSelectElement).value as DrainageStrategy,
              },
            })
          "
        >
          <option value="rectilinear">Right angles</option>
          <option value="diagonal">Any bearing</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{
          projectStore.project.settings.drainage.strategy === 'diagonal'
            ? 'A horizontal run may head straight for where it drops, at any angle — it is taken only where the length saved beats the extra bends.'
            : 'Every run is parallel to a wall.'
        }}
        Turns sharper than 45° are always built from a pair of 45° bends.
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Appliance entry</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.connectionEntry"
          @change="
            projectStore.updateSettings({
              connectionEntry: ($event.target as HTMLSelectElement).value as ConnectionEntry,
            })
          "
        >
          <option value="bottom">From below</option>
          <option value="back">From behind</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{
          projectStore.project.settings.connectionEntry === 'back'
            ? 'Water and waste go into the wall behind each appliance and drop inside it. Individual appliances can override this.'
            : 'Water and waste drop through the floor beneath each appliance. Individual appliances can override this.'
        }}
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Design fall</span>
        <select
          class="w-24 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.drainage.designSlope"
          @change="
            projectStore.updateSettings({
              drainage: {
                ...projectStore.project.settings.drainage,
                designSlope: Number(($event.target as HTMLSelectElement).value),
              },
            })
          "
        >
          <option :value="0.01">1.0 %</option>
          <option :value="0.015">1.5 %</option>
          <option :value="0.02">2.0 %</option>
          <option :value="0.025">2.5 %</option>
        </select>
      </label>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Grid</span>
        <select
          class="w-24 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.gridPitch"
          @change="
            projectStore.updateSettings({ gridPitch: Number(($event.target as HTMLSelectElement).value) })
          "
        >
          <option :value="10">10 mm</option>
          <option :value="25">25 mm</option>
          <option :value="50">50 mm</option>
          <option :value="100">100 mm</option>
        </select>
      </label>
      <p class="mt-2 text-[11px] leading-relaxed text-ink-400">
        Sizing follows EN 12056-2 for drainage, EN 806-3 for supply, and HD 60364 with
        DIN 18015-3 installation zones for cabling.
      </p>
    </PanelSection>
  </div>
</template>
