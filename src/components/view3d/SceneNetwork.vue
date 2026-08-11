<script setup lang="ts">
/**
 * The routed pipe and cable runs.
 *
 * Each run is an instance of one shared unit cylinder, scaled to its own length and bore,
 * with a sphere at every junction so bends read as continuous pipe rather than as a gap
 * between two cylinders.
 */
import { CylinderGeometry, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three'
import { computed } from 'vue'

import { SYSTEM_COLOR, SYSTEM_KINDS, type Segment, type SystemKind } from '../../domain/types.ts'
import { storeyContains, useLevels } from '../../composables/useLevels.ts'
import { segmentPlacement, segmentRadius, toScene } from '../../three/scene.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useViewStore } from '../../stores/view.ts'

const routing = useRoutingStore()
const view = useViewStore()
const levels = useLevels()

/**
 * When a storey is isolated the runs have to go with it, otherwise the pipes from the floors
 * you just hid are left hanging in mid-air.
 */
const withinStorey = (lo: number, hi: number): boolean =>
  !view.isolateLevel || storeyContains(levels.active.value, lo, hi)

const visible = (segment: Segment): boolean =>
  withinStorey(Math.min(segment.a.z, segment.b.z), Math.max(segment.a.z, segment.b.z))

const unitCylinder = new CylinderGeometry(1, 1, 1, 12)
const unitSphere = new SphereGeometry(1, 12, 10)

const materials = Object.fromEntries(
  SYSTEM_KINDS.map((system) => [
    system,
    new MeshStandardMaterial({ color: SYSTEM_COLOR[system], roughness: 0.35, metalness: 0.25 }),
  ]),
) as Record<SystemKind, MeshStandardMaterial>

const runs = computed(() =>
  SYSTEM_KINDS.filter((system) => view.isSystemVisible(system)).flatMap((system) =>
    routing.segmentsFor(system).filter(visible).flatMap((segment) => {
      const placement = segmentPlacement(segment.a, segment.b)
      if (placement.length <= 0) return []
      const radius = segmentRadius(segment)
      return [
        {
          key: segment.id,
          system,
          position: placement.position,
          rotation: placement.rotation,
          scale: new Vector3(radius, placement.length, radius),
        },
      ]
    }),
  ),
)

/** A ball at each fitting, sized to the pipe, so corners look joined. */
const joints = computed(() =>
  routing.result.networks
    .filter((network) => view.isSystemVisible(network.system))
    .flatMap((network) =>
      network.fittings
        .filter(
          (fitting) =>
            fitting.kind !== 'terminal' &&
            withinStorey(fitting.position.z, fitting.position.z),
        )
        .map((fitting) => {
          const radius =
            network.system === 'power' ? 0.011 : Math.max(0.009, (fitting.size / 2) * 0.0012)
          return {
            key: fitting.id,
            system: network.system,
            position: toScene(fitting.position),
            scale: new Vector3(radius, radius, radius),
          }
        }),
    ),
)
</script>

<template>
  <TresGroup v-if="view.showNetworks">
    <TresMesh
      v-for="run in runs"
      :key="run.key"
      :geometry="unitCylinder"
      :material="materials[run.system]"
      :position="run.position"
      :rotation="run.rotation"
      :scale="run.scale"
    />
    <TresMesh
      v-for="joint in joints"
      :key="joint.key"
      :geometry="unitSphere"
      :material="materials[joint.system]"
      :position="joint.position"
      :scale="joint.scale"
    />
  </TresGroup>
</template>
