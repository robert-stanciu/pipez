/**
 * EN 1264 — water-based embedded surface heating and cooling.
 *
 * Underfloor heating is sized the other way round from everything else in this app. A drain
 * is sized by what has to go down it and a cable by what has to go through it; a floor is
 * sized by **how warm its surface is allowed to get**, because the floor is a thing people
 * stand on. EN 1264-2 §4 caps the mean surface temperature at 29 °C in the occupied part of
 * a room, 33 °C in a bathroom, and 35 °C in the peripheral strip along an external wall —
 * and everything else follows from that ceiling.
 *
 * Three separate calculations live here and they are worth keeping apart:
 *
 *  - **What the floor can give.** The limiting flux at the surface limit, EN 1264-2 eq. (1):
 *    q_max = 8,92 · (θF,max − θi)^1,1. At 29 °C over a 20 °C room that is the familiar
 *    ~100 W/m², and it is a property of the room, not of the pipework.
 *
 *  - **What this floor does give.** A resistance model of the build-up, driven by the
 *    logarithmic mean water-to-room excess ΔθH the standard defines in §5. Pipe pitch enters
 *    it as a spreading resistance rather than as a table of a_T factors, which is the same
 *    physics the factors were fitted to and reads as arithmetic rather than as a lookup.
 *
 *  - **What the water has to do.** Mass flow from the output and the design drop, then the
 *    pressure it costs — which, with the loop length, is what actually limits how much floor
 *    one loop may cover.
 *
 * EN 1264-4 supplies the execution rules that are not thermal at all: at least 45 mm of
 * screed over the crown of the pipe, a minimum insulation resistance under it that depends on
 * what is below, an edge strip at every wall, and a movement joint around any heated field
 * over 40 m² or longer than 8 m on a side.
 */

import type { FloorCovering, UfhPipeId } from '../types.ts'

/* -------------------------------------------------------------------- the pipe */

export interface UfhPipe {
  id: UfhPipeId
  /** How the coil is labelled on the drawing and on the order. */
  label: string
  material: string
  /** Outside diameter, mm. */
  od: number
  wall: number
  /** Internal bore, mm — what the water sees. */
  bore: number
  /**
   * Longest single loop of this size, mm.
   *
   * EN 1264 sets no such table; what sets it is the pressure drop reaching the limit a
   * domestic circulator can cover, and these are the lengths the trade works to for that
   * reason. The pressure check below is the real constraint — this is the sanity rail.
   */
  maxLoopLength: number
}

export const UFH_PIPES: Record<UfhPipeId, UfhPipe> = {
  pert16: {
    id: 'pert16',
    label: 'Ø16 × 2,0 PE-RT',
    material: 'PE-RT with oxygen barrier',
    od: 16,
    wall: 2,
    bore: 12,
    maxLoopLength: 100_000,
  },
  pert17: {
    id: 'pert17',
    label: 'Ø17 × 2,0 PE-RT',
    material: 'PE-RT with oxygen barrier',
    od: 17,
    wall: 2,
    bore: 13,
    maxLoopLength: 110_000,
  },
  pert20: {
    id: 'pert20',
    label: 'Ø20 × 2,0 PE-RT',
    material: 'PE-RT with oxygen barrier',
    od: 20,
    wall: 2,
    bore: 16,
    maxLoopLength: 130_000,
  },
  multi16: {
    id: 'multi16',
    label: 'Ø16 × 2,0 PE-X/Al/PE-X',
    material: 'multilayer composite',
    od: 16,
    wall: 2,
    bore: 12,
    maxLoopLength: 100_000,
  },
}

export const ufhPipe = (id: UfhPipeId): UfhPipe => UFH_PIPES[id] ?? UFH_PIPES.pert16

/** Pitches the trade sets out to. EN 1264 permits anything from 50 to 450 mm. */
export const SPACINGS = [100, 125, 150, 200, 250, 300]

/* --------------------------------------------------------------- the build-up */

/**
 * Thermal resistance of the floor covering, m²K/W — R_λB in EN 1264-2.
 *
 * The standard's own characteristic curves are drawn at 0,10, which is about what an
 * engineered wood floor comes to. Tile is effectively nothing, and carpet is the reason a
 * bedroom laid at the same pitch as the hall next door runs cold.
 */
export const COVERING_RESISTANCE: Record<FloorCovering, number> = {
  tile: 0.01,
  stone: 0.015,
  laminate: 0.075,
  wood: 0.1,
  carpet: 0.15,
}

export const COVERING_LABEL: Record<FloorCovering, string> = {
  tile: 'Ceramic tile',
  stone: 'Stone',
  laminate: 'Laminate',
  wood: 'Engineered wood',
  carpet: 'Carpet',
}

/** Cement-and-additive screed, W/mK — the layer the pipe is buried in. */
export const SCREED_CONDUCTIVITY = 1.2

