<script setup lang="ts">
/**
 * Everything inside the canvas.
 *
 * This is a separate component on purpose: `TresCanvas` provides its context during its own
 * setup, so anything calling `useTresContext` — `OrbitControls` among them — has to be a
 * child component rather than a sibling in the same template.
 */
import { OrbitControls } from '@tresjs/cientos'
import { Vector3 } from 'three'
import { computed, ref, watch } from 'vue'

import { bounds, unionBounds } from '../../domain/geometry/polygon.ts'
import { outerOutline } from '../../domain/model.ts'
import { S, sceneCentre } from '../../three/scene.ts'
import { useProjectStore } from '../../stores/project.ts'
import SceneFixtures from './SceneFixtures.vue'
import SceneNetwork from './SceneNetwork.vue'
import SceneRooms from './SceneRooms.vue'

const projectStore = useProjectStore()

/** Orbit about the middle of the building, not its floor, so a tall house stays centred. */
const target = computed(() => {
  const centre = sceneCentre(projectStore.project)
  const rooms = projectStore.project.rooms
  const top = rooms.length > 0 ? Math.max(...rooms.map((r) => r.floorZ + r.height)) : 0
  return new Vector3(centre.x, (top * S) / 2, centre.z)
})

/**
 * How big the building is, in scene units — the basis for framing.
 *
 * Height counts as well as footprint: a narrow three-storey house would otherwise be framed
 * as though it were a bungalow and run off the top of the viewport.
 */
const extent = computed(() => {
  const rooms = projectStore.project.rooms
  if (rooms.length === 0) return 8
  const box = unionBounds(rooms.map((r) => bounds(outerOutline(r))))
  const diagonal = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y) * S
  const top = Math.max(...rooms.map((r) => r.floorZ + r.height)) * S
  return Math.max(4, diagonal, top * 1.4)
})

const cameraPosition = ref(new Vector3(8, 7, 8))

// Frame the building on load and whenever its size changes enough to matter. Orbiting moves
// the camera itself and does not touch this, so the user's viewpoint is never yanked back.
watch(
  [target, extent],
  ([centre, size]) => {
    cameraPosition.value = new Vector3(
      centre.x + size * 1.15,
      centre.y + size * 0.75,
      centre.z + size * 1.15,
    )
  },
  { immediate: true },
)

/** The ground grid stays on the ground, whatever the orbit target is doing. */
const gridPosition = computed(() => new Vector3(target.value.x, -0.002, target.value.z))
const gridDivisions = computed(() => Math.max(10, Math.ceil(extent.value * 2)))

const keyLight = new Vector3(6, 12, 8)
const fillLight = new Vector3(-8, 6, -6)
</script>

<template>
  <TresPerspectiveCamera :position="cameraPosition" :fov="45" :near="0.05" :far="500" />
  <OrbitControls :target="target" :enable-damping="true" :damping-factor="0.12" make-default />

  <TresAmbientLight :intensity="1.4" />
  <TresDirectionalLight :position="keyLight" :intensity="2.2" />
  <TresDirectionalLight :position="fillLight" :intensity="0.8" color="#93c5fd" />

  <TresGridHelper
    :args="[extent * 3, gridDivisions, '#2a3444', '#1c2330']"
    :position="gridPosition"
  />

  <SceneRooms />
  <SceneFixtures />
  <SceneNetwork />
</template>
