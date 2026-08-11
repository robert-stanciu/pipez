/**
 * The plan editor: camera, snapping and the drag state machine.
 *
 * Interaction lives in a store rather than in the canvas component because the shapes that
 * start a drag are separate components — a room, a wall, a fixture glyph — and threading a
 * gesture through props and emits would be far more code than it is worth.
 */

import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { nearestWall, offsetWall, snapLines, snapPoint, type SnapLines } from '../domain/edit.ts'
import { bounds, edgesOf, rectangle, unionBounds } from '../domain/geometry/polygon.ts'
import { clamp, dist2, sub2 } from '../domain/geometry/vec.ts'
import { outerOutline } from '../domain/model.ts'
import type { Vec2 as Point } from '../domain/geometry/vec.ts'
import { useProjectStore } from './project.ts'
import { useSelectionStore } from './selection.ts'
import { useViewStore } from './view.ts'

/** Screen y grows downward, plan y grows north — one negation, applied at the boundary. */
export const sx = (x: number): number => x
export const sy = (y: number): number => -y

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; from: Point; centre: Point }
  | { kind: 'drawRoom'; from: Point; to: Point }
  | { kind: 'moveRoom'; roomId: string; grab: Point; origin: Point[] }
  | { kind: 'pushWall'; roomId: string; wallIndex: number; from: Point }
  | { kind: 'moveFixture'; fixtureId: string }
  | { kind: 'moveService'; id: string }

const MIN_MM_PER_PX = 0.4
const MAX_MM_PER_PX = 60
const SNAP_PIXELS = 9