/** Expanded polystyrene under the screed, W/mK. Used to turn a resistance into a thickness. */
export const INSULATION_CONDUCTIVITY = 0.035

/**
 * Total heat transfer coefficient at the floor surface, W/m²K — EN 1264-2 §6.1.
 *
 * Radiation and free convection off a warm horizontal surface, combined. It is fixed by the
 * standard rather than computed, which is what makes surface temperature and output two
 * readings of the same number.
 */
export const SURFACE_COEFFICIENT = 10.8

/** Screed over the crown of the pipe, mm — EN 1264-4 §4.2. */
export const MIN_SCREED_COVER = 45

/* ----------------------------------------------------- surface temperature caps */

/** EN 1264-2 §4, °C. */
export const MAX_SURFACE_TEMP = { occupied: 29, bathroom: 33, peripheral: 35 }

/** At or above this design air temperature a room is treated as a bathroom. */
export const BATHROOM_ROOM_TEMP = 24

/**
 * The surface temperature limit that applies to a room, °C.
 *
 * A bathroom is allowed a warmer floor because it is occupied barefoot and briefly, and
 * because it is designed several degrees warmer to begin with — which means the *excess* over
 * the room, and so the heat the floor can actually give, ends up much the same.
 */
export const surfaceLimitFor = (roomTempC: number): number =>
  roomTempC >= BATHROOM_ROOM_TEMP ? MAX_SURFACE_TEMP.bathroom : MAX_SURFACE_TEMP.occupied

/**
 * Limiting heat flux at a surface temperature, W/m² — EN 1264-2 eq. (1).
 *
 * q = 8,92 · (θF − θi)^1,1. Nothing about the pipework enters it: it is the most a floor at
 * that temperature can hand to a room at that temperature, whatever is buried in it.
 */
export const maxFlux = (surfaceLimitC: number, roomTempC: number): number =>
  8.92 * Math.pow(Math.max(0, surfaceLimitC - roomTempC), 1.1)

/** Mean surface temperature that goes with an upward flux, °C. The inverse of the above. */
export const surfaceTemperature = (roomTempC: number, fluxW: number): number =>
  roomTempC + fluxW / SURFACE_COEFFICIENT

/* ------------------------------------------------------------- the water side */

/**
 * Logarithmic mean water-to-room excess ΔθH, K — EN 1264-2 §5.
 *
 * The water cools as it goes round, so the driving temperature difference is not the mean of
 * the two ends but the log mean of them. The distinction is worth a couple of kelvin at a
 * domestic spread and rather more at a wide one, and it is what the standard's characteristic
 * curves are plotted against.
 */
export function logMeanExcess(flowC: number, returnC: number, roomC: number): number {
  const inlet = flowC - roomC
  const outlet = returnC - roomC
  if (inlet <= 0 || outlet <= 0) return 0
  if (Math.abs(inlet - outlet) < 1e-6) return inlet
  return (inlet - outlet) / Math.log(inlet / outlet)
}

/**
 * Resistance the discrete pipes add to the screed above them, m²K/W.
 *
 * Heat leaves a pipe radially and has to spread sideways before it can leave the floor as a
 * plane. The classic embedded-pipe result for that is R = T·ln(T / (π·da)) / (2π·λ), with T
 * the pitch and da the outside diameter. It is what EN 1264-2's a_T spacing factor encodes,
 * and it is why doubling the pitch does not halve the output — it mostly just makes the floor
 * stripy.
 */
export function spreadingResistance(
  spacingMm: number,
  odMm: number,
  conductivity = SCREED_CONDUCTIVITY,
): number {
  const pitch = Math.max(0.05, spacingMm / 1000)
  const diameter = Math.max(0.005, odMm / 1000)
  const ratio = pitch / (Math.PI * diameter)
  if (ratio <= 1) return 0
  return (pitch * Math.log(ratio)) / (2 * Math.PI * conductivity)
}

export interface FloorPanel {
  /** Screed over the crown of the pipe, mm. */
  coverMm: number
  covering: FloorCovering
  spacingMm: number
  odMm: number
}

/**
 * Resistance from the pipe up to the room, m²K/W: the screed over it, the covering on top of
 * that, the surface film, and the spreading the pitch imposes.
 */
export function upwardResistance(panel: FloorPanel): number {
  return (
    1 / SURFACE_COEFFICIENT +
    COVERING_RESISTANCE[panel.covering] +
    panel.coverMm / 1000 / SCREED_CONDUCTIVITY +
    spreadingResistance(panel.spacingMm, panel.odMm)
  )
}

/** Upward output of the floor, W/m². */
export const upwardFlux = (excessK: number, panel: FloorPanel): number =>
  Math.max(0, excessK) / upwardResistance(panel)

/**
 * Minimum thermal resistance of the layer under the pipe, m²K/W — EN 1264-4 Table 1.
 *
 * Everything the floor sends downwards is either heating the room below (which is a transfer,
 * not a loss) or heating the ground (which is simply gone). The standard asks for more
 * insulation the less friendly what is underneath.
 */
