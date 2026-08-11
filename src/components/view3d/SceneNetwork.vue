<script setup lang="ts">
/**
 * The routed pipe and cable runs.
 *
 * Each run is an instance of one shared unit cylinder, scaled to its own length and bore,
 * with a sphere at every junction so bends read as continuous pipe rather than as a gap
 * between two cylinders.
 */
import {
  CylinderGeometry,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { computed } from 'vue'

import { SYSTEM_COLOR, SYSTEM_KINDS, type Segment, type SystemKind } from '../../domain/types.ts'
import { storeyContains, useLevels } from '../../composables/useLevels.ts'
import {
  bendPlacement,
  fittingRadius,
  segmentPlacement,
  segmentRadius,
  toScene,
} from '../../three/scene.ts'
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

const shownFittings = computed(() =>
  routing.result.networks
    .filter((network) => view.isSystemVisible(network.system))
    .flatMap((network) =>
      network.fittings.filter(
        (fitting) =>
          fitting.kind !== 'terminal' && withinStorey(fitting.position.z, fitting.position.z),
      ),
    ),
)

/**
 * Elbows are drawn as the arc the pipe actually sweeps through, tangent to both legs.
 *
 * Drainage corners are built from a pair of 45° bends, so this is where that shows: two
 * distinct fittings at a cut corner rather than one square knuckle.
 */
const bends = computed(() =>
  shownFittings.value.flatMap((fitting) => {
    if (fitting.kind !== 'elbow') return []
    const placement = bendPlacement(fitting)
    if (!placement) return []
    return [{ key: fitting.id, system: fitting.system, placement }]
  }),
)

/**
 * Air admittance valves, as the squat cap they are.
 *
 * Wider than the pipe and short, sitting on top of the stub — which is what you see on site,
 * and enough to tell it apart from the tees and couplings around it.
 */
const valves = computed(() =>
  shownFittings.value.flatMap((fitting) => {
    if (fitting.kind !== 'aav') return []
    const radius = fittingRadius(fitting) * 2.2
    const height = fittingRadius(fitting) * 3
    const seat = toScene(fitting.position)
    return [
      {
        key: fitting.id,
        system: fitting.system,
        // Seated on the top of its stub rather than centred on it.
        position: new Vector3(seat.x, seat.y + height / 2, seat.z),
        scale: new Vector3(radius, height, radius),
      },
    ]
  }),
)

/** Tees and couplings stay as a ball — there is no arc to draw. */
const joints = computed(() =>
  shownFittings.value.flatMap((fitting) => {
    if (fitting.kind === 'elbow' || fitting.kind === 'aav') return []
    const radius = fittingRadius(fitting) * 1.4
    return [
      {
        key: fitting.id,
        system: fitting.system,
        position: toScene(fitting.position),
        scale: new Vector3(radius, radius, radius),
      },
    ]
  }),
)

/**
 * One torus per distinct shape rather than per fitting. A building has a handful of pipe
 * sizes and two or three bend angles, so the cache holds a few entries and every elbow of the
 * same kind shares one buffer.
 */
const torusCache = new Map<string, TorusGeometry>()
function torusFor(placement: { radius: number; tube: number; arc: number }): TorusGeometry {
  const key = `${placement.radius.toFixed(4)}|${placement.tube.toFixed(4)}|${placement.arc.toFixed(3)}`
  const existing = torusCache.get(key)
  if (existing) return existing
  const created = new TorusGeometry(placement.radius, placement.tube, 8, 14, placement.arc)
  torusCache.set(key, created)
  return created
}
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
      v-for="bend in bends"
      :key="bend.key"
      :geometry="torusFor(bend.placement)"
      :material="materials[bend.system]"
      :position="bend.placement.position"
      :quaternion="bend.placement.quaternion"
    />
    <TresMesh
      v-for="joint in joints"
      :key="joint.key"
      :geometry="unitSphere"
      :material="materials[joint.system]"
      :position="joint.position"
      :scale="joint.scale"
    />
    <TresMesh
      v-for="valve in valves"
      :key="valve.key"
      :geometry="unitCylinder"
      :material="materials[valve.system]"
      :position="valve.position"
      :scale="valve.scale"
    />
  </TresGroup>
</template>
