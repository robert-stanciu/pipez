<script setup lang="ts">
/**
 * The façade scaffold — what has to stand round the house, and what it costs to hire.
 *
 * Every other workspace here is about what goes *inside* the building. This one is about the
 * thing that has to stand outside it before any of that can be rendered, insulated, guttered or
 * painted, and it is the item on a house job that is most often priced off a guess: somebody
 * multiplies the perimeter by the height, rings a yard, and finds out on the day that the upper
 * storey is set back over a terrace and that half the scaffold cannot reach the ground.
 *
 * So the façades are found from the model rather than assumed — the outside of the union of the
 * rooms, storey by storey — and each one is drawn as the run that stands against it. The
 * schedule underneath is what the yard is asked for, in the words a Romanian yard uses, and the
 * checks are the things that make a scaffold unsafe rather than merely expensive.
 */
import { computed, ref } from 'vue'

import {
  designScaffold,
  scaffoldRequestText,
  SCAFFOLD_COLOR,
  type ScaffoldStage,
} from '../../domain/scaffold.ts'
import {
  LOAD_CLASSES,
  SCAFFOLD_SYSTEM_IDS,
  SCAFFOLD_SYSTEMS,
} from '../../domain/standards/scaffold.ts'
import type { ScaffoldSettings } from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import ScaffoldElevation from './ScaffoldElevation.vue'
import ScaffoldPlan from './ScaffoldPlan.vue'

const projectStore = useProjectStore()

const design = computed(() => designScaffold(projectStore.project))

/** Every elevation on the page is at one scale, so two façades can be compared by eye. */
const scale = computed(() => {
  const longest = design.value.runs.reduce((max, run) => Math.max(max, run.builtLengthMm), 1)
  return Math.min(0.12, 760 / longest)
})

function patch(change: Partial<ScaffoldSettings>): void {
  projectStore.updateSettings({ scaffold: { ...design.value.settings, ...change } })
}

const STAGE_LABEL: Record<ScaffoldStage, string> = {
  base: 'On the ground',
  structure: 'The frame',
  decking: 'What you stand on',
  guarding: 'What stops you falling off it',
  ties: 'What holds it to the house',
  access: 'Getting up it',
  extras: 'Round it and on paper',
}

const STAGE_ORDER: ScaffoldStage[] = [
  'base',
  'structure',
  'decking',
  'guarding',
  'ties',
  'access',
  'extras',
]

const groups = computed(() =>
  STAGE_ORDER.map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    items: design.value.items.filter((item) => item.stage === stage),
  })).filter((group) => group.items.length > 0),
)

const m = (mm: number): string => (mm / 1000).toFixed(2).replace('.', ',')
const lei = (value: number): string =>
  new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 }).format(value)

const copied = ref<string | null>(null)

/** The enquiry is the deliverable: a yard quotes off it without a single phone call. */
async function copyRequest(): Promise<void> {
  const text = scaffoldRequestText(design.value, projectStore.project.name)
  try {
    await navigator.clipboard.writeText(text)
    copied.value = 'Copied — paste it into a message to the hire company.'
  } catch {
    copied.value = 'The browser refused clipboard access — select the enquiry and copy it by hand.'
  }
  const shown = copied.value
  window.setTimeout(() => {
    if (copied.value === shown) copied.value = null
  }, 4000)
}

const severityClass = (severity: string): string =>
  severity === 'error'
    ? 'border-red-900/60 bg-red-950/30 text-red-200'
    : severity === 'warning'
      ? 'border-amber-900/60 bg-amber-950/25 text-amber-200'
      : 'border-ink-700 bg-ink-850 text-ink-300'

