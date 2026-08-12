<script setup lang="ts">
/** Walls and floors. Walls are emitted as solid pieces around their openings. */
import { BoxGeometry, MeshStandardMaterial } from 'three'
import { computed } from 'vue'

import { useLevels } from '../../composables/useLevels.ts'
import { floorPlate, wallBoxes } from '../../three/scene.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'

const projectStore = useProjectStore()
const levels = useLevels()
const selection = useSelectionStore()
const view = useViewStore()

// One geometry and a handful of materials shared across every wall in the building; the
// per-wall difference is entirely in the transform.
const unitBox = new BoxGeometry(1, 1, 1)

const wallMaterial = new MeshStandardMaterial({ color: '#8b96a8', roughness: 0.95 })
const wallXray = new MeshStandardMaterial({
  color: '#8b96a8',
  roughness: 0.95,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
})
const wallSelected = new MeshStandardMaterial({
  color: '#38bdf8',
  roughness: 0.6,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
})
const wallFaded = new MeshStandardMaterial({
  color: '#6b7688',
  roughness: 0.95,
  transparent: true,
  opacity: 0.09,
  depthWrite: false,
})
const floorMaterial = new MeshStandardMaterial({ color: '#232c3a', roughness: 1 })
/**
 * The floor goes see-through with the walls.
 *
 * Most of what this app routes is *under* a floor — the drainage, the screed distribution and
 * the whole of the heating — so an opaque slab hides exactly the runs there is no other way
 * to look at. It is the same argument as the walls, and the same switch.
 */
const floorXray = new MeshStandardMaterial({
  color: '#232c3a',
  roughness: 1,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
})

const visibleRooms = computed(() =>
  view.isolateLevel
    ? projectStore.project.rooms.filter((r) => r.levelId === levels.activeId.value)
    : projectStore.project.rooms,
)

const rooms = computed(() =>
  visibleRooms.value.map((room) => ({
    room,
    floor: floorPlate(room),
    walls: wallBoxes(
      room,
      projectStore.project.openings.filter((o) => o.roomId === room.id),
    ),
  })),
)

const materialFor = (room: { id: string; levelId: string }) => {
  if (selection.selectedRoomId === room.id) return wallSelected
  // Storeys other than the one being edited fade back, so the active floor reads clearly
  // through them without having to hide the rest of the building.
  if (!view.isolateLevel && room.levelId !== levels.activeId.value) return wallFaded
  return view.xray ? wallXray : wallMaterial
}
</script>

<template>
  <TresGroup>
    <template v-for="entry in rooms" :key="entry.room.id">
      <TresMesh
        :geometry="unitBox"
        :material="view.xray ? floorXray : floorMaterial"
        :position="entry.floor.position"
        :scale="entry.floor.scale"
        @click="selection.select({ kind: 'room', id: entry.room.id })"
      />
      <TresMesh
        v-for="box in entry.walls"
        :key="box.key"
        :geometry="unitBox"
        :material="materialFor(entry.room)"
        :position="box.position"
        :rotation="box.rotation"
        :scale="box.scale"
        @click="selection.select({ kind: 'room', id: entry.room.id })"
      />
    </template>
  </TresGroup>
</template>
