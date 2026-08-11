/**
 * The project data model. Pure data — no Vue, no DOM, no three.js.
 *
 * All lengths are in **millimetres**, all angles in radians, all slopes as ratios (0.02 = 2%).
 */

import type { Vec2, Vec3 } from './geometry/vec.ts'

export type Id = string

/* ------------------------------------------------------------------ services */

/** The four networks the solver produces. */
export type SystemKind = 'cold' | 'hot' | 'waste' | 'power'

export const SYSTEM_KINDS: SystemKind[] = ['cold', 'hot', 'waste', 'power']

export const SYSTEM_LABEL: Record<SystemKind, string> = {
  cold: 'Cold water',
  hot: 'Hot water',
  waste: 'Waste',
  power: 'Electrical',
}

/** Shared between the 2D overlay and the 3D meshes so the two views read as one drawing. */
export const SYSTEM_COLOR: Record<SystemKind, string> = {
  cold: '#3b82f6',
  hot: '#ef4444',
  waste: '#8b7355',
  power: '#f59e0b',
}

/* -------------------------------------------------------------------- levels */

export interface Level {
  id: Id
  name: string
  /** Storey order, 0 at the bottom. Contiguous, and the sort key everywhere. */
  index: number
  /**
   * Finished floor elevation above the project datum.
   *
   * Derived: `relevel()` recomputes it from the stack of storey heights and slabs below.
   * It is stored rather than computed on demand because rooms, fixtures and the router all
   * read elevations constantly, and a level's own height is what the user actually edits.
   */
  elevation: number
  /** Floor-to-ceiling height of this storey. */
  height: number
  /** Structural slab between this storey's ceiling and the floor above. */
  slabThickness: number
}

/* --------------------------------------------------------------------- rooms */

export interface Wall {
  id: Id
  /** Index of the outline edge this wall covers: outline[index] -> outline[index + 1]. */
  index: number
  /** Load-bearing walls are a hard exclusion for the router — no penetrations. */
  loadBearing: boolean
}

export interface Room {
  id: Id
  name: string
  /** The storey this room belongs to. */
  levelId: Id
  /** Closed polygon of the room's **inner** face, counter-clockwise. */
  outline: Vec2[]
  /** Floor-to-ceiling height. */
  height: number
  /** Finished floor elevation. Derived from the level; kept here so the geometry helpers
   *  and the router can read it without a lookup. */
  floorZ: number
  /**
   * Uniform for the whole room, which keeps the offset outlines (centreline and outer face)
   * well defined at every corner. Per-wall thickness would need mitre handling that a
   * domestic floor plan never actually calls for.
   */
  wallThickness: number
  /** Index-aligned with the outline edges; regenerated when the vertex count changes. */
  walls: Wall[]
}

export type OpeningKind = 'door' | 'passage' | 'window'

export interface Opening {
  id: Id
  kind: OpeningKind
  roomId: Id
  wallIndex: number
  /** Distance along the wall from its start vertex to the opening's centre. */
  offset: number
  width: number
  /** Height of the opening's underside above the room floor. */
  sillHeight: number
  height: number
  /** The room on the far side, when this opening links two rooms. */
  connectsRoomId: Id | null
}

/* ------------------------------------------------------------------ fixtures */

export type PortKind = SystemKind

export interface PortDef {
  id: string
  kind: PortKind
  /**
   * Offset from the fixture anchor in fixture-local space:
   *   x — along the wall to the right, y — out from the wall face, z — up from the anchor.
   */
  offset: Vec3
  /** Nominal connection size: pipe DN in mm. */
  dn: number
}

export type ElectricalCircuitKind = 'lighting' | 'sockets' | 'appliance' | 'cooker'

export interface FixtureLoads {
  /** EN 12056-2 discharge unit, l/s. */
  drainageDu?: number
  /** EN 806-3 loading units, l/s. */
  supplyLuCold?: number
  supplyLuHot?: number
  watts?: number
  circuit?: ElectricalCircuitKind
}

export type FixtureType =
  | 'basin'
  | 'sink'
  | 'shower'
  | 'bathtub'
  | 'wc'
  | 'bidet'
  | 'washing-machine'
  | 'dishwasher'
  | 'tumble-dryer'
  | 'water-heater'
  | 'floor-drain'
  | 'socket'
  | 'ceiling-light'
  | 'cooker'

export interface FixtureDef {
  type: FixtureType
  label: string
  category: 'sanitary' | 'kitchen' | 'appliance' | 'electrical'
  mount: 'wall' | 'floor' | 'ceiling'
  size: { width: number; depth: number; height: number }
  /** Default anchor height above the room floor. */
  defaultZ: number
  ports: PortDef[]
  loads: FixtureLoads
}

export interface Fixture {
  id: Id
  type: FixtureType
  name: string
  roomId: Id
  /** Wall the fixture is anchored to, or null when it stands free on the floor. */
  wallIndex: number | null
  /** Wall-anchored: distance along the wall from its start vertex to the fixture's centre. */
  wallOffset: number
  /** Free-standing only. */
  position: Vec2
  /** Free-standing only; wall-anchored fixtures take their facing from the wall normal. */
  rotation: number
  /** Anchor height above the room floor. */
  z: number
}

