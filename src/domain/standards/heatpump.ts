/**
 * Air-to-water heat pump plant — the numbers a plant room is built to.
 *
 * A heat pump is not a boiler with a different badge, and the plant room around one is not a
 * boiler room with the boiler swapped out. Three things drive everything else in here:
 *
 *  - **It runs cool.** Output and efficiency both fall away with flow temperature, which is
 *    why the house is on underfloor heating in the first place. Every sizing below is done at
 *    the flow temperature the floor is actually designed to, not at a boiler's 70 °C.
 *  - **It defrosts.** Every hour or two in damp cold weather the cycle reverses and the
 *    outdoor coil is thawed with heat pulled *back* out of the house. If there is not enough
 *    water in the system to give that heat up, the unit trips on low pressure or short-cycles
 *    itself to death. Hence a minimum water volume, and a buffer only where the house does not
 *    already hold it. Whether it does turns out to depend almost entirely on the pitch the
 *    floor is laid at rather than on how big it is — both the water held and the heat demanded
 *    scale with area, so the area cancels: a floor at 150 mm holds about three quarters of what
 *    its own defrost wants, and the same floor at 100 mm holds more than all of it.
 *  - **It cannot make hot water quickly.** A cylinder charged at 50 °C rather than 80 °C needs
 *    a coil several times the area of the one in a boiler cylinder, and it needs a separate
 *    plan for Legionella because it never gets to 60 °C on its own.
 *
 * Sizing of the vessel and the safety side is EN 12828; the DHW side is EN 806 and the
 * Legionella regime is what Romanian practice (and every manufacturer) asks for.
 */

/**
 * Design outdoor temperature, °C.
 *
 * Romania's climate zone III — Bucharest, Bacău, most of the country's building stock — which
 * is what a heat pump's capacity has to be read at rather than at the 7 °C its headline
 * figure is quoted at.
 */
export const DESIGN_OUTDOOR_C = -15

/**
 * Water in the system per kW of heat pump, litres.
 *
 * What a defrost draws back out of the circuit. Manufacturers put this between 10 and 20
 * depending on whether zones can shut the emitters off; an underfloor house with no zone
 * valves sits at the bottom of that band, and this is that figure.
 */
export const MIN_SYSTEM_VOLUME_L_PER_KW = 12

/**
 * Heat pump temperature difference across the flow and return, K.
 *
 * Narrower than a boiler's, because the compressor's lift is set by the flow temperature and
 * a wide drop means a hotter flow for the same mean water temperature. It also sets the
 * minimum flow rate the unit will run at.
 */
export const DELTA_T_K = 5

/**
 * Flow temperature above which a heat pump stops being worth having, °C.
 *
 * Rough but real: every degree of flow temperature costs about 2,5 % of the seasonal
 * efficiency. At 35 °C an air-to-water unit will return around 4 kWh of heat per kWh of
 * electricity over a Romanian season; at 55 °C it is closer to 2,5, which is the point where
 * the running cost stops beating a gas boiler.
 */
export const GOOD_FLOW_TEMP_C = 45

/** Velocity the heat pump's own flow and return are sized to, m/s — quiet and low-resistance. */
export const PRIMARY_VELOCITY = 0.8

/* ------------------------------------------------------------------- the safety side */

/** Safety valve setting for a sealed domestic system, bar — EN 12828. */
export const SAFETY_VALVE_BAR = 3

/**
 * Pressure the vessel is expected to be full at, bar gauge.
 *
 * Half a bar under the safety valve, so the valve never weeps its way through a heating
 * season and the system never has to be topped up because it did.
 */
export const VESSEL_FINAL_BAR = SAFETY_VALVE_BAR - 0.5

/** Water kept in the vessel below the cold-fill pressure, litres — EN 12828's reserve. */
export const VESSEL_RESERVE_L = 3

/** Expansion vessels are made in these sizes, litres. */
export const VESSEL_SIZES = [8, 12, 18, 24, 35, 50, 80, 100]

/** Buffers and volumisers are made in these sizes, litres. */
export const BUFFER_SIZES = [25, 40, 50, 60, 80, 100, 150, 200, 300]

/** Heat pump cylinders are made in these sizes, litres. */
export const CYLINDER_SIZES = [150, 200, 250, 300, 400, 500]

/** Heat pumps are made in these capacities, kW at the design condition. */
export const HEAT_PUMP_SIZES = [4, 6, 8, 10, 12, 14, 16, 20, 25]

/** Smallest of `sizes` that covers `needed`, or the largest there is. */
export const stockSize = (needed: number, sizes: readonly number[]): number =>
  sizes.find((size) => size >= needed) ?? sizes[sizes.length - 1]

/**
 * How much water grows between filling and running, as a fraction of its own volume.
 *
 * Densities against 10 °C, which is what a system is filled at. Interpolated rather than
 * tabulated in steps, because the flow temperature of a heat pump system is a designed number
 * and lands between the rows.
 */
export function expansionCoefficient(maxTempC: number): number {
  const table: Array<[number, number]> = [
    [10, 0.0],
    [30, 0.0043],
    [40, 0.0076],
    [50, 0.0118],
    [60, 0.0168],
    [70, 0.0224],
    [80, 0.0287],
  ]
  if (maxTempC <= table[0][0]) return 0
  for (let i = 1; i < table.length; i++) {
    if (maxTempC > table[i][0]) continue
    const [t0, n0] = table[i - 1]
    const [t1, n1] = table[i]
    return n0 + ((n1 - n0) * (maxTempC - t0)) / (t1 - t0)
  }
  return table[table.length - 1][1]
}

