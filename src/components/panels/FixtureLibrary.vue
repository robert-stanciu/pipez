<script setup lang="ts">
/** Left rail: pick a tool, then click the plan to place. */
import { computed } from 'vue'

import { CATEGORY_LABEL, FIXTURE_LIST } from '../../domain/catalog/fixtures.ts'
import type { FixtureDef, ServiceKind } from '../../domain/types.ts'
import { SERVICE_LABEL } from '../../domain/types.ts'
import { useViewStore } from '../../stores/view.ts'
import PanelSection from '../ui/PanelSection.vue'
import LevelStrip from './LevelStrip.vue'

const view = useViewStore()

const byCategory = computed(() => {
  const groups = new Map<FixtureDef['category'], FixtureDef[]>()
  for (const def of FIXTURE_LIST) {
    const list = groups.get(def.category)
    if (list) list.push(def)
    else groups.set(def.category, [def])
  }
  return [...groups.entries()]
})

const SERVICES: ServiceKind[] = ['waterEntry', 'wasteOutlet', 'electricalPanel']

const SERVICE_TINT: Record<ServiceKind, string> = {
  waterEntry: 'text-cold',
  wasteOutlet: 'text-waste',
  electricalPanel: 'text-power',
}

const isFixtureActive = (def: FixtureDef) =>
  view.tool.kind === 'fixture' && view.tool.fixture === def.type

/** A one-line summary of what the router will have to connect for this fixture. */
function demand(def: FixtureDef): string {
  const parts: string[] = []
  if (def.loads.drainageDu) parts.push(`${def.loads.drainageDu} DU`)
  const lu = (def.loads.supplyLuCold ?? 0) + (def.loads.supplyLuHot ?? 0)
  if (lu) parts.push(`${lu} LU`)
  if (def.loads.watts) parts.push(`${def.loads.watts} W`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto bg-ink-900">
    <PanelSection title="Storeys">
      <LevelStrip />
    </PanelSection>

    <PanelSection title="Draw">
      <div class="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          class="rounded border px-2 py-2 text-left"
          :class="
            view.tool.kind === 'room'
              ? 'border-accent bg-accent/15 text-ink-100'
              : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
          "
          @click="view.setTool(view.tool.kind === 'room' ? { kind: 'select' } : { kind: 'room' })"
        >
          Room
        </button>
        <button
          type="button"
          class="rounded border px-2 py-2 text-left"
          :class="
            view.tool.kind === 'opening' && view.tool.opening === 'door'
              ? 'border-accent bg-accent/15 text-ink-100'
              : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
          "
          @click="
            view.setTool(
              view.tool.kind === 'opening' && view.tool.opening === 'door'
                ? { kind: 'select' }
                : { kind: 'opening', opening: 'door' },
            )
          "
        >
          Doorway
        </button>
        <button
          type="button"
          class="col-span-2 rounded border px-2 py-2 text-left"
          :class="
            view.tool.kind === 'opening' && view.tool.opening === 'window'
              ? 'border-accent bg-accent/15 text-ink-100'
              : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
          "
          @click="
            view.setTool(
              view.tool.kind === 'opening' && view.tool.opening === 'window'
                ? { kind: 'select' }
                : { kind: 'opening', opening: 'window' },
            )
          "
        >
          Window
        </button>
      </div>
    </PanelSection>

    <PanelSection title="Service points">
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        Every network is routed from one of these. Place them first.
      </p>
      <div class="flex flex-col gap-1.5">
        <button
          v-for="service in SERVICES"
          :key="service"
          type="button"
          class="flex items-center justify-between rounded border px-2 py-2"
          :class="
            view.tool.kind === 'service' && view.tool.service === service
              ? 'border-accent bg-accent/15 text-ink-100'
              : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600'
          "
          @click="
            view.setTool(
              view.tool.kind === 'service' && view.tool.service === service
                ? { kind: 'select' }
                : { kind: 'service', service },
            )
          "
        >
          <span>{{ SERVICE_LABEL[service] }}</span>
          <span :class="SERVICE_TINT[service]" aria-hidden="true">●</span>
        </button>
      </div>
    </PanelSection>

    <PanelSection
      v-for="[category, defs] in byCategory"
      :key="category"
      :title="CATEGORY_LABEL[category]"
    >
      <div class="flex flex-col gap-1">
        <button
          v-for="def in defs"
          :key="def.type"
          type="button"
          class="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-left"
          :class="
            isFixtureActive(def)
              ? 'border-accent bg-accent/15 text-ink-100'
              : 'border-transparent bg-ink-850 text-ink-300 hover:border-ink-600'
          "
          @click="
            view.setTool(isFixtureActive(def) ? { kind: 'select' } : { kind: 'fixture', fixture: def.type })
          "
        >
          <span>{{ def.label }}</span>
          <span class="numeric text-[10px] text-ink-400">{{ demand(def) }}</span>
        </button>
      </div>
    </PanelSection>
  </div>
</template>
