<script setup lang="ts">
/**
 * The shopping list — the design as things you can put in a basket.
 *
 * The bill of materials in the results panel is a schedule: it answers "what did the router
 * decide". This answers a different question — "what do I buy, and where" — and the two want
 * different words. DN100 is right on a drawing and useless at a counter in Bacău, so every
 * row carries the Romanian name of the part, the order quantity with its allowance spelled
 * out, and a search at each of the merchants who actually stock it.
 *
 * Every merchant link is a *search*, never a product page. See `domain/catalog/suppliers.ts`
 * for why, and for the record of which URL shapes were checked and when.
 */
import { computed, ref } from 'vue'

import {
  searchLinks,
  shoppingList,
  shoppingListText,
  TRADE_LABEL,
  TRADE_LABEL_RO,
  TRADES,
  type ShoppingItem,
  type Trade,
} from '../../domain/catalog/suppliers.ts'
import { SYSTEM_COLOR } from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'

const projectStore = useProjectStore()
const routing = useRoutingStore()

const items = computed<ShoppingItem[]>(() =>
  shoppingList(projectStore.project, routing.result),
)

/**
 * The trade colours are the drawing's own system colours, so a row on this list and a pipe in
 * the plan read as the same thing seen twice.
 */
const TRADE_COLOR: Record<Trade, string> = {
  drainage: SYSTEM_COLOR.waste,
  water: SYSTEM_COLOR.cold,
  electrical: SYSTEM_COLOR.power,
}

const groups = computed(() =>
  TRADES.map((trade) => ({ trade, rows: items.value.filter((item) => item.trade === trade) })).filter(
    (group) => group.rows.length > 0,
  ),
)

const unitLabel = (item: ShoppingItem): string => (item.unit === 'm' ? 'm' : 'buc')

const copied = ref<string | null>(null)

/** Plain text is how a list actually reaches a merchant — pasted into a message or an email. */
async function copyList(): Promise<void> {
  const text = shoppingListText(items.value, projectStore.project.name)
  try {
    await navigator.clipboard.writeText(text)
    copied.value = 'Copied — paste it into a message to the merchant.'
  } catch {
    // Clipboard access is refused outside a secure context and in some embedded browsers.
    copied.value = 'The browser refused clipboard access — select the list and copy it by hand.'
  }
  const shown = copied.value
  window.setTimeout(() => {
    if (copied.value === shown) copied.value = null
  }, 4000)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto bg-ink-950">
    <div
      class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-ink-800 bg-ink-900 px-4 py-3"
    >
      <div>
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Shopping list</div>
        <div class="numeric text-ink-100">
          {{ items.length }} item{{ items.length === 1 ? '' : 's' }}
          <span class="text-ink-400">· {{ groups.length }} trade{{ groups.length === 1 ? '' : 's' }}</span>
        </div>
      </div>

      <button
        type="button"
        class="rounded border border-ink-700 bg-ink-850 px-2.5 py-1 text-ink-300 hover:border-ink-600 hover:text-ink-100 disabled:opacity-40"
        :disabled="items.length === 0"
        @click="copyList"
      >
        Copy list
      </button>

      <span v-if="copied" class="text-ink-300">{{ copied }}</span>

      <p class="ml-auto max-w-md text-right text-[11px] leading-relaxed text-ink-400">
        Every link is the merchant's own search, not a product page — the words are what a
        Romanian catalogue calls the part, and a search always resolves.
      </p>
    </div>

    <div v-if="items.length === 0" class="px-6 py-10 text-[13px] leading-relaxed text-ink-400">
      Nothing to buy yet. Draw a room, drop a fixture and place an outlet or a consumer unit;
      once the solver has something to route, every pipe, fitting and device it needs will be
      listed here with somewhere to buy it.
    </div>

    <div v-else class="flex flex-col gap-6 px-4 py-4">
      <section v-for="group in groups" :key="group.trade">
        <h3 class="mb-2 flex items-baseline gap-2">
          <span
            class="inline-block size-2.5 rounded-sm"
            :style="{ background: TRADE_COLOR[group.trade] }"
          />
          <span class="text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
            {{ TRADE_LABEL[group.trade] }}
          </span>
          <span class="text-[11px] text-ink-400">{{ TRADE_LABEL_RO[group.trade] }}</span>
          <span class="numeric text-[10px] text-ink-600">{{ group.rows.length }}</span>
        </h3>

        <div class="overflow-x-auto rounded border border-ink-800">
          <table class="w-full min-w-[52rem] text-[12px]">
            <thead>
              <tr class="border-b border-ink-800 bg-ink-900 text-left text-[10px] tracking-wide text-ink-400 uppercase">
                <th class="px-3 py-1.5 font-medium">Part</th>
                <th class="px-3 py-1.5 text-right font-medium whitespace-nowrap">Order</th>
                <th class="px-3 py-1.5 font-medium">Buy from</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in group.rows"
                :key="item.id"
                class="border-b border-ink-850 align-top last:border-0 hover:bg-ink-900/60"
              >
                <td class="px-3 py-2">
                  <!-- Romanian first: that is the line being read out at the counter. -->
                  <div class="text-ink-100">{{ item.romanian }}</div>
                  <div class="text-[11px] text-ink-400">{{ item.description }}</div>
                  <p v-if="item.note" class="mt-1 max-w-xl text-[11px] leading-relaxed text-ink-600">
                    {{ item.note }}
                  </p>
                </td>

                <td class="numeric px-3 py-2 text-right whitespace-nowrap">
                  <div class="text-ink-100">{{ item.quantity }} {{ unitLabel(item) }}</div>
                  <div v-if="item.quantity !== item.required" class="text-[11px] text-ink-400">
                    {{ item.required }} {{ unitLabel(item) }} needed
                  </div>
                </td>

                <td class="px-3 py-2">
                  <div class="flex flex-wrap gap-1">
                    <a
                      v-for="link in searchLinks(item)"
                      :key="link.supplier"
                      :href="link.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="rounded border border-ink-700 bg-ink-850 px-2 py-0.5 text-[11px] text-ink-300 hover:border-accent hover:text-ink-100"
                      :title="`Search ${link.name} for “${item.terms}”`"
                    >
                      {{ link.short }}
                    </a>
                  </div>
                  <div class="mt-1 text-[10px] text-ink-600">“{{ item.terms }}”</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
