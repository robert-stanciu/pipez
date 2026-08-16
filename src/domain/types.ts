/**
 * The project data model. Pure data — no Vue, no DOM, no three.js.
 *
 * All lengths are in **millimetres**, all angles in radians, all slopes as ratios (0.02 = 2%).
 */

import type { Vec2, Vec3 } from './geometry/vec.ts'

export type Id = string

/* ------------------------------------------------------------------ services */

/** The five networks the solver produces. */
export type SystemKind = 'cold' | 'hot' | 'waste' | 'power' | 'heating'

export const SYSTEM_KINDS: SystemKind[] = ['cold', 'hot', 'waste', 'power', 'heating']

export const SYSTEM_LABEL: Record<SystemKind, string> = {
  cold: 'Cold water',
  hot: 'Hot water',
  waste: 'Waste',
  power: 'Electrical',
  heating: 'Underfloor heating',
}

/** Shared between the 2D overlay and the 3D meshes so the two views read as one drawing. */
export const SYSTEM_COLOR: Record<SystemKind, string> = {
  cold: '#3b82f6',
  hot: '#ef4444',
  waste: '#8b7355',
  power: '#f59e0b',
  heating: '#a855f7',
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

/**
 * What the floor of a room is finished in.
 *
 * The only property that matters here is its thermal resistance, and it is the single biggest
 * lever on an underfloor heating design: the same pipe at the same water temperature under
 * carpet gives less than half what it gives under tile. EN 1264-2 draws its characteristic
 * curves against R_λB = 0,10 m²K/W, which is roughly an engineered wood floor.
 */
export type FloorCovering = 'tile' | 'stone' | 'laminate' | 'wood' | 'carpet'

/**
 * Underfloor heating in one room.
 *
 * Everything is nullable and falls back to the project: a house is laid at one pitch, off one
 * flow temperature, in one covering, and only the rooms that differ — the bathroom that is
 * warmer and tiled, the utility room that is not heated at all — need saying.
 */
export interface RoomHeating {
  enabled: boolean
  /** Pipe pitch, mm. */
  spacing: number | null
  /** Design air temperature, °C. */
  roomTempC: number | null
  covering: FloorCovering | null
  /** Manifold that serves it; null picks the nearest one on the same storey. */
  manifoldId: Id | null
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
  /**
   * Underfloor heating. Added after the first release, so a file written before it simply
   * gets the project defaults — which is what an unannotated room means anyway.
   */
  heating?: RoomHeating
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

/**
 * Which face of an appliance the water and waste connect to.
 *
 * `bottom` takes them down through the floor beneath the appliance — pipes in the plinth, or
 * buried in the screed. `back` takes them horizontally into the wall behind it and drops them
 * inside the wall instead, which is what wall-hung sanitaryware and a back-to-wall WC need,
 * and what you use when the slab must not be broken into.
 *
 * Cables are not affected: a socket is always fed from behind.
 */
export type ConnectionEntry = 'bottom' | 'back'

export interface Fixture {
  id: Id
  type: FixtureType
  name: string
  roomId: Id
  /** Overrides the project default. Null means "whatever the project says". */
  entry: ConnectionEntry | null
  /**
   * Take this load across all three lines rather than one. Only meaningful for a fixed
   * appliance on its own circuit; null follows the catalogue, which is single-phase.
   */
  threePhase: boolean | null
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

export type ServiceKind =
  | 'waterEntry'
  | 'wasteOutlet'
  | 'electricalPanel'
  | 'heatingManifold'

export const SERVICE_LABEL: Record<ServiceKind, string> = {
  waterEntry: 'Water entry',
  wasteOutlet: 'Waste outlet',
  electricalPanel: 'Consumer unit',
  heatingManifold: 'Heating manifold',
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

/**
 * What the pressurised pipework is made of.
 *
 * This is not decoration: each material is sold in its own ladder of **outside** diameters
 * with its own bore, and EN 806-3 gives a separate sizing table for each. A Romanian house is
 * almost always PP-R or multilayer composite; copper is the standard's reference material and
 * PE-X is the table the two plastics above borrow their capacities from.
 */
export type SupplyMaterial = 'copper' | 'PPR' | 'PEX-AL-PEX' | 'PE-X'

/**
 * Where the horizontal water distribution lives.
 *
 * `ceiling` runs it in the ceiling void and drops to each draw-off point: the slab is never
 * broken into and the pipe stays reachable, at the cost of a long drop to a bath filler or a
 * cistern.
 *
 * `floor` runs it in the floor build-up and rises to each point, which is what a PP-R or
 * composite job in Romania usually is — short runs to sanitaryware, and the pipe goes in with
 * the screed that is being laid anyway. Anything high up pays for it on the way back.
 */
export type SupplyRoute = 'ceiling' | 'floor'

export interface SupplySettings {
  material: SupplyMaterial
  route: SupplyRoute
  /**
   * Flow pressure the incoming main can be relied on to deliver at the water entry, kPa.
   * Everything the installation spends — the climb to the top floor and the friction along
   * the way — comes out of this, and EN 806-3 §4.3 wants 100 kPa still left at every tap.
   */
  entryPressureKpa: number
}

/**
 * The pipe a loop is coiled from.
 *
 * Underfloor heating pipe is sold by outside diameter and wall, in coils rather than bars,
 * and the diameter is the thing that decides how long a loop may be: the pipe has to carry
 * its own heat *and* come back to the manifold on a domestic pump's head.
 */
export type UfhPipeId = 'pert16' | 'pert17' | 'pert20' | 'multi16'

/**
 * How the coil is set out in a room.
 *
 * `serpentine` walks the room in parallel runs and comes back round the perimeter, which is
 * the only pattern that can be set out reliably in a room of any shape.
 *
 * `perimeter` is the same thing without the interior field — a single run round the room —
 * for a space too small or too obstructed to meander in.
 */
export type LoopPattern = 'serpentine' | 'perimeter'

export interface HeatingSettings {
  pipe: UfhPipeId
  /** Pipe pitch, mm. */
  spacing: number
  /** Flow temperature at the manifold, °C. */
  flowTempC: number
  /** Design drop across a loop, K. Flow minus return. */
  deltaTK: number
  /** Design air temperature for a room that does not say otherwise, °C. */
  roomTempC: number
  covering: FloorCovering
  pattern: LoopPattern
  /** Screed over the crown of the pipe, mm. EN 1264-4 wants at least 45. */
  screedCover: number
  /** Thermal resistance of the insulation under the pipe, m²K/W. */
  insulationR: number
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
  /** Default for appliances that do not override it. */
  connectionEntry: ConnectionEntry
  electrical: ElectricalSettings
  standards: 'EN'
  drainage: DrainageSettings
  supply: SupplySettings
  heating: HeatingSettings
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

export type FittingKind =
  | 'elbow'
  | 'tee'
  | 'reducer'
  | 'coupling'
  | 'trap'
  | 'stack'
  | 'terminal'
  /** Air admittance valve — lets air into the stack, never lets anything out. */
  | 'aav'

/**
 * What a run is doing, which changes both how it is sized and what it is called on the
 * schedule. A `stack` crosses a storey — a soil stack, a rising main, a cable riser — and is
 * sized by the stack tables rather than the branch ones. A `collector` is the drain below the
 * stack foot, sized from its gradient rather than from its load and never smaller than DN100.
 */
/**
 * `tail` is the connection between an appliance and the pipework proper — the short run off
 * the trap into the wall behind it, before anything turns vertical. It is graded like a
 * branch but it lives at appliance height by definition, so the checks that keep buried
 * drainage under the floor do not apply to it.
 */
/**
 * `loop` is the heating coil itself — the pipe inside the room, laid in the screed. It is not
 * a branch of anything: it leaves the manifold, covers the floor and comes back, with no
 * joint anywhere along it, which is why it is never given fittings.
 *
 * `primary` is the flow-and-return pair between the heat source and a manifold, which is
 * ordinary pipe in an ordinary size and has nothing to do with the coil.
 */
export type SegmentRole =
  | 'branch'
  | 'tail'
  | 'stack'
  | 'drop'
  | 'bend'
  | 'vent'
  | 'collector'
  | 'loop'
  | 'primary'

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
  /**
   * A stable name for *what* was found, where something downstream has to act on it rather
   * than merely show it. The message is written for a person and is free to be rewritten; a
   * code is not, so anything reading a finding back reads this. Only set where something
   * does read it — most warnings are for the Checks column and need none.
   */
  code?: WarningCode
}

/** Findings something else in the app reacts to. */
export type WarningCode = 'hot-dead-leg'

export type Phase = 'L1' | 'L2' | 'L3'

/**
 * How the building is fed.
 *
 * A three-phase supply gives 400 V between lines and 230 V line-to-neutral (the older name
 * for the same thing is 380/220 V). Most circuits still run at 230 V off one phase; the point
 * of the three is that the load can be spread across them, and that a big fixed load — a
 * cooker, a heat pump, a workshop machine — can be taken across all three and draw a third
 * of the current it would on one.
 */
export type SupplySystem = 'single-phase' | 'three-phase'

/**
 * Where the horizontal cable runs live.
 *
 * DIN 18015-3 gives a permitted band near the ceiling and another near the floor, and both
 * are used in practice: ceiling routing suits a slab you would rather not chase, floor
 * routing suits a screed that is going down anyway and puts the runs near the sockets.
 */
export type CableRoute = 'ceiling' | 'floor'

/**
 * How the installation is earthed.
 *
 * Romanian distribution is normally TN-C up to the boundary and either TN-C-S or TT inside.
 * The choice decides what protects against an insulation fault: on TN the fault current is
 * large enough for the breaker to clear it, on TT it is limited by two electrodes in series
 * and the residual current device is the only thing that will ever trip.
 */
export type EarthingSystem = 'TN-S' | 'TN-C-S' | 'TT'

/**
 * Reference installation method, HD 60364-5-52 Table B.52.4. A1/A2 are conductors in a
 * conduit in a thermally insulated wall, B1/B2 in a conduit on or chased into a wall, C
 * clipped direct.
 */
export type InstallationMethod = 'A1' | 'A2' | 'B1' | 'B2' | 'C'

/** Trip curve, EN 60898-1: B trips at 3–5 × In, C at 5–10 ×. */
export type McbCurve = 'B' | 'C'

/**
 * Residual current device type, IEC 62423 / HD 60364-5-53. AC responds to sinusoidal
 * residual current only and is no longer accepted for circuits with electronic loads; A adds
 * pulsating d.c., F adds the composite waveform a single-phase inverter drive produces, B
 * adds smooth d.c.
 */
export type RcdType = 'A' | 'F' | 'B'

/** Surge protection fitted at the origin, HD 60364-5-534. */
export type SurgeProtection = 'none' | 'type-1' | 'type-2' | 'type-1+2'

/** The surge protective device as it sits on the rail. */
export interface SpdSpec {
  kind: SurgeProtection
  /** Modules it occupies, immediately after the main switch. */
  modules: number
  /** Protection level, kV — what the device lets through to the installation. */
  upKv: number
  /** Nominal discharge current, kA (8/20 µs). */
  inKa: number
  /** Backup overcurrent device, amps, where the incomer is too large to serve as one. */
  backupBreakerAmps: number | null
}

export interface ElectricalSettings {
  supply: SupplySystem
  cableRoute: CableRoute
  /** Line-to-neutral, volts. */
  voltage: number
  /** Line-to-line, volts. Only meaningful on a three-phase supply. */
  lineVoltage: number
  /** Rating of the main incoming switch, per phase. */
  mainBreakerAmps: number
  /** Circuits per residual current device before another one is added. */
  circuitsPerRcd: number
  /**
   * Added after the first release, so a file written before them simply gets the defaults in
   * `standards/electrical.ts` — TN-C-S, method B1, a Type 2 surge arrester and rails of
   * twelve, which is what a new Romanian domestic board is.
   */
  earthing?: EarthingSystem
  installationMethod?: InstallationMethod
  surgeProtection?: SurgeProtection
  /** Modules on one rail. Romanian enclosures are built in rows of twelve or eighteen. */
  modulesPerRow?: 12 | 18
}

export interface Circuit {
  id: Id
  /** The consumer unit this circuit starts from. */
  panelId: Id
  kind: ElectricalCircuitKind
  name: string
  /** Fixtures served by this circuit. */
  fixtureIds: Id[]
  breakerAmps: number
  /** Trip curve of the breaker, and the short-circuit current it can break, amps. */
  curve: McbCurve
  icn: number
  /** Conductor cross-section, mm². */
  cableMm2: number
  /** Protective conductor cross-section, HD 60364-5-54 Table 54.2, mm². */
  peMm2: number
  totalWatts: number
  rcdProtected: boolean

  /** One phase for a 230 V circuit, all three for a 400 V one. */
  poles: 1 | 3
  phases: Phase[]
  /** Live cores plus neutral plus protective earth. */
  cores: number
  /** Current the circuit is designed to draw, per line. */
  designCurrent: number
  /**
   * The current volt drop is assessed at. For a socket circuit that is the breaker rating,
   * because what gets plugged in later is unknown; for a fixed load it is what it draws.
   */
  assessedCurrent: number
  /** What that load counts as when sizing the incomer, after diversity. */
  diversifiedCurrent: number
  /** Routed length of the longest run on this circuit, mm. */
  routeLength: number
  /**
   * Volt drop at the furthest point of utilisation, measured **from the origin of the
   * installation** — so a circuit on a sub-board carries its submain's drop as well. That is
   * the figure HD 60364-5-52 Annex G sets the limit against.
   */
  voltDropPercent: number
  /** The circuit's own share of it, from its board to the furthest terminal. */
  circuitDropPercent: number
  /** Reference method the conductor was sized by. */
  installationMethod: InstallationMethod
  /** Circuits bunched with this one on its busiest length of chase, this one included. */
  groupedWith: number
  /** Grouping factor Cg for that count, HD 60364-5-52 Table B.52.17. */
  groupingFactor: number
  /** Current-carrying capacity after derating: Iz = It · Ca · Cg · Ci, amps. */
  currentCapacity: number
  /** Which residual current device this sits behind. */
  rcdGroup: number
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

/* --------------------------------------------------------------------- panel */

export interface RcdGroup {
  index: number
  /** Trip current, milliamps. */
  sensitivity: number
  /** Waveform the device can detect — 30 mA on its own is not a specification. */
  type: RcdType
  poles: 2 | 4
  circuitIds: Id[]
  /** Modules this device occupies on the rail. */
  modules: number
}

export interface PanelWay {
  /** Position on the rail, counted in modules from the left. */
  slot: number
  modules: number
  circuit: Circuit
}

/**
 * The consumer unit as it would actually be built: what sits on the rail, in what order,
 * behind which residual current device, on which phase.
 */
export interface PanelDesign {
  /** The service point this board is. */
  id: Id
  name: string
  levelId: Id
  /** The board the incoming supply lands on; the others are fed from it. */
  isMain: boolean
  /** Conductor feeding a sub-board from the main one, mm². Null on the main board. */
  submainMm2: number | null
  submainLength: number
  supply: SupplySystem
  mainBreakerAmps: number
  /** Modules the main switch occupies. */
  mainSwitchModules: number
  /** Surge arrester sitting immediately downstream of it, or null where none is fitted. */
  spd: SpdSpec | null
  /** How this board is earthed, and the main protective bonding conductor it needs, mm². */
  earthing: EarthingSystem
  mainBondingMm2: number
  rcdGroups: RcdGroup[]
  ways: PanelWay[]
  /** Total modules used, and the next standard enclosure that holds them. */
  modulesUsed: number
  enclosureModules: number
  rows: number
  /** Modules on one rail, which is what the row packing is done against. */
  modulesPerRow: number
  /** Circuit-count factor applied to the maximum demand, IEC Electrical Installation Guide. */
  ks: number
  /** Diversified load carried by each line. */
  phaseLoad: Record<Phase, number>
  /** Spread between the busiest and quietest line, as a percentage of the mean. */
  imbalancePercent: number
  /** The same spread in amps, which is what actually flows down the neutral. */
  imbalanceAmps: number
  /** Maximum demand across the whole installation, per line. */
  maximumDemand: number
}

/* ------------------------------------------------------------------ heating */

/**
 * One heating loop, as it would appear on the manifold schedule.
 *
 * A loop is a single unbroken length of pipe: out of the manifold, across the floor of one
 * room (or one part of one room), and back. Everything below is measured on that whole
 * length, leaders included, because that is what has to be cut off the coil and that is what
 * the pump has to push water through.
 */
export interface HeatingLoop {
  id: Id
  /** Manifold this loop is ported on, and its port number there, counting from 1. */
  manifoldId: Id
  port: number
  roomId: Id
  roomName: string
  levelId: Id
  /** Distinguishes the loops of a room that needed more than one. */
  partOf: number
  /** Total pipe, mm — the coil plus both leaders. */
  length: number
  /** Floor area this loop covers, m². */
  area: number
  spacing: number
  covering: FloorCovering
  /** Design air temperature of the room it heats, °C. */
  roomTempC: number
  /** Upward output, W/m², and the whole loop's share of it. */
  fluxW: number
  outputW: number
  /** Downward loss through the insulation, W/m². */
  downwardW: number
  /** Mean floor surface temperature, °C, and the limit it is held against. */
  surfaceTempC: number
  surfaceLimitC: number
  /** Water side: mass flow (kg/h), velocity (m/s) and the pressure it costs (kPa). */
  flowKgH: number
  velocity: number
  pressureDropKpa: number
}

/**
 * A manifold as it would be ordered and commissioned: how many ports, what flows through
 * them, and what the pump at its foot has to be able to do.
 */
export interface ManifoldDesign {
  /** The service point this manifold is. */
  id: Id
  name: string
  levelId: Id
  /** Ports actually used, and the size of manifold that holds them. */
  loops: number
  ports: number
  flowTempC: number
  returnTempC: number
  /** Total output and total flow through the manifold. */
  outputW: number
  flowKgH: number
  /** Worst loop's resistance plus the manifold's own, kPa — what the pump has to deliver. */
  pumpHeadKpa: number
  /** Shortest and longest loop on the manifold, mm; the spread is what the valves balance. */
  shortestLoop: number
  longestLoop: number
  /** Size of the primary flow and return reaching it, mm, and how far away the source is. */
  primarySize: number
  primaryLength: number
}

export interface RoutingResult {
  networks: Network[]
  circuits: Circuit[]
  /** One design per consumer unit; empty until there is a board with something in it. */
  panels: PanelDesign[]
  /** One per heating manifold, and every loop ported on one. */
  manifolds: ManifoldDesign[]
  loops: HeatingLoop[]
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
  panels: [],
  manifolds: [],
  loops: [],
  warnings: [],
  bom: [],
  stats: { solveMs: 0, graphNodes: 0, graphEdges: 0 },
}