export const usePlanStore = defineStore('plan', () => {
  /** Plan coordinate at the centre of the viewport. */
  const centre = ref<Point>({ x: 2000, y: 1400 })
  /** Zoom, expressed as millimetres per screen pixel. */
  const mmPerPx = ref(4)
  const size = ref({ width: 800, height: 600 })

  const drag = shallowRef<Drag>({ kind: 'none' })
  const guides = ref<{ x: number | null; y: number | null }>({ x: null, y: null })
  const cursor = ref<Point | null>(null)

  const viewBox = computed(() => {
    const w = size.value.width * mmPerPx.value
    const h = size.value.height * mmPerPx.value
    return `${centre.value.x - w / 2} ${sy(centre.value.y) - h / 2} ${w} ${h}`
  })

  /** Spacing of the drawn grid, stepped so it never becomes a grey wash when zoomed out. */
  const gridStep = computed(() => {
    const target = 60 * mmPerPx.value
    for (const step of [50, 100, 250, 500, 1000, 2000, 5000, 10_000]) {
      if (step >= target) return step
    }
    return 10_000
  })

  function setSize(width: number, height: number): void {
    size.value = { width: Math.max(1, width), height: Math.max(1, height) }
  }

  /** Client coordinates to plan coordinates. */
  function toWorld(clientX: number, clientY: number, rect: DOMRect): Point {
    const w = size.value.width * mmPerPx.value
    const h = size.value.height * mmPerPx.value
    const left = centre.value.x - w / 2
    const top = sy(centre.value.y) - h / 2
    const screenX = left + ((clientX - rect.left) / rect.width) * w
    const screenY = top + ((clientY - rect.top) / rect.height) * h
    return { x: screenX, y: -screenY }
  }

  function zoomAt(point: Point, factor: number): void {
    const next = clamp(mmPerPx.value * factor, MIN_MM_PER_PX, MAX_MM_PER_PX)
    const ratio = next / mmPerPx.value
    // Keep the plan point under the cursor fixed while the scale changes.
    centre.value = {
      x: point.x + (centre.value.x - point.x) * ratio,
      y: point.y + (centre.value.y - point.y) * ratio,
    }
    mmPerPx.value = next
  }

  function fitToProject(): void {
    const projectStore = useProjectStore()
    const rooms = projectStore.project.rooms
    if (rooms.length === 0) {
      centre.value = { x: 2000, y: 1400 }
      mmPerPx.value = 4
      return
    }
    const box = unionBounds(rooms.map((r) => bounds(outerOutline(r))))
    const width = Math.max(1000, box.max.x - box.min.x)
    const height = Math.max(1000, box.max.y - box.min.y)
    centre.value = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 }
    mmPerPx.value = clamp(
      Math.max(width / size.value.width, height / size.value.height) * 1.12,
      MIN_MM_PER_PX,
      MAX_MM_PER_PX,
    )
  }

  /* ------------------------------------------------------------------ snapping */

  let cachedLines: SnapLines = { xs: [], ys: [] }

  const refreshSnapLines = (excludeRoomId?: string): void => {
    cachedLines = snapLines(useProjectStore().project, excludeRoomId)
  }

  function snap(point: Point): Point {
    const projectStore = useProjectStore()
    const result = snapPoint(
      point,
      cachedLines,
      projectStore.project.settings.gridPitch,
      SNAP_PIXELS * mmPerPx.value,
    )
    guides.value = result.guides
    return result.point
  }

  /* -------------------------------------------------------------------- drags */

  function beginPan(at: Point): void {
    drag.value = { kind: 'pan', from: at, centre: { ...centre.value } }
  }

  function beginDrawRoom(at: Point): void {
    refreshSnapLines()
    const start = snap(at)
    drag.value = { kind: 'drawRoom', from: start, to: start }
  }

  function beginMoveRoom(roomId: string, at: Point): void {
    const projectStore = useProjectStore()
    const room = projectStore.project.rooms.find((r) => r.id === roomId)
    if (!room) return
    refreshSnapLines(roomId)
    projectStore.checkpoint()
    drag.value = { kind: 'moveRoom', roomId, grab: at, origin: room.outline.map((p) => ({ ...p })) }
  }

  function beginPushWall(roomId: string, wallIndex: number, at: Point): void {
    const projectStore = useProjectStore()
    refreshSnapLines(roomId)
    projectStore.checkpoint()
    drag.value = { kind: 'pushWall', roomId, wallIndex, from: at }
  }

  function beginMoveFixture(fixtureId: string): void {
    useProjectStore().checkpoint()
    drag.value = { kind: 'moveFixture', fixtureId }
  }

  function beginMoveService(id: string): void {
    useProjectStore().checkpoint()
    drag.value = { kind: 'moveService', id }
  }

  /** Called on every pointer move while a gesture is live. */
  function updateDrag(at: Point, panDelta?: { dx: number; dy: number }): void {
    const projectStore = useProjectStore()
    const state = drag.value

    switch (state.kind) {
      case 'pan': {
        if (!panDelta) return
        centre.value = {
          x: state.centre.x - panDelta.dx * mmPerPx.value,
          y: state.centre.y + panDelta.dy * mmPerPx.value,
        }
        return
      }
      case 'drawRoom': {
        drag.value = { ...state, to: snap(at) }
        return
      }
      case 'moveRoom': {
        const raw = sub2(at, state.grab)
        // Snap the room's own corner, not the pointer, so edges land flush on neighbours.
        const anchor = state.origin[0]
        const snapped = snap({ x: anchor.x + raw.x, y: anchor.y + raw.y })
        const delta = sub2(snapped, anchor)
        projectStore.setRoomOutline(
          state.roomId,
          state.origin.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })),
        )
        return
      }
      case 'pushWall': {
        const room = projectStore.project.rooms.find((r) => r.id === state.roomId)
        if (!room) return
        const edge = edgesOf(room.outline)[state.wallIndex]
        if (!edge) return
        // Project the pointer travel onto the wall normal, then snap the resulting face.
        const along = (at.x - edge.a.x) * edge.normal.x + (at.y - edge.a.y) * edge.normal.y
        const target = {
          x: edge.a.x + edge.normal.x * along,
          y: edge.a.y + edge.normal.y * along,
        }
        const snapped = snap(target)
        const distance =
          (snapped.x - edge.a.x) * edge.normal.x + (snapped.y - edge.a.y) * edge.normal.y
        projectStore.setRoomOutline(state.roomId, offsetWall(room.outline, state.wallIndex, distance))
        return
      }
      case 'moveFixture': {
        projectStore.moveFixtureTo(state.fixtureId, snap(at))
        return
      }
      case 'moveService': {
        projectStore.moveServicePointTo(state.id, snap(at))
        return
      }
      default:
        return
    }
  }

  function endDrag(): void {
    const state = drag.value
    if (state.kind === 'drawRoom') {
      const width = Math.abs(state.to.x - state.from.x)
      const depth = Math.abs(state.to.y - state.from.y)
      if (width >= 500 && depth >= 500) {
        const origin = { x: Math.min(state.from.x, state.to.x), y: Math.min(state.from.y, state.to.y) }
        const room = useProjectStore().addRoom(origin, width, depth, useViewStore().activeLevelId)
        useSelectionStore().select({ kind: 'room', id: room.id })
        useViewStore().resetTool()
      }
    }
    drag.value = { kind: 'none' }
    guides.value = { x: null, y: null }
  }

  /** Outline of the rectangle currently being dragged out, for the preview. */
  const draftRoom = computed(() => {
    const state = drag.value
    if (state.kind !== 'drawRoom') return null
    const origin = { x: Math.min(state.from.x, state.to.x), y: Math.min(state.from.y, state.to.y) }
    const width = Math.abs(state.to.x - state.from.x)
    const depth = Math.abs(state.to.y - state.from.y)
    return { outline: rectangle(origin, width, depth), width, depth }
  })

  /** Wall under the pointer on the active storey, previewing where a fixture would land. */
  const wallUnderCursor = computed(() => {
    const point = cursor.value
    if (!point) return null
    return nearestWall(useProjectStore().project, point, 700, useViewStore().activeLevelId)
  })

  const isDragging = computed(() => drag.value.kind !== 'none')

  /** Distance in plan millimetres corresponding to a handle a few pixels wide. */
  const pickRadius = computed(() => 8 * mmPerPx.value)

  const distanceTo = (p: Point): number => (cursor.value ? dist2(cursor.value, p) : Infinity)

  return {
    centre,
    mmPerPx,
    size,
    viewBox,
    gridStep,
    guides,
    cursor,
    drag,
    isDragging,
    draftRoom,
    wallUnderCursor,
    pickRadius,
    setSize,
    toWorld,
    zoomAt,
    fitToProject,
    snap,
    refreshSnapLines,
    beginPan,
    beginDrawRoom,
    beginMoveRoom,
    beginPushWall,
    beginMoveFixture,
    beginMoveService,
    updateDrag,
    endDrag,
    distanceTo,
  }
})
