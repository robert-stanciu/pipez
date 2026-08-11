<script setup lang="ts">
/** Fixture footprints, their port markers, and the placement preview. */
import { computed } from 'vue'

import { fixtureDef } from '../../domain/catalog/fixtures.ts'
import { fixtureFootprint, fixturePorts } from '../../domain/model.ts'
import { SYSTEM_COLOR, type Fixture } from '../../domain/types.ts'
import { useLevels } from '../../composables/useLevels.ts'
import { usePlanStore } from '../../stores/plan.ts'
import { useProjectStore } from '../../stores/project.ts'
import { useRoutingStore } from '../../stores/routing.ts'
import { useSelectionStore } from '../../stores/selection.ts'
import { useViewStore } from '../../stores/view.ts'
import { toPoints } from './svg.ts'

const plan = usePlanStore()
const levels = useLevels()
const projectStore = useProjectStore()
const selection = useSelectionStore()
const routing = useRoutingStore()
const view = useViewStore()

const CATEGORY_FILL: Record<string, string> = {
  sanitary: '#1e3a5f',
  kitchen: '#3f2f1a',
  appliance: '#2c2c40',
  electrical: '#3d2f10',
}

interface Drawn {
  fixture: Fixture
  points: string
  label: string
  fill: string
  centre: { x: number; y: number }
  ports: Array<{ id: string; x: number; y: number; color: string }>
  unreached: boolean
}

const onActiveLevel = computed(() => {
  const rooms = new Set(levels.activeRooms.value.map((r) => r.id))
  return projectStore.project.fixtures.filter((f) => rooms.has(f.roomId))
})

const drawn = computed<Drawn[]>(() =>
  onActiveLevel.value.flatMap((fixture) => {
    const footprint = fixtureFootprint(projectStore.project, fixture)
    if (footprint.length === 0) return []
    const def = fixtureDef(fixture.type)
    const centre = footprint.reduce(
      (acc, p) => ({ x: acc.x + p.x / footprint.length, y: acc.y + p.y / footprint.length }),
      { x: 0, y: 0 },
    )
    return [
      {
        fixture,
        points: toPoints(footprint),
        label: fixture.name,
        fill: CATEGORY_FILL[def.category] ?? '#26303f',
        centre,
        ports: fixturePorts(projectStore.project, fixture).map((port) => ({
          id: `${fixture.id}-${port.portId}`,
          x: port.position.x,
          y: port.position.y,
          color: SYSTEM_COLOR[port.kind],
        })),
        unreached: routing.unreachedFixtureIds.has(fixture.id),
      },
    ]
  }),
)

function grab(event: PointerEvent, fixtureId: string): void {
  if (view.tool.kind !== 'select' || event.button !== 0) return
  event.stopPropagation()
  selection.select({ kind: 'fixture', id: fixtureId })
  plan.beginMoveFixture(fixtureId)
}

const showLabels = computed(() => plan.mmPerPx < 8)
const portRadius = computed(() => Math.max(28, 3 * plan.mmPerPx))
</script>

<template>
  <g v-if="view.showFixtures">
    <g v-for="item in drawn" :key="item.fixture.id">
      <polygon
        :points="item.points"
        :fill="item.fill"
        :stroke="
          selection.isSelected('fixture', item.fixture.id)
            ? 'var(--color-accent)'
            : item.unreached
              ? '#f87171'
              : '#64748b'
        "
        :stroke-width="(selection.isSelected('fixture', item.fixture.id) ? 3 : 1.5) * plan.mmPerPx"
        style="cursor: move"
        @pointerdown="grab($event, item.fixture.id)"
        @pointerenter="selection.hover({ kind: 'fixture', id: item.fixture.id })"
        @pointerleave="selection.hover(null)"
      />

      <circle
        v-for="port in item.ports"
        :key="port.id"
        :cx="port.x"
        :cy="-port.y"
        :r="portRadius"
        :fill="port.color"
        stroke="#0a0e14"
        :stroke-width="0.8 * plan.mmPerPx"
        pointer-events="none"
      />

      <text
        v-if="showLabels"
        :x="item.centre.x"
        :y="-item.centre.y"
        :font-size="10 * plan.mmPerPx"
        text-anchor="middle"
        dominant-baseline="middle"
        fill="#e2e8f0"
        pointer-events="none"
      >
        {{ item.label }}
      </text>
    </g>

    <!-- Where the fixture about to be placed would land. -->
    <g v-if="view.tool.kind === 'fixture' && plan.wallUnderCursor" pointer-events="none">
      <circle
        :cx="plan.wallUnderCursor.point.x"
        :cy="-plan.wallUnderCursor.point.y"
        :r="6 * plan.mmPerPx"
        fill="none"
        stroke="var(--color-accent)"
        :stroke-width="2 * plan.mmPerPx"
      />
    </g>
  </g>
</template>