/**
 * Expansion vessel volume, litres — EN 12828 §4.7.
 *
 * The vessel has to swallow what the water grows by between filling and its hottest, plus a
 * reserve so the system is not running on an empty vessel, and it can only use the part of
 * its own volume between the pre-charge and the pressure it is allowed to reach.
 *
 * The pre-charge is set by how far the highest pipe in the house is above the vessel: below
 * that pressure the top of the system is under vacuum and pulls air in through every gland it
 * has.
 */
export function expansionVesselLitres(options: {
  systemL: number
  maxTempC: number
  /** Height of the topmost pipe above the vessel, mm. */
  staticHeadMm: number
  /** Fraction of the fill that is glycol, which grows more than water does. */
  glycol: number
}): number {
  const { systemL, maxTempC, staticHeadMm, glycol } = options
  // Glycol expands about half as much again as water, so the mix is scaled between the two.
  const growth = expansionCoefficient(maxTempC) * (1 + 0.5 * Math.max(0, Math.min(1, glycol)))
  const expansion = systemL * growth
  const reserve = Math.max(VESSEL_RESERVE_L, systemL * 0.005)
  // Three tenths of a bar over the static head, so the top of the system stays positive.
  const precharge = Math.max(1, staticHeadMm / 10_000 + 0.3)
  const usable = (VESSEL_FINAL_BAR - precharge) / (VESSEL_FINAL_BAR + 1)
  if (usable <= 0.05) return Infinity
  return (expansion + reserve) / usable
}

/** Cold-fill pressure the vessel is charged to, bar gauge, for the same static head. */
export const prechargeBar = (staticHeadMm: number): number =>
  Math.max(1, Math.round((staticHeadMm / 10_000 + 0.3) * 10) / 10)

/* --------------------------------------------------------------------- hot water */

/**
 * Cylinder coil area per kW of heat pump, m².
 *
 * The one number that separates a heat pump cylinder from a boiler cylinder. A boiler charges
 * a coil at 75 °C against 50 °C water — a 25 K difference that pushes its output through a
 * 1 m² coil without trying. A heat pump charging the same store at 52 °C has perhaps 8 K to
 * work with, and needs three times the surface to put the same kilowatts in. Fit a boiler
 * cylinder and the unit throttles back to whatever the coil will take, runs its compressor at
 * a flow temperature it hates, and takes half a day to heat the water.
 */
export const COIL_M2_PER_KW = 0.25

/** Storage temperature a heat pump charges a cylinder to, °C. */
export const STORE_TEMP_C = 48

/** Temperature the store has to reach periodically to see off Legionella, °C. */
export const LEGIONELLA_TEMP_C = 60

/** Cold water inlet temperature the reheat is figured from, °C. */
export const COLD_INLET_C = 10

/** Specific heat capacity of water, J/kgK. */
export const SPECIFIC_HEAT = 4190

/**
 * Cylinder size for a house, litres.
 *
 * At a heat pump's storage temperature there is less usable heat in a litre than there is in a
 * boiler system's, so the same household needs a bigger store: roughly a third more than the
 * 45 litres per person a 60 °C cylinder is sized on. Counted off the bathrooms rather than the
 * bedrooms, because it is baths and showers drawn at the same time that empty a cylinder.
 */
export const cylinderLitres = (bathrooms: number): number =>
  stockSize(150 + 60 * Math.max(0, bathrooms - 1), CYLINDER_SIZES)

/** How long a heat pump of this capacity takes to reheat a cylinder from cold, minutes. */
export function reheatMinutes(litres: number, kw: number): number {
  if (kw <= 0) return Infinity
  const joules = litres * SPECIFIC_HEAT * (STORE_TEMP_C - COLD_INLET_C)
  return joules / (kw * 1000) / 60
}

/* ---------------------------------------------------------------- the cold outside */

/**
 * Propylene glycol in the fill, as a fraction.
 *
 * A monobloc unit stands outside with the system water running through it, and Romania's
 * design condition freezes it solid. Thirty per cent covers −15 °C with a margin, and is what
 * costs the system the capacity and the pump head below.
 */
export const GLYCOL_FRACTION = 0.3

/** What that glycol costs: a little capacity, and rather more pump head. */
export const GLYCOL_CAPACITY_PENALTY = 0.05
export const GLYCOL_HEAD_PENALTY = 0.15

/**
 * Condensate off the outdoor coil, litres per hour of defrost.
 *
 * An air-source unit is a dehumidifier it did not mean to be: in the damp cold weather it
 * works hardest in, every defrost dumps the frost it has just melted. It has to go somewhere
 * that will not ice over, or the unit stands in a block of its own making by February.
 */
export const CONDENSATE_L_PER_H = 2

/** Mass flow through the heat pump at its own temperature difference, litres per hour. */
export const primaryFlowLh = (kw: number, deltaTK: number = DELTA_T_K): number =>
  deltaTK <= 0 ? 0 : (kw * 1000 * 3600) / (SPECIFIC_HEAT * deltaTK)