export type BelowFloor = 'heated' | 'unheated' | 'ground' | 'outside'

export const minInsulationResistance = (below: BelowFloor): number =>
  below === 'heated' ? 0.75 : below === 'outside' ? 2.0 : 1.25

/** Design temperature on the far side of the insulation, °C. */
export const belowTemperature = (below: BelowFloor, roomTempC: number): number =>
  below === 'heated' ? roomTempC : below === 'outside' ? -15 : 10

/**
 * Structure and surface film below the insulation, m²K/W.
 *
 * The slab and the film underneath it are worth about this much whatever they are made of,
 * and they matter far less than the insulation they sit behind.
 */
const DOWNWARD_STRUCTURE_R = 0.2

/** Downward loss through the insulation, W/m². */
export function downwardFlux(
  meanWaterTempC: number,
  belowTempC: number,
  insulationR: number,
): number {
  const resistance = Math.max(0.1, insulationR) + DOWNWARD_STRUCTURE_R
  return Math.max(0, (meanWaterTempC - belowTempC) / resistance)
}

/** Insulation thickness that gives a resistance, mm — what has to fit in the build-up. */
export const insulationThickness = (resistanceR: number): number =>
  Math.round(resistanceR * INSULATION_CONDUCTIVITY * 1000)

/* --------------------------------------------------------------- flow and head */

/** Specific heat capacity of water, J/kgK. */
export const SPECIFIC_HEAT = 4190

/** Mass flow a loop needs to carry its output at the design drop, kg/h. */
export const massFlowKgH = (watts: number, deltaTK: number): number =>
  deltaTK <= 0 ? 0 : (watts / (SPECIFIC_HEAT * deltaTK)) * 3600

/** Velocity of that flow through a bore, m/s. */
export function loopVelocity(flowKgH: number, boreMm: number): number {
  const area = Math.PI * (boreMm / 2000) ** 2
  if (area <= 0) return 0
  // 1 kg/h of water is very nearly 1 litre/h; the density correction at 40 °C is under 1%.
  return flowKgH / 3600 / 1000 / area
}

/**
 * Kinematic viscosity of water at heating-circuit temperature, m²/s.
 *
 * Around 35–40 °C, which is half the value the cold table uses — a loop at 0,3 m/s is
 * comfortably turbulent, which is both what the pressure model assumes and what keeps air
 * moving towards the manifold instead of sitting in the coil.
 */
export const KINEMATIC_VISCOSITY_HEATING = 0.66e-6

/**
 * Equivalent-length allowance for a coil.
 *
 * A loop has no fittings at all — it is one continuous bent pipe — so the only thing to put
 * back is the bends themselves, which is a good deal less than the third a fitted supply run
 * carries.
 */
export const LOOP_FITTING_ALLOWANCE = 1.1

/**
 * Pressure a single loop may cost, kPa.
 *
 * A domestic mixing group's circulator has something like 30 kPa to spend at the flow a
 * house needs, and the manifold's own valves and the primary take a share of it. Past this
 * the loop either has to be split or laid in bigger pipe.
 */
export const MAX_LOOP_PRESSURE_KPA = 25

/** What the manifold bodies, balancing valves and actuators cost on top of the worst loop. */
export const MANIFOLD_PRESSURE_KPA = 10

/**
 * Velocity band inside a loop, m/s.
 *
 * Below the floor of the band the water will not sweep air along with it and the loop
 * air-locks; above the ceiling it is audible through the floor.
 */
export const LOOP_VELOCITY = { min: 0.15, max: 0.5 }

/** Ports a domestic manifold is built with, and the most a single one should carry. */
export const MAX_LOOPS_PER_MANIFOLD = 12

/**
 * How far the loops on one manifold may differ in length before the valves cannot balance
 * them. Expressed as longest ÷ shortest: a loop half the length of its neighbour takes most
 * of the flow, and no amount of throttling puts that back without starving the whole
 * manifold.
 */
export const MAX_LOOP_IMBALANCE = 2

/* --------------------------------------------------------------- setting out */

/**
 * How close to a wall the pipe may be laid, mm.
 *
 * Far enough that the edge strip and the skirting fixings are clear of it, near enough that
 * the cold strip along the wall stays narrow. The field proper starts one pitch inside this,
 * with the perimeter run in between.
 */
export const WALL_CLEARANCE = 150

/**
 * Movement joints — EN 1264-4 §4.4.
 *
 * A heated screed grows, and a field bigger than this or longer than this on one side will
 * crack rather than grow. Joints have to be taken through the full depth of the screed, so
 * any pipe crossing one has to be sleeved for at least 300 mm.
 */
export const MAX_FIELD_AREA_M2 = 40
export const MAX_FIELD_SIDE = 8000
export const JOINT_SLEEVE_LENGTH = 300

/** Below this a room is not worth a loop of its own. */
export const MIN_HEATED_AREA_M2 = 1.5