/* ------------------------------------------------------------- service points */

export type ServiceKind = 'waterEntry' | 'wasteOutlet' | 'electricalPanel'

export const SERVICE_LABEL: Record<ServiceKind, string> = {
  waterEntry: 'Water entry',
  wasteOutlet: 'Waste outlet',
  electricalPanel: 'Consumer unit',
}

export interface ServicePoint {
  id: Id
  kind: ServiceKind
  name: string
  /** The storey the point sits on. */
  levelId: Id
  /** Room the point sits in, when it is inside one. */
  roomId: Id | null
  position: Vec2
  /**
   * Elevation relative to the level datum. For the waste outlet this is the **invert
   * level** and is usually negative — the whole drainage network falls towards it.
   */
  z: number
}

/* ------------------------------------------------------------------- project */

/**
 * How drainage is set out in plan.
 *
 * `rectilinear` keeps every run parallel to a wall — the conventional layout, easiest to
 * support and to find again later.
 *
 * `diagonal` lets a horizontal run take **any** bearing: straight from where it drops to
 * where it rises again. No fitting is needed to achieve the angle, because the pipe never
 * turns while horizontal — the bearing is simply whichever way the straight run points, and
 * the only fittings involved are the 45° pairs that take it from vertical to horizontal and
 * back. Shorter runs, fewer fittings, less fall used up.
 */
export type DrainageStrategy = 'rectilinear' | 'diagonal'

export interface DrainageSettings {
  strategy: DrainageStrategy
  /** Minimum acceptable fall; below this the run is flagged. */
  minSlope: number
  /** What the solver aims for. */
  designSlope: number
  /** Above this, solids outrun the water and the run is flagged. */
  maxSlope: number
}

export interface ProjectSettings {
  /** Defaults applied to newly created rooms and walls. */
  wallThickness: number
  wallHeight: number
  /** Default slab thickness for a newly added storey. */
  slabThickness: number
  /** Depth available beneath the finished floor for drainage falls. */
  floorBuildUp: number
  /** Depth available beneath the ceiling for supply pipe and cable runs. */
  ceilingVoid: number
  /** Snapping grid for the plan editor. */
  gridPitch: number
  standards: 'EN'
  drainage: DrainageSettings
}

export interface Project {
  schemaVersion: number
  id: Id
  name: string
  createdAt: string
  updatedAt: string
  settings: ProjectSettings
  /** At least one, ordered by `index`. */
  levels: Level[]
  rooms: Room[]
  openings: Opening[]
  fixtures: Fixture[]
  servicePoints: ServicePoint[]
}

/* ------------------------------------------------------------ routing output */

export type FittingKind = 'elbow' | 'tee' | 'reducer' | 'coupling' | 'trap' | 'stack' | 'terminal'

/**
 * What a run is doing, which changes both how it is sized and what it is called on the
 * schedule. A `stack` crosses a storey — a soil stack, a rising main, a cable riser — and is
 * sized by the stack tables rather than the branch ones.
 */
export type SegmentRole = 'branch' | 'stack' | 'drop' | 'bend'

export interface Segment {
  id: Id
  system: SystemKind
  a: Vec3
  b: Vec3
  /** Pipe nominal diameter in mm, or cable cross-section in mm² for power. */
  size: number
  /** Accumulated load: DU for waste, LU for supply, amps for power. */
  load: number
  length: number
  role: SegmentRole
  /** Fall along the segment as a ratio; waste only. */
  slope?: number
  circuitId?: Id
}

export interface Fitting {
  id: Id
  kind: FittingKind
  system: SystemKind
  position: Vec3
  size: number
  /** Turn angle in degrees for elbows. */
  angle?: number
  /** Unit direction the run arrives on, and the one it leaves on. Elbows only. */
  dirIn?: Vec3
  dirOut?: Vec3
}

export type WarningSeverity = 'error' | 'warning' | 'info'

export interface RoutingWarning {
  id: Id
  severity: WarningSeverity
  system: SystemKind
  message: string
  position?: Vec3
  fixtureId?: Id
}

export interface Circuit {
  id: Id
  kind: ElectricalCircuitKind
  name: string
  /** Fixtures served by this circuit. */
  fixtureIds: Id[]
  breakerAmps: number
  /** Conductor cross-section, mm². */
  cableMm2: number
  totalWatts: number
  rcdProtected: boolean
}

export interface Network {
  system: SystemKind
  segments: Segment[]
  fittings: Fitting[]
  totalLength: number
  /** Fixtures the solver could not reach. */
  unreachedFixtureIds: Id[]
}

export interface BomLine {
  system: SystemKind
  item: string
  /** 'm' for pipe and cable runs, 'pc' for fittings. */
  unit: 'm' | 'pc'
  quantity: number
}

export interface RoutingResult {
  networks: Network[]
  circuits: Circuit[]
  warnings: RoutingWarning[]
  bom: BomLine[]
  stats: {
    solveMs: number
    graphNodes: number
    graphEdges: number
  }
}

export const EMPTY_RESULT: RoutingResult = {
  networks: [],
  circuits: [],
  warnings: [],
  bom: [],
  stats: { solveMs: 0, graphNodes: 0, graphEdges: 0 },
}
