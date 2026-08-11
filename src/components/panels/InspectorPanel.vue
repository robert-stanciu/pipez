<script setup lang="ts">
/** Contextual properties for whatever is selected. */
import { computed } from 'vue'

import { fixtureDef } from '../../domain/catalog/fixtures.ts'
import { wallLength } from '../../domain/edit.ts'
import { wallsOf } from '../../domain/model.ts'
import { SERVICE_LABEL, SYSTEM_LABEL } from '../../domain/types.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import NumberField from '../ui/NumberField.vue'
import PanelSection from '../ui/PanelSection.vue'

const projectStore = useProjectStore()
const levels = useLevels()
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
