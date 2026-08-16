<script setup lang="ts">
/** Contextual properties for whatever is selected. */
import { computed } from 'vue'

import { fixtureDef } from '../../domain/catalog/fixtures.ts'
import { wallLength } from '../../domain/edit.ts'
import { entryOf, heatingOf, wallBehind, wallsOf } from '../../domain/model.ts'
import {
  bestManifoldPosition,
  costOf,
  manifoldPlacementCost,
} from '../../domain/routing/placement.ts'
import {
  COVERING_LABEL,
  COVERING_RESISTANCE,
  SPACINGS,
} from '../../domain/standards/en1264.ts'
import {
  SERVICE_LABEL,
  SYSTEM_LABEL,
  type ConnectionEntry,
  type FloorCovering,
} from '../../domain/types.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import NumberField from '../ui/NumberField.vue'
import PanelSection from '../ui/PanelSection.vue'

const projectStore = useProjectStore()
const levels = useLevels()
const routing = useRoutingStore()
const selection = useSelectionStore()

const project = computed(() => projectStore.project)

const room = computed(() => {
  const active = selection.current
  if (!active || (active.kind !== 'room' && active.kind !== 'wall')) return null
  return project.value.rooms.find((r) => r.id === active.id) ?? null
})

const wallIndex = computed(() =>
  selection.current?.kind === 'wall' ? (selection.current.wallIndex ?? null) : null,
)

const wall = computed(() => {
  if (!room.value || wallIndex.value === null) return null
  return wallsOf(room.value)[wallIndex.value] ?? null
})

const fixture = computed(() =>
  selection.current?.kind === 'fixture'
    ? (project.value.fixtures.find((f) => f.id === selection.current!.id) ?? null)
    : null,
)

const service = computed(() =>
  selection.current?.kind === 'service'
    ? (project.value.servicePoints.find((s) => s.id === selection.current!.id) ?? null)
    : null,
)

const opening = computed(() =>
  selection.current?.kind === 'opening'
    ? (project.value.openings.find((o) => o.id === selection.current!.id) ?? null)
    : null,
)

const fixtureInfo = computed(() => (fixture.value ? fixtureDef(fixture.value.type) : null))

/** Only plumbing has an entry face; a light or a socket does not. */
const hasPipes = computed(() =>
  (fixtureInfo.value?.ports ?? []).some((port) => port.kind !== 'power'),
)

const wantsBack = computed(
  () => fixture.value !== null && entryOf(project.value, fixture.value) === 'back',
)

/** A dedicated fixed load on a three-phase supply is the only thing worth spreading. */
const canBeThreePhase = computed(() => {
  const kind = fixtureInfo.value?.loads.circuit
  return (
    project.value.settings.electrical.supply === 'three-phase' &&
    (kind === 'appliance' || kind === 'cooker')
  )
})

/** Whether back entry can actually be honoured — the appliance has to be against a wall. */
const backedByWall = computed(
  () => fixture.value !== null && wallBehind(project.value, fixture.value) !== null,
)

/** Walls of the room the selected fixture is in — the options it can be mounted to. */
const fixtureRoomWalls = computed(() => {
  const owner = project.value.rooms.find((r) => r.id === fixture.value?.roomId)
  return owner ? wallsOf(owner) : []
})

/** The selected room's heating, with everything it does not override filled in. */
const roomHeat = computed(() =>
  room.value
    ? heatingOf(project.value, room.value)
    : { enabled: false, spacing: 150, roomTempC: 20, covering: 'tile' as FloorCovering, manifoldId: null },
)

/** What the solver actually laid in it — the answer to "did that setting do anything?". */
const roomLoops = computed(() =>
  routing.result.loops.filter((loop) => loop.roomId === room.value?.id),
)

/** Loops ported on the selected manifold, for its own inspector. */
const manifold = computed(() =>
  routing.result.manifolds.find((design) => design.id === service.value?.id) ?? null,
)

/**
 * What the selected manifold costs in pipe where it stands, and what the best place on the
 * storey would cost — so the button says what it is worth pressing before it is pressed, and
 * says nothing more than "it is already there" when it is.
 */
