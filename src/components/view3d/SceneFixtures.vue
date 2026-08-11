<script setup lang="ts">
/** Fixture proxy volumes, clickable to select. */
import { BoxGeometry, MeshStandardMaterial, SphereGeometry } from 'three'
import { computed } from 'vue'

import { fixtureDef } from '../../domain/catalog/fixtures.ts'
import { fixturePorts } from '../../domain/model.ts'
import { SYSTEM_COLOR, type SystemKind } from '../../domain/types.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { fixtureBox, toScene } from '../../three/scene.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'

const projectStore = useProjectStore()
const levels = useLevels()
const selection = useSelectionStore()
const routing = useRoutingStore()
const view = useViewStore()

const unitBox = new BoxGeometry(1, 1, 1)
const portSphere = new SphereGeometry(0.022, 10, 8)

const base = new MeshStandardMaterial({ color: '#b9c2cf', roughness: 0.45, metalness: 0.05 })
const selected = new MeshStandardMaterial({ color: '#38bdf8', roughness: 0.35, emissive: '#0b4f6c' })
const unreached = new MeshStandardMaterial({ color: '#f87171', roughness: 0.5 })

const portMaterials: Record<SystemKind, MeshStandardMaterial> = {
  cold: new MeshStandardMaterial({ color: SYSTEM_COLOR.cold }),
  hot: new MeshStandardMaterial({ color: SYSTEM_COLOR.hot }),
  waste: new MeshStandardMaterial({ color: SYSTEM_COLOR.waste }),
  power: new MeshStandardMaterial({ color: SYSTEM_COLOR.power }),
}

const visibleFixtures = computed(() => {
  if (!view.isolateLevel) return projectStore.project.fixtures
  const rooms = new Set(levels.activeRooms.value.map((r) => r.id))
  return projectStore.project.fixtures.filter((f) => rooms.has(f.roomId))
})

const items = computed(() =>
  visibleFixtures.value.flatMap((fixture) => {
    const box = fixtureBox(projectStore.project, fixture)
    if (!box) return []
    return [
      {
        fixture,
        box,
        label: fixtureDef(fixture.type).label,
        ports: fixturePorts(projectStore.project, fixture).map((port) => ({
          key: `${fixture.id}-${port.portId}`,
          position: toScene(port.position),
          kind: port.kind,
        })),
      },
    ]
  }),
)

const materialFor = (id: string) => {
  if (selection.isSelected('fixture', id)) return selected
  if (routing.unreachedFixtureIds.has(id)) return unreached
  return base
}
</script>

<template>
  <TresGroup v-if="view.showFixtures">
    <template v-for="item in items" :key="item.fixture.id">
      <TresMesh
        :geometry="unitBox"
        :material="materialFor(item.fixture.id)"
        :position="item.box.position"
        :rotation="item.box.rotation"
        :scale="item.box.scale"
        @click="selection.select({ kind: 'fixture', id: item.fixture.id })"
      />
      <TresMesh
        v-for="port in item.ports"
        :key="port.key"
        :geometry="portSphere"
        :material="portMaterials[port.kind]"
        :position="port.position"
      />
    </template>
  </TresGroup>
</template>
