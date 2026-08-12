<script setup lang="ts">
/** Solver output: what is visible, what is wrong, and what it would take to build. */
import { computed } from 'vue'

import {
  COVERING_LABEL,
  insulationThickness,
  maxFlux,
  MIN_SCREED_COVER,
  SPACINGS,
  UFH_PIPES,
} from '../../domain/standards/en1264.ts'
import {
  SYSTEM_COLOR,
  SYSTEM_KINDS,
  SYSTEM_LABEL,
  type BomLine,
  type CableRoute,
  type ConnectionEntry,
  type DrainageStrategy,
  type FloorCovering,
  type SupplyMaterial,
  type SupplyRoute,
  type EarthingSystem,
  type InstallationMethod,
  type SurgeProtection,
  type SupplySystem,
  type UfhPipeId,
} from '../../domain/types.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'
import NumberField from '../ui/NumberField.vue'
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

const storeyName = (levelId: string): string =>
  projectStore.project.levels.find((level) => level.id === levelId)?.name ?? 'unplaced'

const loopsOf = (manifoldId: string) =>
  routing.result.loops.filter((loop) => loop.manifoldId === manifoldId)

const heating = computed(() => projectStore.project.settings.heating)

const UFH_PIPE_LIST = Object.values(UFH_PIPES)
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
          <span class="text-ink-400">See-through walls and floors (3D)</span>
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

    <!-- One block per manifold: the schedule a fitter balances the valves from. -->
    <PanelSection
      v-for="manifold in routing.result.manifolds"
      :key="manifold.id"
      :title="`${manifold.name} — ${storeyName(manifold.levelId)}`"
      :badge="manifold.loops"
    >
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{ manifold.flowTempC }} / {{ manifold.returnTempC }} °C ·
        {{ Math.round(manifold.outputW) }} W · {{ Math.round(manifold.flowKgH) }} kg/h · pump
        {{ manifold.pumpHeadKpa.toFixed(0) }} kPa · primary Ø{{ manifold.primarySize }}
      </p>
      <table class="w-full text-[11px]">
        <thead class="text-ink-400">
          <tr class="border-b border-ink-800">
            <th class="py-0.5 text-left font-normal">Loop</th>
            <th class="py-0.5 text-right font-normal">m</th>
            <th class="py-0.5 text-right font-normal">m²</th>
            <th class="py-0.5 text-right font-normal">W/m²</th>
            <th class="py-0.5 text-right font-normal">°C</th>
            <th class="py-0.5 text-right font-normal">kg/h</th>
            <th class="py-0.5 text-right font-normal">kPa</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="loop in loopsOf(manifold.id)"
            :key="loop.id"
            class="border-b border-ink-850 last:border-0"
          >
            <td class="py-0.5 pr-2 text-ink-300">
              {{ loop.port }}. {{ loop.roomName
              }}<span v-if="loop.partOf" class="text-ink-400"> ({{ loop.partOf }})</span>
            </td>
            <td class="numeric py-0.5 text-right text-ink-100">
              {{ (loop.length / 1000).toFixed(0) }}
            </td>
            <td class="numeric py-0.5 text-right text-ink-400">{{ loop.area.toFixed(1) }}</td>
            <td class="numeric py-0.5 text-right text-ink-100">{{ Math.round(loop.fluxW) }}</td>
            <td
              class="numeric py-0.5 text-right"
              :class="loop.surfaceTempC > loop.surfaceLimitC ? 'text-amber-300' : 'text-ink-400'"
            >
              {{ loop.surfaceTempC.toFixed(1) }}
            </td>
            <td class="numeric py-0.5 text-right text-ink-400">{{ Math.round(loop.flowKgH) }}</td>
            <td
              class="numeric py-0.5 text-right"
              :class="loop.pressureDropKpa > 25 ? 'text-amber-300' : 'text-ink-400'"
            >
              {{ loop.pressureDropKpa.toFixed(0) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p class="mt-2 text-[11px] leading-relaxed text-ink-400">
        Surface temperatures are the mean over the loop, against the EN 1264-2 ceiling of 29 °C
        in a living space and 33 °C in a bathroom. Lengths include both leaders — they come off
        the same coil, so they spend the same budget.
      </p>
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

    <PanelSection title="Electrical supply">
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Supply</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.electrical.supply"
          @change="
            projectStore.updateElectrical({
              supply: ($event.target as HTMLSelectElement).value as SupplySystem,
            })
          "
        >
          <option value="three-phase">3~ (400 V)</option>
          <option value="single-phase">1~ (230 V)</option>
        </select>
      </label>
      <NumberField
        label="Line voltage"
        suffix="V"
        :model-value="projectStore.project.settings.electrical.lineVoltage"
        :min="200"
        :max="500"
        :step="10"
        @update:model-value="projectStore.updateElectrical({ lineVoltage: $event })"
      />
      <NumberField
        label="Main switch"
        suffix="A"
        :model-value="projectStore.project.settings.electrical.mainBreakerAmps"
        :min="6"
        :max="250"
        :step="1"
        @update:model-value="projectStore.updateElectrical({ mainBreakerAmps: $event })"
      />
      <NumberField
        label="Circuits per RCD"
        suffix=""
        :model-value="projectStore.project.settings.electrical.circuitsPerRcd"
        :min="1"
        :max="12"
        :step="1"
        @update:model-value="projectStore.updateElectrical({ circuitsPerRcd: $event })"
      />
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Earthing</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.electrical.earthing ?? 'TN-C-S'"
          @change="
            projectStore.updateElectrical({
              earthing: ($event.target as HTMLSelectElement).value as EarthingSystem,
            })
          "
        >
          <option value="TN-C-S">TN-C-S</option>
          <option value="TN-S">TN-S</option>
          <option value="TT">TT</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{
          (projectStore.project.settings.electrical.earthing ?? 'TN-C-S') === 'TT'
            ? 'The installation makes its own earth, so a 30 mA device is the only thing standing between a fault and the person touching it — and the electrode resistance has to be measured, not assumed.'
            : 'The supply brings the earth in, so protective bonding to the water, gas and structural steel is what makes it work. Protective conductors are sized from HD 60364-5-54.'
        }}
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Wiring method</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.electrical.installationMethod ?? 'B1'"
          @change="
            projectStore.updateElectrical({
              installationMethod: ($event.target as HTMLSelectElement).value as InstallationMethod,
            })
          "
        >
          <option value="B1">B1 — in conduit</option>
          <option value="B2">B2 — in trunking</option>
          <option value="A1">A1 — in insulation</option>
          <option value="A2">A2 — sheathed, insulated</option>
          <option value="C">C — clipped direct</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        Reference method from HD 60364-5-52 — what a cable may carry depends on how it gets rid
        of its heat. Circuits sharing a chase are derated for the company they keep.
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Surge protection</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.electrical.surgeProtection ?? 'type-2'"
          @change="
            projectStore.updateElectrical({
              surgeProtection: ($event.target as HTMLSelectElement).value as SurgeProtection,
            })
          "
        >
          <option value="type-2">Type 2</option>
          <option value="type-1+2">Type 1+2</option>
          <option value="type-1">Type 1</option>
          <option value="none">None</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        A Type 2 arrester at the board is what HD 60364-4-44 expects of a house on an overhead
        or mixed supply. It sits in front of the residual current devices: a discharge to earth
        behind one would trip the house every storm.
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Cables run</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.electrical.cableRoute"
          @change="
            projectStore.updateElectrical({
              cableRoute: ($event.target as HTMLSelectElement).value as CableRoute,
            })
          "
        >
          <option value="ceiling">Along the ceiling</option>
          <option value="floor">Under the floor</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{
          projectStore.project.settings.electrical.cableRoute === 'floor'
            ? 'Circuits are distributed in the screed and come up the wall to each point. Shorter runs to sockets, longer ones to the lights.'
            : 'Circuits are distributed under the ceiling and drop down the wall to each point. Shorter runs to the lights, longer ones to the sockets.'
        }}
        Drops stay inside the permitted wall zones either way.
      </p>
      <p class="mt-1 text-[11px] leading-relaxed text-ink-400">
        400 V between lines and {{ projectStore.project.settings.electrical.voltage }} V to
        neutral — the same system older drawings call 380/220 V. Set an appliance to three
        phases in its inspector to spread it across all three.
      </p>
    </PanelSection>

    <PanelSection title="Underfloor heating">
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Pipe</span>
        <select
          class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="heating.pipe"
          @change="
            projectStore.updateSettings({
              heating: {
                ...heating,
                pipe: ($event.target as HTMLSelectElement).value as UfhPipeId,
              },
            })
          "
        >
          <option v-for="option in UFH_PIPE_LIST" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Pipe pitch</span>
        <select
          class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="heating.spacing"
          @change="
            projectStore.updateSettings({
              heating: { ...heating, spacing: Number(($event.target as HTMLSelectElement).value) },
            })
          "
        >
          <option v-for="pitch in SPACINGS" :key="pitch" :value="pitch">{{ pitch }} mm</option>
        </select>
      </label>
      <NumberField
        label="Flow temperature"
        suffix="°C"
        :model-value="heating.flowTempC"
        :min="25"
        :max="55"
        :step="1"
        @update:model-value="
          projectStore.updateSettings({ heating: { ...heating, flowTempC: $event } })
        "
      />
      <NumberField
        label="Design drop"
        suffix="K"
        :model-value="heating.deltaTK"
        :min="3"
        :max="15"
        :step="1"
        @update:model-value="
          projectStore.updateSettings({ heating: { ...heating, deltaTK: $event } })
        "
      />
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{ heating.flowTempC }} / {{ heating.flowTempC - heating.deltaTK }} °C. The floor is a
        big emitter running cool: the surface may not pass 29 °C in a living space, which caps
        it at about {{ Math.round(maxFlux(29, heating.roomTempC)) }} W/m² over a
        {{ heating.roomTempC }} °C room whatever is buried in it. A wider drop means less water
        round the loops and less pressure to push it.
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Floor covering</span>
        <select
          class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="heating.covering"
          @change="
            projectStore.updateSettings({
              heating: {
                ...heating,
                covering: ($event.target as HTMLSelectElement).value as FloorCovering,
              },
            })
          "
        >
          <option v-for="(label, key) in COVERING_LABEL" :key="key" :value="key">
            {{ label }}
          </option>
        </select>
      </label>
      <NumberField
        label="Screed over pipe"
        suffix="mm"
        :model-value="heating.screedCover"
        :min="20"
        :max="120"
        :step="5"
        @update:model-value="
          projectStore.updateSettings({ heating: { ...heating, screedCover: $event } })
        "
      />
      <NumberField
        label="Insulation"
        suffix="m²K/W"
        :model-value="heating.insulationR"
        :min="0"
        :max="4"
        :step="0.25"
        @update:model-value="
          projectStore.updateSettings({ heating: { ...heating, insulationR: $event } })
        "
      />
      <p class="mt-1 text-[11px] leading-relaxed text-ink-400">
        EN 1264-4 asks for {{ MIN_SCREED_COVER }} mm of screed over the pipe and 1,25 m²K/W of
        insulation under it over the ground — about
        {{ insulationThickness(heating.insulationR) }} mm of EPS at this setting. Rooms are
        heated unless their inspector says otherwise; the loops are drawn from the nearest
        manifold on their own storey.
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
        <span class="text-ink-400">Water runs</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.supply.route"
          @change="
            projectStore.updateSettings({
              supply: {
                ...projectStore.project.settings.supply,
                route: ($event.target as HTMLSelectElement).value as SupplyRoute,
              },
            })
          "
        >
          <option value="ceiling">Along the ceiling</option>
          <option value="floor">Under the floor</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        {{
          projectStore.project.settings.supply.route === 'floor'
            ? 'Cold and hot are distributed in the floor build-up and rise up the wall to each point — short runs to sanitaryware, and the pipe goes in with the screed. Anything high up pays for it on the way back.'
            : 'Cold and hot are distributed in the ceiling void and drop down the wall to each point. The slab is never broken into and the pipe stays reachable.'
        }}
        Both follow the same choice, and stay paired.
      </p>
      <label class="flex items-center justify-between py-1">
        <span class="text-ink-400">Water pipe</span>
        <select
          class="w-28 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          :value="projectStore.project.settings.supply.material"
          @change="
            projectStore.updateSettings({
              supply: {
                ...projectStore.project.settings.supply,
                material: ($event.target as HTMLSelectElement).value as SupplyMaterial,
              },
            })
          "
        >
          <option value="PPR">PP-R</option>
          <option value="PEX-AL-PEX">PEX-AL-PEX</option>
          <option value="PE-X">PE-X</option>
          <option value="copper">Copper</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        Sizes are the outside diameters that material is sold in, and capacity follows the
        bore rather than the label — a Ø20 PP-R and a 15 mm copper are the same connection.
      </p>
      <NumberField
        label="Pressure at the entry"
        suffix="kPa"
        :model-value="projectStore.project.settings.supply.entryPressureKpa"
        :min="50"
        :max="1000"
        :step="10"
        @update:model-value="
          projectStore.updateSettings({
            supply: { ...projectStore.project.settings.supply, entryPressureKpa: $event },
          })
        "
      />
      <p class="mb-2 text-[11px] leading-relaxed text-ink-400">
        What the main can be relied on to deliver. The climb to the top floor and the friction
        along the way come out of it, and EN 806-3 wants 100 kPa still left at every tap.
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