const placement = computed(() => {
  if (service.value?.kind !== 'heatingManifold') return null
  const here = manifoldPlacementCost(project.value, service.value)
  const best = bestManifoldPosition(project.value, service.value.id)
  if (!here || !best) return null
  const saved = costOf(here) - costOf(best)
  return { here, best, saved, worthwhile: saved > 500 }
})

/** The wall a fixture is anchored to, for bounding its slide. */
const fixtureWallLength = computed(() => {
  const f = fixture.value
  if (!f || f.wallIndex === null) return 0
  const owner = project.value.rooms.find((r) => r.id === f.roomId)
  return owner ? wallLength(owner, f.wallIndex) : 0
})
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <!-- The active storey is always editable: it is the context for everything else here. -->
    <PanelSection v-if="levels.active.value" :title="`Storey — ${levels.active.value.name}`">
      <label class="flex items-center justify-between gap-2 py-1">
        <span class="text-ink-400">Name</span>
        <input
          :value="levels.active.value.name"
          class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
          @change="
            projectStore.updateLevel(levels.activeId.value!, {
              name: ($event.target as HTMLInputElement).value,
            })
          "
        />
      </label>
      <NumberField
        label="Storey height"
        :model-value="levels.active.value.height"
        :min="2000"
        :max="6000"
        :step="50"
        @update:model-value="projectStore.updateLevel(levels.activeId.value!, { height: $event })"
      />
      <NumberField
        label="Slab above"
        :model-value="levels.active.value.slabThickness"
        :min="0"
        :max="800"
        :step="10"
        @update:model-value="
          projectStore.updateLevel(levels.activeId.value!, { slabThickness: $event })
        "
      />
      <p class="mt-1 text-[11px] leading-relaxed text-ink-400">
        Floor at +{{ (levels.active.value.elevation / 1000).toFixed(3) }} m. Elevations are
        derived by stacking storey heights, so raising one moves everything above it.
      </p>
    </PanelSection>

    <div v-if="!selection.current" class="px-3 py-6 text-[12px] leading-relaxed text-ink-400">
      Nothing selected. Click a room, wall, fixture or service point to edit it — or pick a tool
      on the left and click the plan to place something new.
    </div>

    <!-- Room -->
    <template v-if="room && wallIndex === null">
      <PanelSection :title="`Room — ${room.name}`">
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Name</span>
          <input
            :value="room.name"
            class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
            @change="projectStore.updateRoom(room.id, { name: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <NumberField
          label="Ceiling height"
          :model-value="room.height"
          :min="2000"
          :max="6000"
          :step="50"
          @update:model-value="projectStore.updateRoom(room.id, { height: $event })"
        />
        <NumberField
          label="Wall thickness"
          :model-value="room.wallThickness"
          :min="60"
          :max="500"
          :step="10"
          @update:model-value="projectStore.updateRoom(room.id, { wallThickness: $event })"
        />
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Storey</span>
          <select
            class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
            :value="room.levelId"
            @change="
              projectStore.moveRoomToLevel(room.id, ($event.target as HTMLSelectElement).value)
            "
          >
            <option v-for="l in levels.levels.value" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
      </PanelSection>

      <!-- Heating is a property of the floor, so it belongs to the room rather than to
           anything placed in it. -->
      <PanelSection title="Underfloor heating">
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Heated floor</span>
          <input
            type="checkbox"
            class="size-4 accent-[var(--color-accent)]"
            :checked="roomHeat.enabled"
            @change="
              projectStore.updateRoomHeating(room.id, {
                enabled: ($event.target as HTMLInputElement).checked,
              })
            "
          />
        </label>
        <template v-if="roomHeat.enabled">
          <label class="flex items-center justify-between gap-2 py-1">
            <span class="text-ink-400">Pipe pitch</span>
            <select
              class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
              :value="room.heating?.spacing ?? ''"
              @change="
                projectStore.updateRoomHeating(room.id, {
                  spacing: Number(($event.target as HTMLSelectElement).value) || null,
                })
              "
            >
              <option value="">Project ({{ project.settings.heating.spacing }} mm)</option>
              <option v-for="pitch in SPACINGS" :key="pitch" :value="pitch">{{ pitch }} mm</option>
            </select>
          </label>
          <label class="flex items-center justify-between gap-2 py-1">
            <span class="text-ink-400">Floor covering</span>
            <select
              class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
              :value="room.heating?.covering ?? ''"
              @change="
                projectStore.updateRoomHeating(room.id, {
                  covering: (($event.target as HTMLSelectElement).value || null) as
                    | FloorCovering
                    | null,
                })
              "
            >
              <option value="">
                Project ({{ COVERING_LABEL[project.settings.heating.covering].toLowerCase() }})
              </option>
              <option v-for="(label, key) in COVERING_LABEL" :key="key" :value="key">
                {{ label }}
              </option>
            </select>
          </label>
          <NumberField
            label="Design temperature"
            suffix="°C"
            :model-value="roomHeat.roomTempC"
            :min="10"
            :max="30"
            :step="1"
            @update:model-value="projectStore.updateRoomHeating(room.id, { roomTempC: $event })"
          />
          <p class="mt-1 text-[11px] leading-relaxed text-ink-400">
            <template v-if="roomHeat.roomTempC >= 24">
              Designed at {{ roomHeat.roomTempC }} °C, so EN 1264-2 allows the floor to reach
              33 °C rather than 29 — a bathroom is stood on barefoot and briefly.
            </template>
            <template v-else>
              The floor may reach 29 °C mean surface temperature, which is about 100 W/m² over a
              {{ roomHeat.roomTempC }} °C room however it is piped.
            </template>
            {{ COVERING_LABEL[roomHeat.covering] }} adds
            {{ COVERING_RESISTANCE[roomHeat.covering].toFixed(3) }} m²K/W over the screed.
          </p>
          <ul v-if="roomLoops.length" class="mt-2 flex flex-col gap-1 border-t border-ink-800 pt-2">
            <li
              v-for="loop in roomLoops"
              :key="loop.id"
              class="flex items-center justify-between gap-2 text-[11px]"
            >
              <span class="text-ink-300">
                Loop {{ loop.port }}{{ loop.partOf ? ` · part ${loop.partOf}` : '' }}
              </span>
              <span class="numeric text-ink-400">
                {{ (loop.length / 1000).toFixed(0) }} m · {{ Math.round(loop.fluxW) }} W/m² ·
                {{ loop.surfaceTempC.toFixed(1) }} °C
              </span>
            </li>
          </ul>
        </template>
      </PanelSection>

      <PanelSection title="Walls" :badge="room.walls.length">
        <p class="mb-2 text-[11px] text-ink-400">Click a wall on the plan to set its length.</p>
        <ul class="flex flex-col gap-1">
          <li
            v-for="w in wallsOf(room)"
            :key="w.index"
            class="flex cursor-pointer items-center justify-between rounded px-2 py-1 hover:bg-ink-850"
            @click="selection.select({ kind: 'wall', id: room.id, wallIndex: w.index })"
          >
            <span class="text-ink-300">Wall {{ w.index + 1 }}</span>
            <span class="numeric text-ink-400">{{ Math.round(w.length) }} mm</span>
          </li>
        </ul>
      </PanelSection>

      <div class="p-3">
        <button
          type="button"
          class="w-full rounded border border-red-900/60 bg-red-950/40 py-1.5 text-red-300 hover:bg-red-900/40"
          @click="projectStore.removeRoom(room.id); selection.clear()"
        >
          Delete room
        </button>
      </div>
    </template>

    <!-- Wall -->
    <template v-if="room && wall && wallIndex !== null">
      <PanelSection :title="`Wall ${wallIndex + 1} — ${room.name}`">
        <NumberField
          label="Length"
          :model-value="Math.round(wall.length)"
          :min="200"
          :step="10"
          @update:model-value="projectStore.resizeWall(room.id, wallIndex, $event)"
        />
        <NumberField
          label="Thickness"
          :model-value="room.wallThickness"
          :min="60"
          :max="500"
          :step="10"
          @update:model-value="projectStore.updateRoom(room.id, { wallThickness: $event })"
        />
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Load-bearing</span>
          <input
            type="checkbox"
            class="size-4 accent-[var(--color-accent)]"
            :checked="room.walls[wallIndex]?.loadBearing ?? false"
            @change="
              projectStore.setWallLoadBearing(
                room.id,
                wallIndex,
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
        </label>
        <p class="mt-1 text-[11px] leading-relaxed text-ink-400">
          Pipes and cables will not be routed through a load-bearing wall.
        </p>
      </PanelSection>
    </template>

    <!-- Fixture -->
    <template v-if="fixture && fixtureInfo">
      <PanelSection :title="`Fixture — ${fixtureInfo.label}`">
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Name</span>
          <input
            :value="fixture.name"
            class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
            @change="
              projectStore.updateFixture(fixture.id, {
                name: ($event.target as HTMLInputElement).value,
              })
            "
          />
        </label>
        <label v-if="fixtureInfo.mount !== 'ceiling'" class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Mounting</span>
          <select
            class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
            :value="fixture.wallIndex === null ? 'free' : String(fixture.wallIndex)"
            @change="
              projectStore.setFixtureMounting(
                fixture.id,
                ($event.target as HTMLSelectElement).value === 'free'
                  ? null
                  : Number(($event.target as HTMLSelectElement).value),
              )
            "
          >
            <option value="free">Free-standing</option>
            <option v-for="w in fixtureRoomWalls" :key="w.index" :value="String(w.index)">
              Wall {{ w.index + 1 }} ({{ Math.round(w.length) }} mm)
            </option>
          </select>
        </label>
        <!-- Kept next to the mounting: both answer "how is this thing attached?", and the
             answer to one constrains the other. -->
        <label v-if="hasPipes" class="flex items-center justify-between gap-2 py-1">
          <span class="text-ink-400">Pipe entry</span>
          <select
            class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
            :value="fixture.entry ?? ''"
            @change="
              projectStore.updateFixture(fixture.id, {
                entry: (($event.target as HTMLSelectElement).value || null) as
                  | ConnectionEntry
                  | null,
              })
            "
          >
            <option value="">
              Project default ({{
                project.settings.connectionEntry === 'back' ? 'behind' : 'below'
              }})
            </option>
            <option value="bottom">From below</option>
            <option value="back">From behind</option>
          </select>
        </label>
        <p
          v-if="hasPipes && wantsBack && !backedByWall"
          class="mb-1 text-[11px] leading-relaxed text-amber-300/80"
        >
          Not against a wall, so this one connects from below regardless. Mount it to a wall,
          or push it back against one.
        </p>
        <NumberField
          v-if="fixture.wallIndex !== null"
          label="Along wall"
          :model-value="Math.round(fixture.wallOffset)"
          :min="0"
          :max="Math.round(fixtureWallLength)"
          :step="10"
          @update:model-value="projectStore.updateFixture(fixture.id, { wallOffset: $event })"
        />
        <NumberField
          label="Height"
          :model-value="Math.round(fixture.z)"
          :step="10"
          @update:model-value="projectStore.updateFixture(fixture.id, { z: $event })"
        />
        <!-- Only a fixed appliance on its own circuit can be taken across three lines; a
             socket or a light is 230 V off one, whatever the supply. -->
        <label
          v-if="canBeThreePhase"
          class="flex items-center justify-between gap-2 py-1"
        >
          <span class="text-ink-400">Supply</span>
          <select
            class="w-32 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100 outline-none focus:border-accent"
            :value="fixture.threePhase === true ? 'three' : 'single'"
            @change="
              projectStore.updateFixture(fixture.id, {
                threePhase: ($event.target as HTMLSelectElement).value === 'three',
              })
            "
          >
            <option value="single">1~ {{ project.settings.electrical.voltage }} V</option>
            <option value="three">3~ {{ project.settings.electrical.lineVoltage }} V</option>
          </select>
        </label>
        <p v-if="canBeThreePhase && fixture.threePhase" class="mb-1 text-[11px] leading-relaxed text-ink-400">
          Across all three lines, so each carries a third of the current — and the volt drop
          falls with it.
        </p>
        <NumberField
          v-if="fixture.wallIndex === null"
          label="Rotation"
          suffix="°"
          :model-value="Math.round((fixture.rotation * 180) / Math.PI)"
          :step="15"
          @update:model-value="
            projectStore.updateFixture(fixture.id, { rotation: ($event * Math.PI) / 180 })
          "
        />
      </PanelSection>

      <PanelSection title="Connections" :badge="fixtureInfo.ports.length">
        <ul class="flex flex-col gap-1">
          <li
            v-for="port in fixtureInfo.ports"
            :key="port.id"
            class="flex items-center justify-between"
          >
            <span class="flex items-center gap-2 text-ink-300">
              <span
                class="inline-block size-2 rounded-full"
                :style="{ background: `var(--color-${port.kind})` }"
              />
              {{ SYSTEM_LABEL[port.kind] }}
            </span>
            <span class="numeric text-ink-400">{{ port.dn ? `DN${port.dn}` : '—' }}</span>
          </li>
        </ul>
        <dl class="mt-3 grid grid-cols-2 gap-y-1 text-[11px]">
          <template v-if="fixtureInfo.loads.drainageDu">
            <dt class="text-ink-400">Discharge</dt>
            <dd class="numeric text-right text-ink-200">{{ fixtureInfo.loads.drainageDu }} DU</dd>
          </template>
          <template v-if="fixtureInfo.loads.supplyLuCold">
            <dt class="text-ink-400">Cold demand</dt>
            <dd class="numeric text-right text-ink-200">{{ fixtureInfo.loads.supplyLuCold }} LU</dd>
          </template>
          <template v-if="fixtureInfo.loads.supplyLuHot">
            <dt class="text-ink-400">Hot demand</dt>
            <dd class="numeric text-right text-ink-200">{{ fixtureInfo.loads.supplyLuHot }} LU</dd>
          </template>
          <template v-if="fixtureInfo.loads.watts">
            <dt class="text-ink-400">Power</dt>
            <dd class="numeric text-right text-ink-200">{{ fixtureInfo.loads.watts }} W</dd>
          </template>
        </dl>
      </PanelSection>

      <div class="p-3">
        <button
          type="button"
          class="w-full rounded border border-red-900/60 bg-red-950/40 py-1.5 text-red-300 hover:bg-red-900/40"
          @click="projectStore.removeFixture(fixture.id); selection.clear()"
        >
          Delete fixture
        </button>
      </div>
    </template>

    <!-- Service point -->
    <template v-if="service">
      <PanelSection :title="SERVICE_LABEL[service.kind]">
        <NumberField
          label="X"
          :model-value="Math.round(service.position.x)"
          :step="10"
          @update:model-value="
            projectStore.updateServicePoint(service.id, {
              position: { x: $event, y: service.position.y },
            })
          "
        />
        <NumberField
          label="Y"
          :model-value="Math.round(service.position.y)"
          :step="10"
          @update:model-value="
            projectStore.updateServicePoint(service.id, {
              position: { x: service.position.x, y: $event },
            })
          "
        />
        <NumberField
          :label="service.kind === 'wasteOutlet' ? 'Invert level' : 'Height'"
          :model-value="Math.round(service.z)"
          :step="10"
          @update:model-value="projectStore.updateServicePoint(service.id, { z: $event })"
        />
        <p
          v-if="service.kind === 'wasteOutlet'"
          class="mt-1 text-[11px] leading-relaxed text-ink-400"
        >
          Negative values sit below the floor. The whole drainage network falls towards this
          level, so lowering it buys headroom for longer runs.
        </p>
        <p
          v-else-if="service.kind === 'heatingManifold'"
          class="mt-1 text-[11px] leading-relaxed text-ink-400"
        >
          Every heated room on this storey is served from its nearest manifold. Move this one
          and the loops are re-drawn from where it lands — the leaders are pipe off the same
          coil, so a manifold in the middle of the plan buys floor area at the far end of it.
        </p>
      </PanelSection>

      <!-- Somewhere to stand it: least pipe, counting the leaders to every room and the
           primary back to the heat source together. -->
      <PanelSection v-if="placement" title="Placement">
        <dl class="grid grid-cols-2 gap-y-1 text-[11px]">
          <dt class="text-ink-400">Leaders</dt>
          <dd class="numeric text-right text-ink-200">
            {{ (placement.here.leaderLength / 1000).toFixed(1) }} m
            <span v-if="placement.worthwhile" class="text-emerald-400">
              → {{ (placement.best.leaderLength / 1000).toFixed(1) }}
            </span>
          </dd>
          <dt class="text-ink-400">Primary</dt>
          <dd class="numeric text-right text-ink-200">
            {{ (placement.here.primaryLength / 1000).toFixed(1) }} m
            <span v-if="placement.worthwhile" class="text-emerald-400">
              → {{ (placement.best.primaryLength / 1000).toFixed(1) }}
            </span>
          </dd>
          <dt class="text-ink-400">Rooms served</dt>
          <dd class="numeric text-right text-ink-200">{{ placement.here.rooms }}</dd>
        </dl>

        <button
          type="button"
          class="mt-3 w-full rounded border border-sky-900/60 bg-sky-950/40 py-1.5 text-sky-200 hover:bg-sky-900/40 disabled:cursor-default disabled:border-ink-800 disabled:bg-transparent disabled:text-ink-500"
          :disabled="!placement.worthwhile"
          @click="projectStore.optimiseManifold(service.id)"
        >
          {{ placement.worthwhile ? 'Move to the best place' : 'Already in the best place' }}
        </button>
        <p class="mt-2 text-[11px] leading-relaxed text-ink-400">
          <template v-if="placement.worthwhile">
            Standing it against a wall on this storey where the leaders to every room and the
            primary back to the heat source come to the least pipe between them — the primary
            counting for more per metre, because it is the larger pipe and it is insulated.
            Saves about {{ (placement.saved / 1000).toFixed(0) }} m weighted.
          </template>
          <template v-else>
            Nowhere on this storey takes less pipe than where it already stands, counting the
            leaders to every room and the primary back to the heat source together.
          </template>
        </p>
      </PanelSection>

      <PanelSection v-if="manifold" title="Manifold" :badge="manifold.loops">
        <dl class="grid grid-cols-2 gap-y-1 text-[11px]">
          <dt class="text-ink-400">Ports used</dt>
          <dd class="numeric text-right text-ink-200">{{ manifold.loops }}</dd>
          <dt class="text-ink-400">Flow / return</dt>
          <dd class="numeric text-right text-ink-200">
            {{ manifold.flowTempC }} / {{ manifold.returnTempC }} °C
          </dd>
          <dt class="text-ink-400">Output</dt>
          <dd class="numeric text-right text-ink-200">{{ Math.round(manifold.outputW) }} W</dd>
          <dt class="text-ink-400">Flow rate</dt>
          <dd class="numeric text-right text-ink-200">{{ Math.round(manifold.flowKgH) }} kg/h</dd>
          <dt class="text-ink-400">Pump head</dt>
          <dd class="numeric text-right text-ink-200">
            {{ manifold.pumpHeadKpa.toFixed(0) }} kPa
          </dd>
          <dt class="text-ink-400">Loop spread</dt>
          <dd class="numeric text-right text-ink-200">
            {{ (manifold.shortestLoop / 1000).toFixed(0) }}–{{
              (manifold.longestLoop / 1000).toFixed(0)
            }}
            m
          </dd>
          <dt class="text-ink-400">Primary</dt>
          <dd class="numeric text-right text-ink-200">
            Ø{{ manifold.primarySize }} ·
            {{ (manifold.primaryLength / 1000).toFixed(1) }} m
          </dd>
        </dl>
      </PanelSection>
    </template>

    <!-- Opening -->
    <template v-if="opening">
      <PanelSection :title="opening.kind === 'window' ? 'Window' : 'Doorway'">
        <NumberField
          label="Width"
          :model-value="opening.width"
          :min="400"
          :step="50"
          @update:model-value="projectStore.updateOpening(opening.id, { width: $event })"
        />
        <NumberField
          label="Height"
          :model-value="opening.height"
          :min="400"
          :step="50"
          @update:model-value="projectStore.updateOpening(opening.id, { height: $event })"
        />
        <NumberField
          label="Sill"
          :model-value="opening.sillHeight"
          :min="0"
          :step="50"
          @update:model-value="projectStore.updateOpening(opening.id, { sillHeight: $event })"
        />
        <NumberField
          label="Along wall"
          :model-value="Math.round(opening.offset)"
          :min="0"
          :step="10"
          @update:model-value="projectStore.updateOpening(opening.id, { offset: $event })"
        />
      </PanelSection>
      <div class="p-3">
        <button
          type="button"
          class="w-full rounded border border-red-900/60 bg-red-950/40 py-1.5 text-red-300 hover:bg-red-900/40"
          @click="projectStore.removeOpening(opening.id); selection.clear()"
        >
          Delete opening
        </button>
      </div>
    </template>
  </div>
</template>