const fieldClass =
  'rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent'
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto bg-ink-950">
    <!-- The numbers a yard is rung with. -->
    <div class="flex flex-wrap gap-x-7 gap-y-3 border-b border-ink-800 bg-ink-900 px-4 py-3">
      <div class="min-w-[11rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Façade</div>
        <div class="numeric text-ink-100">
          {{ Math.round(design.rental.areaM2) }} m²
          <span class="text-ink-400">· {{ design.rental.modules }} modules</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{ design.runs.length }} run{{ design.runs.length === 1 ? '' : 's' }} ·
          {{ design.corners }} corners ·
          {{ (design.totals.lineLengthMm / 1000).toFixed(1) }} m of scaffold
        </div>
      </div>

      <div class="min-w-[10rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Height</div>
        <div class="numeric text-ink-100">
          {{ m(design.totals.maxHeightMm) }} m
          <span class="text-ink-400">tallest run</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          top of the guardrail at +{{ m(design.totals.topOfScaffoldMm) }} ·
          {{ design.totals.roofRuns }} off a terrace
        </div>
      </div>

      <div class="min-w-[10rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Kit</div>
        <div class="numeric text-ink-100">
          {{ design.totals.frames }} frames
          <span class="text-ink-400">· {{ design.totals.bays }} bays</span>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{ design.totals.ties }} ties · {{ Math.round(design.totals.deckAreaM2) }} m² of deck
        </div>
      </div>

      <div class="min-w-[9rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Transport</div>
        <div class="numeric text-ink-100">
          {{ (design.rental.massKg / 1000).toFixed(1) }} t
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{ design.rental.loads }} van load{{ design.rental.loads === 1 ? '' : 's' }} each way
        </div>
      </div>

      <div class="min-w-[10rem]">
        <div class="text-[10px] tracking-wide text-ink-400 uppercase">Hire</div>
        <div class="numeric" :class="design.rental.hireCost === null ? 'text-ink-400' : 'text-ink-100'">
          <template v-if="design.rental.hireCost === null">rate not entered</template>
          <template v-else>{{ lei(design.rental.hireCost) }} lei</template>
        </div>
        <div class="numeric text-[10px] text-ink-400">
          {{ design.settings.months }} month{{ design.settings.months === 1 ? '' : 's' }} · erection,
          transport and netting quoted separately
        </div>
      </div>

      <button
        type="button"
        class="ml-auto self-start rounded border border-ink-700 bg-ink-850 px-2.5 py-1 text-ink-300 hover:border-ink-600 hover:text-ink-100 disabled:opacity-40"
        :disabled="design.runs.length === 0"
        @click="copyRequest"
      >
        Copy enquiry
      </button>
      <span v-if="copied" class="self-start py-1 text-ink-300">{{ copied }}</span>
    </div>

    <!-- What is being hired. Every one of these changes the order, so they live with it. -->
    <div
      class="flex flex-wrap items-end gap-x-5 gap-y-2 border-b border-ink-800 bg-ink-900 px-4 py-3 text-[12px]"
    >
      <label class="flex flex-col gap-1">
        <span class="text-[10px] tracking-wide text-ink-400 uppercase">System</span>
        <select
          :value="design.settings.system"
          :class="fieldClass"
          @change="patch({ system: ($event.target as HTMLSelectElement).value as ScaffoldSettings['system'] })"
        >
          <option v-for="id in SCAFFOLD_SYSTEM_IDS" :key="id" :value="id">
            {{ SCAFFOLD_SYSTEMS[id].nameRo }}
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[10px] tracking-wide text-ink-400 uppercase">Deck</span>
        <select
          :value="design.settings.deckWidth"
          :class="fieldClass"
          @change="patch({ deckWidth: Number(($event.target as HTMLSelectElement).value) })"
        >
          <option v-for="width in design.system.widths" :key="width" :value="width">
            {{ m(width) }} m
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[10px] tracking-wide text-ink-400 uppercase">Load class</span>
        <select
          :value="design.settings.loadClass"
          :class="fieldClass"
          @change="patch({ loadClass: Number(($event.target as HTMLSelectElement).value) as 2 | 3 | 4 })"
        >
          <option v-for="(entry, key) in LOAD_CLASSES" :key="key" :value="key">
            {{ key }} — {{ entry.kgM2 }} kg/m²
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[10px] tracking-wide text-ink-400 uppercase">Months</span>
        <input
          type="number"
          min="1"
          step="1"
          :value="design.settings.months"
          class="numeric w-20 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-right text-ink-100 outline-none focus:border-accent"
          @change="patch({ months: Math.max(1, Number(($event.target as HTMLInputElement).value)) })"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-[10px] tracking-wide text-ink-400 uppercase">Rate, lei/m²/month</span>
        <input
          type="number"
          min="0"
          step="0.5"
          placeholder="from the quote"
          :value="design.settings.ratePerM2Month ?? ''"
          class="numeric w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-right text-ink-100 outline-none focus:border-accent"
          @change="
            patch({
              ratePerM2Month:
                ($event.target as HTMLInputElement).value === ''
                  ? null
                  : Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </label>

      <label class="flex items-center gap-2 pb-1 text-ink-300">
        <input
          type="checkbox"
          :checked="design.settings.deckEveryLift"
          @change="patch({ deckEveryLift: ($event.target as HTMLInputElement).checked })"
        />
        Deck every lift
      </label>

      <label class="flex items-center gap-2 pb-1 text-ink-300">
        <input
          type="checkbox"
          :checked="design.settings.netting"
          @change="patch({ netting: ($event.target as HTMLInputElement).checked })"
        />
        Netting
      </label>

      <p class="ml-auto max-w-md text-right text-[11px] leading-relaxed text-ink-400">
        {{ design.system.why }}
      </p>
    </div>

    <div
      v-if="design.runs.length === 0"
      class="px-6 py-10 text-[13px] leading-relaxed text-ink-400"
    >
      Nothing to scaffold yet. Draw the rooms of a storey and the façades are found from the
      outside of them — every wall that has no other room behind it.
    </div>

    <template v-else>
      <!-- The plan first: it is the drawing that says whether it fits on the plot. -->
      <div class="border-b border-ink-800 bg-ink-900 px-4 py-4">
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          Where it stands
        </h2>
        <p class="mb-2 max-w-3xl text-[11px] leading-relaxed text-ink-400">
          Each band is the ground one run occupies — {{ design.settings.wallGap }} mm off the wall
          plus {{ m(design.settings.deckWidth) }} m of deck — with the letter it carries on its
          elevation. Dashed bands do not reach the ground: the storey above is set back, so they
          stand on the terrace roof below.
        </p>
        <ScaffoldPlan :project="projectStore.project" :design="design" />
      </div>

      <!-- Then the elevations, all at one scale. -->
      <div class="border-b border-ink-800 bg-ink-900 px-4 py-4">
        <h2 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
          The runs, to scale
        </h2>
        <p class="mb-3 max-w-3xl text-[11px] leading-relaxed text-ink-400">
          Frames at every bay, a deck at every lift that carries one, two rails and a toe board on
          each, and the ties in amber on the grid they were counted to. The dashed line is the top
          of the work — the top deck sits under it by less than a man's reach, which is what
          decides the number of lifts.
        </p>
        <div class="grid gap-x-6 gap-y-5 xl:grid-cols-2">
          <ScaffoldElevation
            v-for="run in design.runs"
            :key="run.id"
            :run="run"
            :design="design"
            :scale="scale"
          />
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 xl:flex-row">
        <!-- What to ask the yard for. -->
        <div class="min-w-0 flex-1">
          <h2 class="mb-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
            What to ask for, and why
          </h2>
          <div v-for="group in groups" :key="group.stage" class="mb-4">
            <div class="mb-1.5 text-[10px] tracking-wide text-ink-400 uppercase">
              {{ group.label }}
            </div>
            <div
              v-for="item in group.items"
              :key="item.id"
              class="mb-1.5 rounded border border-ink-800 bg-ink-900 px-3 py-2"
            >
              <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                <span class="text-[13px] text-ink-100">
                  <span class="numeric text-ink-400">
                    {{ item.quantity }} {{ item.unit === 'm²' ? 'm²' : 'buc' }} </span
                  >&nbsp;{{ item.nameRo }}
                </span>
                <span class="numeric text-[11px]" :style="{ color: SCAFFOLD_COLOR }">
                  {{ item.size }}
                </span>
              </div>
              <div class="text-[10.5px] text-ink-400 italic">
                {{ item.name
                }}<template v-if="item.massKg > 0"> · {{ Math.round(item.massKg) }} kg</template>
              </div>
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
            The runs
          </h2>
          <div class="overflow-x-auto rounded border border-ink-800">
            <table class="w-full text-[11.5px]">
              <thead>
                <tr
                  class="border-b border-ink-800 bg-ink-900 text-left text-[10px] tracking-wide text-ink-400 uppercase"
                >
                  <th class="px-2 py-1.5 font-medium">Run</th>
                  <th class="px-2 py-1.5 text-right font-medium">Length</th>
                  <th class="px-2 py-1.5 text-right font-medium">Height</th>
                  <th class="px-2 py-1.5 text-right font-medium">Bays × lifts</th>
                  <th class="px-2 py-1.5 text-right font-medium">m²</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="run in design.runs"
                  :key="run.id"
                  class="border-b border-ink-850 last:border-0"
                >
                  <td class="px-2 py-1.5 text-ink-100">
                    {{ run.mark }}
                    <span class="text-ink-400">{{ run.face }}</span>
                    <span v-if="run.standsOn === 'roof'" class="text-amber-300">·terrace</span>
                  </td>
                  <td class="numeric px-2 py-1.5 text-right text-ink-300">
                    {{ m(run.builtLengthMm) }}
                  </td>
                  <td class="numeric px-2 py-1.5 text-right text-ink-300">
                    {{ m(run.standingHeightMm) }}
                  </td>
                  <td class="numeric px-2 py-1.5 text-right text-ink-300">
                    {{ run.bays.length }} × {{ run.lifts }}
                  </td>
                  <td class="numeric px-2 py-1.5 text-right text-ink-300">
                    {{ Math.round(run.areaM2) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-[11px] leading-relaxed text-ink-400">
            Hire is priced on the façade area — length by the height of the guardrail, run by run.
            The area above is what a yard measures; what it charges on top of it is erection,
            striking, transport and the netting, and those are quoted per square metre too.
          </p>
        </div>
      </div>
    </template>
  </div>
</template>
