/**
 * The plant room, designed around an air-to-water heat pump.
 *
 * Everything else in this app routes pipe between things that are already placed. This does
 * the opposite: it takes what the house turned out to need — the floor's output, the water
 * already standing in its coils, how many bathrooms want hot water at once — and works out
 * what has to stand in the plant room to serve it, and what has to be piped between those
 * things for the result to run rather than merely exist.
 *
 * The pieces are not decoration. A heat pump plant that is missing its volumiser short-cycles
 * itself to death on defrost; one missing its magnetic separator fills the plate exchanger
 * with the iron oxide the screed loops shed for their first two winters; one on a boiler
 * cylinder never gets the hot water above lukewarm. Each is here with the reason it is here,
 * because a schematic that only shows the boxes teaches nobody which of them they can leave
 * out.
 *
 * Pure, like everything under `domain/`: it reads a solved project and returns a description.
 * It places nothing and mutates nothing — the plant room is drawn from this, not from the
 * plan, because a hydraulic schematic is not a scale drawing and never has been.
 */

import { edgesOf, pointInPolygon, area as polygonArea } from './geometry/polygon.ts'
import { add2, norm2, perp2, scale2, sub2 } from './geometry/vec.ts'
import { findRoom, roomsOnLevel, sortedLevels, wallsOf } from './model.ts'
import { boreOf, pipeVolumeLitres, supplySizes } from './standards/en806.ts'
import { ufhPipe } from './standards/en1264.ts'
import {
  BUFFER_SIZES,
  bufferBulk,
  COIL_M2_PER_KW,
  cylinderBulk,
  vesselBulk,
  CONDENSATE_L_PER_H,
  CYLINDER_RELIEF_BAR,
  DHW_INLET_BAR,
  dhwVesselLitres,
  RECIRCULATION_PUMP_W,
  RECIRCULATION_RETURN_C,
  cylinderLitres,
  DELTA_T_K,
  DESIGN_OUTDOOR_C,
  expansionVesselLitres,
  GLYCOL_FRACTION,
  GLYCOL_HEAD_PENALTY,
  GOOD_FLOW_TEMP_C,
  HEAT_PUMP_SIZES,
  LEGIONELLA_TEMP_C,
  MIN_SYSTEM_VOLUME_L_PER_KW,
  PENETRATION_ZONE_MM,
  PLANT_GAP_MM,
  prechargeBar,
  PRIMARY_VELOCITY,
  primaryFlowLh,
  reheatMinutes,
  SAFETY_VALVE_BAR,
  stockSize,
  STORE_TEMP_C,
  VESSEL_SIZES,
  WORKING_HEIGHT_MM,
} from './standards/heatpump.ts'
import type { FixtureType, Project, Room, RoutingResult } from './types.ts'

const primaryFlowFigure = (flowLh: number): string => String(Math.round(flowLh / 10) * 10)

/** Where a component sits in the run from the outdoor unit to the floor and to the taps. */
export type PlantStage =
  | 'outdoor'
  | 'source'
  | 'safety'
  | 'protection'
  | 'hotwater'
  | 'coldfeed'
  | 'recirculation'
  | 'buffer'
  | 'circuit'
  | 'controls'
  | 'finishing'

/**
 * Where a component physically goes, for the things that take up room.
 *
 * Most of a plant room is fittings threaded onto the pipe between the things that stand
 * somewhere — a check valve has a size but no footprint. Only what has to be found space for
 * carries this, and that is what the wall is set out from.
 */
export interface PlantMount {
  /** Across the wall, and how tall it is. */
  widthMm: number
  heightMm: number
  /** Underside above the finished floor, mm. Zero stands on it. */
  baseMm: number
}

export interface PlantComponent {
  id: string
  /** What it is called on a drawing. */
  name: string
  /** What it is called at a Romanian counter, which is where it gets bought. */
  nameRo: string
  /** Its duty, size or setting — the line that makes it a specification. */
  size: string
  /** Why it is in the plant room at all. */
  why: string
  stage: PlantStage
  quantity: number
  /** Set on the things that have to be found room for against the wall. */
  mount?: PlantMount
}

/** One item set out along the plant wall, in the order the water meets it. */
export interface PlantPlacement {
  componentId: string
  name: string
  /** Its balloon on the elevation, and the number against it in the schedule. */
  tag: number
  /** Along the wall from the outside corner, mm — the wall is set out from the penetration. */
  atMm: number
  mount: PlantMount
}

/** One heating circuit off the plant: a manifold, with the pump that serves it. */
export interface PlantCircuit {
  id: string
  name: string
  levelName: string
  loops: number
  outputW: number
  /** Circulator duty, litres per hour, and the head it has to make, kPa. */
  flowLh: number
  headKpa: number
  /** Size of the flow and return reaching it, mm. */
  pipeOd: number
}

export interface PlantCheck {
  id: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface PlantDesign {
  /** The room the plant stands in, when a heat source has been placed in one. */
  room: { id: string; name: string; levelName: string; areaM2: number } | null
  /** A plant room needs both: a drain for the safety valve and a facade for the line set. */
  hasFloorDrain: boolean
  hasExternalWall: boolean

  heatPump: {
    /** What the floor gives at its design flow temperature — the load the plant has to cover. */
    demandKw: number
    /** The size of unit that covers it. */
    capacityKw: number
    flowTempC: number
    returnTempC: number
    /** Flow through the unit at its own temperature difference, litres per hour. */
    flowLh: number
    /** Flow and return between the unit and the plant, mm. */
    pipeOd: number
  }

  water: {
    /** Water standing in the coils and their leaders, litres. */
    emitterL: number
    /** Water standing in the primary flow and return, litres. */
    primaryL: number
    /** What the two come to. */
    systemL: number
    /** What a defrost needs to have to pull heat back out of. */
    requiredL: number
    /** The volumiser that makes up the difference, litres — zero where the floor holds enough. */
    bufferL: number
  }

  cylinder: {
    bathrooms: number
    litres: number
    /** Coil surface the heat pump needs in it, m². */
    coilM2: number
    /** How long a charge from cold takes at the unit's capacity, minutes. */
    reheatMinutes: number
  }

  vessel: {
    litres: number
    prechargeBar: number
    safetyValveBar: number
    /** How far the topmost pipe in the house is above the plant, mm. */
    staticHeadMm: number
  }

  /** The domestic side of the store: what the cold main has to pass through to reach it. */
  coldFeed: {
    /** Pressure the main arrives at, bar, and what it is reduced to if that is too much. */
    mainBar: number
    reducedToBar: number | null
    /** Expansion vessel for the store, litres — the heating one cannot serve it. */
    vesselL: number
    reliefBar: number
  }

  /**
   * The circulation loop, where the hot network has dead legs the standard will not have.
   * Null where every outlet is close enough to the cylinder to do without one.
   */
  recirculation: { deadLegs: number } | null

  /** Glycol in the fill, litres — a monobloc stands outside and the water in it freezes. */
  glycolL: number

  /**
   * The wall the plant stands against: the one the heat source is fixed to, which is the one
   * the flow and return cross. Null until there is a heat source in a room.
   */
  wall: { index: number; lengthMm: number; heightMm: number; external: boolean } | null
  /** Everything with a footprint, set out along that wall. */
  arrangement: PlantPlacement[]
  /** How much of the wall the plant takes, mm. */
  wallUsedMm: number

  circuits: PlantCircuit[]
  components: PlantComponent[]
  checks: PlantCheck[]
}

/** Fixtures that make a room a bathroom for the purpose of sizing the cylinder. */
const BATHING: ReadonlySet<FixtureType> = new Set<FixtureType>(['bathtub', 'shower'])

export function designPlant(project: Project, result: RoutingResult): PlantDesign {
  const checks: PlantCheck[] = []
  let counter = 0
  const nextId = (): string => `plant-${++counter}`

  /* ------------------------------------------------------------------ the room */

  const source = project.fixtures.find((f) => f.type === 'water-heater') ?? null
  const room = source ? findRoom(project, source.roomId) : null
  const level = room ? sortedLevels(project).find((l) => l.id === room.levelId) : undefined

  const hasFloorDrain = room
    ? project.fixtures.some((f) => f.roomId === room.id && f.type === 'floor-drain')
    : false
  const hasExternalWall = room ? facesOutside(project, room) : false
  const wall = room ? plantWall(project, room, source) : null

  /* -------------------------------------------------------- what it has to cover */

  const heating = project.settings.heating
  const flowTempC = heating.flowTempC
  const returnTempC = flowTempC - heating.deltaTK

  const demandW = result.manifolds.reduce((sum, m) => sum + m.outputW, 0)
  const demandKw = demandW / 1000
  const capacityKw = stockSize(Math.max(demandKw, 1), HEAT_PUMP_SIZES)

  /* ----------------------------------------------------- the water already in it */

  const pipe = ufhPipe(heating.pipe)
  const material = project.settings.supply.material
  const segments = result.networks.find((n) => n.system === 'heating')?.segments ?? []

  let emitterL = 0
  let primaryL = 0
  for (const segment of segments) {
    // The coil and its leaders are the heating pipe; the primary is in supply sizes.
    if (segment.role === 'loop' || segment.role === 'branch') {
      emitterL += pipeVolumeLitres(pipe.bore, segment.length)
    } else {
      primaryL += pipeVolumeLitres(boreOf(material, segment.size), segment.length)
    }
  }

  const systemL = emitterL + primaryL
  const requiredL = capacityKw * MIN_SYSTEM_VOLUME_L_PER_KW
  const shortfall = Math.max(0, requiredL - systemL)
  const bufferL = shortfall > 0 ? stockSize(shortfall, BUFFER_SIZES) : 0

  /* ---------------------------------------------------------------- the hot water */

  const bathrooms = countBathrooms(project)
  const cylinderL = cylinderLitres(bathrooms)
  const coilM2 = capacityKw * COIL_M2_PER_KW

  /* ------------------------------------------------------- the safety side and fill */

  const staticHeadMm = topOfSystem(project) - (level?.elevation ?? 0)
  const totalL = systemL + bufferL
  const vesselL = stockSize(
    expansionVesselLitres({
      systemL: totalL,
      // The heating water is at its hottest while it is charging the cylinder, not while it is
      // heating the floor: the store has to be driven a few degrees above its own temperature.
      maxTempC: Math.max(flowTempC, STORE_TEMP_C + 5),
      staticHeadMm,
      glycol: GLYCOL_FRACTION,
    }),
    VESSEL_SIZES,
  )

  const flowLh = primaryFlowLh(capacityKw)
  const pipeOd = sizeFor(project, flowLh)

  /* ------------------------------------------------------------------ the circuits */

  const circuits: PlantCircuit[] = result.manifolds.map((manifold) => ({
    id: manifold.id,
    name: manifold.name,
    levelName:
      sortedLevels(project).find((l) => l.id === manifold.levelId)?.name ?? 'unplaced',
    loops: manifold.loops,
    outputW: manifold.outputW,
    flowLh: manifold.flowKgH,
    headKpa: manifold.pumpHeadKpa * (1 + GLYCOL_HEAD_PENALTY),
    pipeOd: manifold.primarySize,
  }))

  /* ------------------------------------------------ the domestic side of the store */

  const mainBar = project.settings.supply.entryPressureKpa / 100
  const reducedToBar = mainBar > DHW_INLET_BAR ? DHW_INLET_BAR : null
  const inletBar = reducedToBar ?? mainBar
  const dhwVesselL = stockSize(dhwVesselLitres(cylinderL, inletBar), VESSEL_SIZES)

  // A circulation loop is not a preference: it is what the hot network's own dead legs ask
  // for, and the supply solver has already found them and named them.
  const deadLegs = result.warnings.filter((w) => w.code === 'hot-dead-leg').length

  const design: PlantDesign = {
    room: room
      ? {
          id: room.id,
          name: room.name,
          levelName: level?.name ?? 'unplaced',
          areaM2: polygonArea(room.outline) / 1e6,
        }
      : null,
    hasFloorDrain,
    hasExternalWall,
    heatPump: { demandKw, capacityKw, flowTempC, returnTempC, flowLh, pipeOd },
    water: { emitterL, primaryL, systemL, requiredL, bufferL },
    cylinder: {
      bathrooms,
      litres: cylinderL,
      coilM2,
      reheatMinutes: reheatMinutes(cylinderL, capacityKw),
    },
    vessel: {
      litres: vesselL,
      prechargeBar: prechargeBar(staticHeadMm),
      safetyValveBar: SAFETY_VALVE_BAR,
      staticHeadMm,
    },
    coldFeed: { mainBar, reducedToBar, vesselL: dhwVesselL, reliefBar: CYLINDER_RELIEF_BAR },
    wall,
    arrangement: [],
    wallUsedMm: 0,
    recirculation: deadLegs > 0 ? { deadLegs } : null,
    glycolL: totalL * GLYCOL_FRACTION,
    circuits,
    components: [],
    checks,
  }

  design.components = schedule(design, nextId)
  // Set out only once the schedule exists: the arrangement is the schedule's own order, which
  // is the order the water meets things, which is the order it gets plumbed in.
  const placed = setOut(design.components, wall?.lengthMm ?? 0)
  design.arrangement = placed.arrangement
  design.wallUsedMm = placed.usedMm
  design.checks = audit(project, design, source !== null, nextId)
  return design
}

/* ------------------------------------------------------------------ the schedule */

/**
 * Everything that stands in the plant room or is piped between the things that do, in the
 * order the water meets it.
 */
function schedule(design: PlantDesign, nextId: () => string): PlantComponent[] {
  const { heatPump, water, cylinder, vessel, coldFeed } = design
  const out: PlantComponent[] = []
  const add = (component: Omit<PlantComponent, 'id'>): void => {
    out.push({ id: nextId(), ...component })
  }

  add({
    stage: 'outdoor',
    name: 'Air-to-water heat pump, monobloc',
    nameRo: 'Pompă de căldură aer-apă, monobloc',
    size: `${heatPump.capacityKw} kW at ${DESIGN_OUTDOOR_C} °C, ${heatPump.flowTempC}/${heatPump.returnTempC} °C`,
    why: `Covers the ${heatPump.demandKw.toFixed(1)} kW the floor gives at its design flow temperature. A monobloc keeps the refrigerant circuit sealed in the factory, so what crosses the wall is water rather than a brazed line set and an F-gas certificate.`,
    quantity: 1,
  })
  add({
    stage: 'outdoor',
    name: 'Anti-vibration hoses',
    nameRo: 'Racorduri flexibile antivibrație',
    size: `Ø${heatPump.pipeOd}, stainless braided`,
    why: 'A compressor and a fan bolted to a slab put their frequency into anything rigid they are plumbed to. The hoses stop the plant room becoming the loudspeaker.',
    quantity: 2,
  })
  add({
    stage: 'outdoor',
    name: 'Insulated buried flow and return',
    nameRo: 'Conductă preizolată tur/retur',
    size: `Ø${heatPump.pipeOd}, ${primaryFlowFigure(heatPump.flowLh)} l/h at ${DELTA_T_K} K`,
    why: 'Runs the water out to the unit and back. Buried and pre-insulated: uninsulated it loses more between the unit and the house in a winter than the plant room costs to build.',
    quantity: 1,
  })

  add({
    stage: 'outdoor',
    name: 'Ground plinth and anti-vibration mounts',
    nameRo: 'Postament cu tampoane antivibrante',
    size: '4 mounts, unit clear of the ground and of snow',
    why: 'Standing off the ground so the coil drains and the fan is not blowing into a drift, and off rubber so what the compressor does at 50 Hz is not conducted into the slab.',
    quantity: 1,
  })

  add({
    stage: 'source',
    name: 'Isolating valves, full bore',
    nameRo: 'Robineți de izolare cu sferă',
    size: `Ø${heatPump.pipeOd} — a pair at the unit, a pair inside`,
    why: 'So the unit can be dropped out without draining the house — the one job that gets done to a heat pump, and the one that empties a glycol fill if it cannot be isolated. A pair each end means the buried run stays full too.',
    quantity: 4,
  })
  add({
    stage: 'source',
    name: 'Fill and drain cocks',
    nameRo: 'Robineți de golire cu portfurtun',
    size: '½″ with hose union, at every low point',
    why: 'A glycol fill is pumped in and has to come out again — at the unit, at the lowest point of the buried run, and under each vessel. Without one at a low point the system cannot be emptied, only siphoned.',
    quantity: 4,
  })
  add({
    stage: 'source',
    name: 'Thermometers on flow and return',
    nameRo: 'Termometre pe tur și retur',
    size: '0–80 °C, in pockets',
    why: `The difference across them is the whole commissioning check: at design conditions it should read about ${DELTA_T_K} K. Wider means the flow is too low and the unit is about to trip; narrower means it is pumping far more than it needs and paying for it.`,
    quantity: 2,
  })
  add({
    stage: 'protection',
    name: 'Magnetic dirt separator',
    nameRo: 'Separator de impurități cu magnet',
    size: `Ø${heatPump.pipeOd}, on the return into the unit`,
    why: 'A new screed system sheds iron oxide for two winters, and a heat pump has a brazed plate exchanger with millimetre channels to catch it in. This is the cheapest component here and the one whose absence writes off the dearest.',
    quantity: 1,
    mount: { widthMm: 160, heightMm: 280, baseMm: 700 },
  })
  add({
    stage: 'protection',
    name: 'Air separator and automatic vent',
    nameRo: 'Separator de aer cu aerisitor automat',
    size: `Ø${heatPump.pipeOd}, at the high point of the plant`,
    why: 'Air in a heat pump circuit shows up as a flow switch trip, not as a radiator that needs bleeding. The loops on a manifold are vented at the manifold; this catches what the system keeps making.',
    quantity: 1,
    mount: { widthMm: 160, heightMm: 280, baseMm: 1750 },
  })

  add({
    stage: 'safety',
    name: 'Safety group',
    nameRo: 'Grup de siguranță',
    size: `${vessel.safetyValveBar} bar relief, pressure gauge, ${'½'}″ discharge`,
    why: 'EN 12828. The discharge has to reach the floor drain by gravity and be visible along the way, so a valve that has lifted is noticed rather than merely obeyed.',
    quantity: 1,
    mount: { widthMm: 200, heightMm: 260, baseMm: 1800 },
  })
  add({
    stage: 'safety',
    name: 'Expansion vessel',
    nameRo: 'Vas de expansiune închis',
    size: `${vessel.litres} l, pre-charged to ${vessel.prechargeBar.toFixed(1)} bar`,
    why: `Swallows what ${Math.round(water.systemL + water.bufferL)} litres of fill grows by when it warms. The pre-charge is set by the ${(vessel.staticHeadMm / 1000).toFixed(1)} m from here up to the topmost pipe: any lower and the top of the system runs under vacuum and draws air in.`,
    quantity: 1,
    mount: { ...vesselBulk(vessel.litres), baseMm: 1150 },
  })
  add({
    stage: 'safety',
    name: 'Filling loop with backflow preventer',
    nameRo: 'Grup de umplere cu clapetă antiretur',
    size: 'EN 1717 type CA, disconnectable',
    why: 'A glycol system may not be left connected to the main. EN 1717 puts a heating circuit in fluid category 3, and category 3 wants a verifiable break rather than a single check valve.',
    quantity: 1,
    mount: { widthMm: 260, heightMm: 200, baseMm: 900 },
  })

  // A buffer and a low-loss header are the same vessel doing two jobs, and specifying them
  // separately is how a plant room ends up with two of them plumbed in series.
  const short = water.bufferL > 0
  const many = design.circuits.length > 1
  if (short && many) {
    add({
      stage: 'buffer',
      name: 'Buffer as low-loss header',
      nameRo: 'Butelie de egalizare cu acumulare',
      size: `${water.bufferL} l, Ø${heatPump.pipeOd} primary, ${design.circuits.length} secondary circuits`,
      why: `Two jobs in one vessel. The house holds ${Math.round(water.systemL)} litres and a defrost on a ${heatPump.capacityKw} kW unit wants ${Math.round(water.requiredL)}; separately, ${design.circuits.length} manifolds each on their own circulator would otherwise pump against each other and through the unit's own flow switch. One vessel decouples them and makes up the volume.`,
      quantity: 1,
      mount: { ...bufferBulk(water.bufferL), baseMm: 0 },
    })
  } else if (short) {
    add({
      stage: 'buffer',
      name: 'Volumiser, in series on the return',
      nameRo: 'Vas tampon în serie pe retur',
      size: `${water.bufferL} l`,
      why: `The house holds ${Math.round(water.systemL)} litres and a defrost on a ${heatPump.capacityKw} kW unit wants ${Math.round(water.requiredL)}. In series rather than as a four-pipe buffer, because underfloor loops are never valved shut — nothing here can strand the unit against a closed circuit, so there is no reason to pay the mixing loss of a header.`,
      quantity: 1,
      mount: { ...bufferBulk(water.bufferL), baseMm: 0 },
    })
  } else if (many) {
    add({
      stage: 'buffer',
      name: 'Low-loss header',
      nameRo: 'Butelie de egalizare a presiunilor',
      size: `Ø${heatPump.pipeOd} primary, ${design.circuits.length} secondary circuits`,
      why: `${design.circuits.length} manifolds each on their own circulator pump against each other and through the unit's own flow switch. The header lets each take what it needs without changing what the others see. No storage in it: the floor already holds ${Math.round(water.systemL)} litres against the ${Math.round(water.requiredL)} a defrost wants.`,
      quantity: 1,
      mount: { widthMm: 220, heightMm: 620, baseMm: 350 },
    })
  } else {
    add({
      stage: 'buffer',
      name: 'No buffer needed',
      nameRo: 'Fără vas tampon',
      size: `${Math.round(water.systemL)} l in the floor against ${Math.round(water.requiredL)} l needed`,
      why: 'The screed loops hold more than a defrost draws back, which is the one real advantage underfloor has over radiators here. A buffer would only add standing loss and a mixing point.',
      quantity: 0,
    })
  }

  add({
    stage: 'hotwater',
    name: 'Three-way diverter valve, hot water priority',
    nameRo: 'Vană cu 3 căi, prioritate ACM',
    size: `Ø${heatPump.pipeOd}, motorised, spring return to heating`,
    why: 'A heat pump makes hot water by sending all of itself at the cylinder and nothing at the floor. Priority rather than sharing: a floor coasts on its own screed for the half hour that takes, and splitting the output would mean charging the store at a flow temperature that never gets there.',
    quantity: 1,
    mount: { widthMm: 180, heightMm: 180, baseMm: 1450 },
  })
  add({
    stage: 'hotwater',
    name: 'Heat pump cylinder',
    nameRo: 'Boiler ACM pentru pompă de căldură',
    size: `${cylinder.litres} l, coil ≥ ${cylinder.coilM2.toFixed(1)} m², store at ${STORE_TEMP_C} °C`,
    why: `Sized for ${cylinder.bathrooms} bathroom${cylinder.bathrooms === 1 ? '' : 's'}, and bigger than a boiler system's because there is less usable heat in a litre at ${STORE_TEMP_C} °C than at 60. The coil is the part that matters: a boiler cylinder's 1 m² has the unit throttling back to whatever it will take, and the charge takes all day.`,
    quantity: 1,
    mount: { ...cylinderBulk(cylinder.litres), baseMm: 0 },
  })
  add({
    stage: 'hotwater',
    name: 'Immersion heater, pasteurisation duty',
    nameRo: 'Rezistență electrică pentru ciclu antilegionella',
    size: '2 kW, thermostat and manual reset limiter',
    why: `The store sits at ${STORE_TEMP_C} °C, which is where Legionella is comfortable and where a heat pump stops being efficient. Once a week the controller has to take it to ${LEGIONELLA_TEMP_C} °C, and it is the immersion that does that last stretch.`,
    quantity: 1,
  })
  add({
    stage: 'hotwater',
    name: 'Thermostatic mixing valve',
    nameRo: 'Vană de amestec termostatată',
    size: `Ø22, set to 45 °C`,
    why: `The pasteurisation cycle puts ${LEGIONELLA_TEMP_C} °C into a distribution system serving baths and basins. The valve is what stops that reaching a tap.`,
    quantity: 1,
  })

  /* ------------------------------ the cold main into the store, which is its own circuit */

  add({
    stage: 'coldfeed',
    name: 'Isolating valve on the cold feed',
    nameRo: 'Robinet de izolare pe apa rece',
    size: 'Ø22, lever handle, labelled',
    why: 'The one valve somebody has to find in a hurry. Everything downstream of it — the vessel, the relief, the store itself — is worked on through it.',
    quantity: 1,
  })
  if (coldFeed.reducedToBar !== null) {
    add({
      stage: 'coldfeed',
      name: 'Pressure reducing valve',
      nameRo: 'Reductor de presiune',
      size: `set to ${coldFeed.reducedToBar.toFixed(1)} bar, with strainer and gauge`,
      why: `The main arrives at ${coldFeed.mainBar.toFixed(1)} bar, which is more than the store and its expansion vessel are set up for. Reducing it also makes the vessel smaller, because a vessel only uses the pressure band between the feed and the relief.`,
      quantity: 1,
    })
  } else {
    add({
      stage: 'coldfeed',
      name: 'No pressure reducing valve needed',
      nameRo: 'Fără reductor de presiune',
      size: `main arrives at ${coldFeed.mainBar.toFixed(1)} bar`,
      why: `Under the ${DHW_INLET_BAR} bar the store's group is set up for, so the feed goes straight in. Fit a strainer anyway if the main is on a village supply.`,
      quantity: 0,
    })
  }
  add({
    stage: 'coldfeed',
    name: 'Check valve on the cold feed',
    nameRo: 'Clapetă de sens pe apa rece',
    size: 'Ø22, single check, EN 13959',
    why: 'Stops stored hot water pushing back into the cold main when the main drops — which is how a house ends up with hot water at its cold taps and, at the boundary, how one house ends up with its neighbour’s. It is also what makes the expansion vessel below necessary: with this fitted, the water has nowhere else to grow.',
    quantity: 1,
  })
  add({
    stage: 'coldfeed',
    name: 'Expansion vessel for the store',
    nameRo: 'Vas de expansiune pentru ACM',
    size: `${coldFeed.vesselL} l, potable-rated diaphragm, pre-charged to ${(coldFeed.reducedToBar ?? coldFeed.mainBar).toFixed(1)} bar`,
    why: `The ${cylinder.litres} litres in the store grow by about ${(cylinder.litres * 0.017).toFixed(1)} litres on the way to ${LEGIONELLA_TEMP_C} °C, and the check valve above means they cannot go back down the main. Without this, every reheat lifts the relief valve — and a relief valve lifted twice a day fails open.`,
    quantity: 1,
    mount: { ...vesselBulk(coldFeed.vesselL), baseMm: 1600 },
  })
  add({
    stage: 'coldfeed',
    name: 'Cylinder safety group',
    nameRo: 'Grup de siguranță ACM',
    size: `${coldFeed.reliefBar} bar relief and a temperature-and-pressure valve, to a tundish`,
    why: 'Two independent ways out. The pressure relief covers a failed expansion vessel; the temperature-and-pressure valve covers a stuck thermostat boiling the store, which pressure alone would not catch until it was steam.',
    quantity: 1,
    mount: { widthMm: 200, heightMm: 240, baseMm: 1800 },
  })
  add({
    stage: 'coldfeed',
    name: 'Drain cock under the cylinder',
    nameRo: 'Robinet de golire sub boiler',
    size: '½″ with hose union',
    why: 'A cylinder is emptied to be moved, descaled or replaced, and it holds a quarter of a tonne of water. It is drained through this or it is drained through the floor.',
    quantity: 1,
  })

  /* ------------------------------------------------------------ keeping the taps hot */

  if (design.recirculation) {
    add({
      stage: 'recirculation',
      name: 'Hot water circulation pump',
      nameRo: 'Pompă de recirculare ACM',
      size: `bronze or stainless, ${RECIRCULATION_PUMP_W} W, on a timer with a return thermostat at ${RECIRCULATION_RETURN_C} °C`,
      why: `${design.recirculation.deadLegs} outlet${design.recirculation.deadLegs === 1 ? ' has' : 's have'} more standing water in the leg feeding ${design.recirculation.deadLegs === 1 ? 'it' : 'them'} than EN 806 allows — that water runs to waste before the tap goes hot, and sits at Legionella temperature in between. Bronze or stainless because it circulates drinking water, and on a timer because a loop left running is a heat loss the heat pump makes up at its worst efficiency.`,
      quantity: 1,
    mount: { widthMm: 200, heightMm: 200, baseMm: 1150 },
    })
    add({
      stage: 'recirculation',
      name: 'Check valve on the circulation return',
      nameRo: 'Clapetă de sens pe returul de recirculare',
      size: 'Ø15, single check',
      why: 'Without it the draw at a tap pulls water backwards round the loop instead of out of the store, and the far end of the circuit never gets hot at all.',
      quantity: 1,
    })
    add({
      stage: 'recirculation',
      name: 'Balancing valve on the circulation return',
      nameRo: 'Robinet de echilibrare pe recirculare',
      size: 'Ø15, thermostatic or regulating',
      why: 'A loop takes the easy way round like any other circuit. Throttled to the flow that just keeps the return warm, so the pump is not shuttling the store round the house.',
      quantity: 1,
    })
  } else {
    add({
      stage: 'recirculation',
      name: 'No circulation loop needed',
      nameRo: 'Fără recirculare ACM',
      size: 'every outlet inside the EN 806 dead-leg limit',
      why: 'No draw-off has more than three litres standing in the leg that feeds it, so every tap runs hot quickly enough on its own. A loop here would only be a heat loss.',
      quantity: 0,
    })
  }

  for (const circuit of design.circuits) {
    add({
      stage: 'circuit',
      name: `Circulator — ${circuit.name}`,
      nameRo: `Pompă de circulație — ${circuit.name}`,
      size: `${Math.round(circuit.flowLh)} l/h at ${(circuit.headKpa / 9.81).toFixed(1)} m head`,
      why: `Carries ${(circuit.outputW / 1000).toFixed(1)} kW to ${circuit.loops} loops on ${circuit.levelName}. The head is the worst loop on that manifold plus the manifold itself, with 15 % added for what glycol costs in a pipe this size.`,
      quantity: 1,
      mount: { widthMm: 200, heightMm: 200, baseMm: 1150 },
    })
  }

  if (design.circuits.length > 0) {
    const n = design.circuits.length
    add({
      stage: 'circuit',
      name: 'Check valve on each circulator',
      nameRo: 'Clapetă de sens pe fiecare pompă',
      size: `Ø${design.circuits[0].pipeOd}, spring check`,
      why: 'When one circuit is running and the other is not, the idle one is a path back to the header. The check valve is what stops the running pump circulating heat round a floor nobody asked to warm — and what stops warm water rising through an idle circuit on its own overnight.',
      quantity: n,
    })
    add({
      stage: 'circuit',
      name: 'Isolating valves either side of each circulator',
      nameRo: 'Robineți de izolare pe fiecare pompă',
      size: `Ø${design.circuits[0].pipeOd}`,
      why: 'A circulator is the part of a plant room most likely to be changed. Valved both sides it is a twenty-minute job; unvalved it is a drain-down and a refill with glycol.',
      quantity: n * 2,
    })
    add({
      stage: 'circuit',
      name: 'High-limit safety thermostat',
      nameRo: 'Termostat de siguranță pe tur',
      size: 'strap-on, breaking the circulator at 55 °C',
      why: `A screed cracks if it is driven far past what it was laid for. At ${heatPump.flowTempC} °C flow nothing here can do that, which is exactly why the stat is cheap insurance: it is the one component whose job is to cover the controls failing, and it is wired to drop the pump rather than to warn anybody.`,
      quantity: n,
    })
    add({
      stage: 'circuit',
      name: 'Manifold set, per manifold',
      nameRo: 'Distribuitor complet, per distribuitor',
      size: `${design.circuits.map((c) => `${c.loops} ports`).join(', ')} — flow meters, actuator tails, air vent and drain each end`,
      why: 'The flow meters are what the loop-length spread is balanced out at, and every manifold needs venting at its own high point and draining at its low one. The cabinet is sized on the port count, not on the room.',
      quantity: n,
    })
  }

  add({
    stage: 'controls',
    name: 'Weather compensation, with an outdoor sensor',
    nameRo: 'Automatizare cu senzor exterior',
    size: `curve set for ${heatPump.flowTempC} °C at ${DESIGN_OUTDOOR_C} °C outside`,
    why: `The single biggest thing separating a heat pump that pays from one that does not. Flow temperature has to fall as it gets milder — the ${heatPump.flowTempC} °C above is the coldest day of the year, not a setting. Run it flat out all season and the running cost is a boiler's.`,
    quantity: 1,
  })
  add({
    stage: 'controls',
    name: 'Cylinder sensor and priority control',
    nameRo: 'Senzor de boiler și comandă prioritate ACM',
    size: 'immersed sensor in the store pocket, driving the diverter',
    why: 'What tells the diverter to swing. In the store’s own pocket rather than strapped to its side, because a sensor reading through insulation is a sensor that charges the store for half an hour after it is already hot.',
    quantity: 1,
  })
  if (design.circuits.length > 0) {
    add({
      stage: 'controls',
      name: 'Room thermostats and loop actuators',
      nameRo: 'Termostate de cameră și actuatoare pe distribuitor',
      size: `one thermostat per heated room, ${design.circuits.reduce((sum, c) => sum + c.loops, 0)} actuators`,
      why: 'A floor is slow, so the thermostats trim rather than control — the flow temperature does the controlling. Actuators normally-closed, so a failed wire leaves a room cold rather than a screed running unattended.',
      quantity: 1,
    })
    add({
      stage: 'controls',
      name: 'Wiring centre',
      nameRo: 'Cutie de conexiuni pentru automatizare',
      size: 'thermostats, actuators, circulators and the heat pump’s demand contact',
      why: 'One place where the thermostats meet the pumps. It also carries the interlock that stops a circulator running against a manifold whose actuators have all closed.',
      quantity: 1,
    mount: { widthMm: 300, heightMm: 220, baseMm: 1700 },
    })
  }
  add({
    stage: 'controls',
    name: 'Electrical supply and local isolator',
    nameRo: 'Alimentare electrică și separator local',
    size: 'dedicated circuit to the unit, isolator within sight of it',
    why: 'Sized and protected on the Panel view with the rest of the installation. The isolator is here because somebody will one day work on the unit in the rain, and the board is inside the house.',
    quantity: 1,
  })

  add({
    stage: 'finishing',
    name: 'Condensate drain from the outdoor unit',
    nameRo: 'Scurgere condens de la unitatea exterioară',
    size: `Ø32 to a soakaway, ${CONDENSATE_L_PER_H} l/h under defrost, trace heated`,
    why: 'An air-source unit is a dehumidifier it did not mean to be, and it does its worst in the weather that freezes what it makes. A drain that ices over lifts the unit onto its own plinth of ice by February.',
    quantity: 1,
  })
  add({
    stage: 'finishing',
    name: 'Glycol fill',
    nameRo: 'Antigel pe bază de propilenglicol',
    size: `${Math.round(design.glycolL)} l inhibited propylene glycol, ${Math.round(GLYCOL_FRACTION * 100)} % of a ${Math.round(water.systemL + water.bufferL)} l fill`,
    why: `A monobloc stands outside with the system water inside it, and ${DESIGN_OUTDOOR_C} °C is the design condition. Propylene rather than ethylene, because this system shares a plant room with drinking water. Inhibited, because plain glycol turns acidic and eats the plate exchanger it was bought to protect.`,
    quantity: 1,
  })
  add({
    stage: 'finishing',
    name: 'Pipe insulation throughout the plant room',
    nameRo: 'Izolație pentru toate conductele din C.T.',
    size: '19 mm on heating and hot water, vapour-tight on the cold feed and the circulation return',
    why: 'Bare pipe in a plant room is a heat loss into a room nobody occupies. Vapour-tight on the cold side is the other half of it: uninsulated cold pipe in a warm room runs with condensation, and condensation is what rusts the brackets and stains the ceiling below.',
    quantity: 1,
  })
  add({
    stage: 'finishing',
    name: 'Valve labels and a system schematic on the wall',
    nameRo: 'Etichetare robineți și schemă hidraulică afișată',
    size: 'every isolating valve, drain and the fill point',
    why: 'The next person in this room will not be the one who built it. Which valve isolates the store and which drains the heating is obvious today and guesswork in five years, and guesswork at a valve is how a system gets drained by mistake.',
    quantity: 1,
  })

  return out
}

/* -------------------------------------------------------------------- the checks */

function audit(
  project: Project,
  design: PlantDesign,
  hasSource: boolean,
  nextId: () => string,
): PlantCheck[] {
  const checks: PlantCheck[] = []
  const say = (severity: PlantCheck['severity'], message: string): void => {
    checks.push({ id: nextId(), severity, message })
  }

  if (!hasSource) {
    say(
      'error',
      'No heat source on the plan, so there is no plant room to design. Place a water heater in the room the plant is to stand in and everything below follows from it.',
    )
    return checks
  }
  if (!design.room) {
    say(
      'error',
      'The heat source is not in a room, so it has no plant room around it. Move it inside one.',
    )
    return checks
  }

  if (design.circuits.length === 0) {
    say(
      'warning',
      'Nothing is heated from this plant yet — place a manifold and the circuits, the buffer and the pumps below all size themselves from what it carries.',
    )
  }

  if (!design.hasExternalWall) {
    say(
      'warning',
      `${design.room.name} has no external wall. A monobloc's flow and return have to cross the facade, and the condensate has to reach the outside — an internal plant room means both go the length of the house first.`,
    )
  }
  if (!design.hasFloorDrain) {
    say(
      'error',
      `${design.room.name} has no floor drain. The safety valve discharges here, the cylinder is drained here and the system is filled here — EN 12828 wants that discharge visible and going somewhere by gravity.`,
    )
  }

  // Said first and said plainly, because it is the one number on this page that a drawing
  // cannot settle and the one that costs the most to get wrong.
  say(
    'warning',
    `The ${design.heatPump.demandKw.toFixed(1)} kW here is what the floor *gives* at ${design.heatPump.flowTempC} °C, not what the house *loses* at ${DESIGN_OUTDOOR_C} °C. A floor is normally laid to give more than the room needs, so this is an upper bound and sizing a unit on it oversizes it — and an oversized heat pump spends the winter cycling on and off, which is where its efficiency and its compressor both go. Size the unit on a calculated EN 12831 heat loss; use this as the ceiling that the emitters can actually deliver against.`,
  )

  if (design.heatPump.flowTempC > GOOD_FLOW_TEMP_C) {
    say(
      'warning',
      `The floor is designed at ${design.heatPump.flowTempC} °C flow. Above about ${GOOD_FLOW_TEMP_C} °C a heat pump's seasonal efficiency falls under the point where it beats a gas boiler on running cost — every degree is worth roughly 2,5 % of it. Open the pitch out or drop the flow temperature and let the floor make it up in area.`,
    )
  }

  // The real check, now that everything carries its own size: does it go on the wall.
  if (design.wall && design.wallUsedMm > design.wall.lengthMm) {
    say(
      'warning',
      `The plant sets out to ${(design.wallUsedMm / 1000).toFixed(1)} m along the ${(design.wall.lengthMm / 1000).toFixed(1)} m wall it is on. Something has to come off that wall — the cylinder and the buffer are the two that need floor, and either can go on the wall opposite at the cost of a longer run between them.`,
    )
  } else if (design.wall && !design.wall.external) {
    say(
      'warning',
      `The heat source is fixed to a wall with another room on the other side of it, so the flow and return have to cross the plant room to reach the facade. Move it onto an external wall and the buried run to the unit is the only pipe outside.`,
    )
  }

  const reheat = design.cylinder.reheatMinutes
  if (reheat > 90) {
    say(
      'info',
      `A charge from cold takes ${Math.round(reheat)} minutes at ${design.heatPump.capacityKw} kW, during which the floor is coasting on its own screed. That is normal for a heat pump and is why the cylinder is sized to get through a morning rather than to be reheated during one.`,
    )
  }

  say(
    'info',
    `The cylinder coil has to be at least ${design.cylinder.coilM2.toFixed(1)} m². This is the specification most often got wrong: a boiler cylinder of the same volume carries about 1 m², and on one of those a ${design.heatPump.capacityKw} kW unit can only put in what the coil will pass.`,
  )
  say(
    'info',
    `Store at ${STORE_TEMP_C} °C with a weekly cycle to ${LEGIONELLA_TEMP_C} °C on the immersion, and a mixing valve on the outlet so the pasteurisation temperature never reaches a tap. A heat pump on its own cannot reach ${LEGIONELLA_TEMP_C} °C at a sensible efficiency, and a store left at ${STORE_TEMP_C} °C without the cycle is a Legionella culture.`,
  )

  if (design.recirculation) {
    say(
      'info',
      `${design.recirculation.deadLegs} outlet${design.recirculation.deadLegs === 1 ? '' : 's'} on the hot network ${design.recirculation.deadLegs === 1 ? 'has' : 'have'} more standing water in the leg feeding ${design.recirculation.deadLegs === 1 ? 'it' : 'them'} than EN 806 allows, which is what puts a circulation loop on the schedule. Insulate the return as well as the flow and put the pump on a timer: a loop left running is a heat loss the heat pump makes up all winter at its worst efficiency, and it is the one part of a plant room that can cost more to run than it saves.`,
    )
  }

  if (design.coldFeed.mainBar < 1.5) {
    say(
      'warning',
      `The main arrives at ${design.coldFeed.mainBar.toFixed(1)} bar. A store fed at that pressure delivers at that pressure, and a thermostatic shower wants around 1 bar at the outlet after everything upstream of it has taken its share — check the entry pressure before specifying the sanitaryware.`,
    )
  }

  const bathrooms = design.cylinder.bathrooms
  if (bathrooms === 0) {
    say(
      'info',
      `No bath or shower on the plan, so the cylinder is at its smallest — ${design.cylinder.litres} l. Draw the sanitaryware in and it sizes itself up.`,
    )
  }

  const hotNetwork = project.fixtures.filter((f) => f.type === 'water-heater').length
  if (hotNetwork > 1) {
    say(
      'warning',
      `There are ${hotNetwork} heat sources on the plan. The plant is designed around the first of them; the rest are drawn but not accounted for here.`,
    )
  }

  return checks
}

/* --------------------------------------------------------------------- the parts */

/**
 * Which wall the plant stands against.
 *
 * The one the heat source is fixed to, because that is the wall its flow and return cross and
 * everything else wants to be on the short run either side of that point. Where the source is
 * free-standing, the longest wall that has outside on the other side of it — a plant room's
 * pipework wants one penetration, not a tour of the building.
 */
function plantWall(
  project: Project,
  room: Room,
  source: Project['fixtures'][number] | null,
): PlantDesign['wall'] {
  const walls = wallsOf(room)
  if (walls.length === 0) return null

  const describe = (index: number): NonNullable<PlantDesign['wall']> => ({
    index,
    lengthMm: walls[index].length,
    heightMm: room.height,
    external: outsideOf(project, room, index),
  })

  if (source && source.wallIndex !== null && walls[source.wallIndex]) {
    return describe(source.wallIndex)
  }

  let best = -1
  for (let i = 0; i < walls.length; i++) {
    if (!outsideOf(project, room, i)) continue
    if (best < 0 || walls[i].length > walls[best].length) best = i
  }
  return describe(best >= 0 ? best : 0)
}

/**
 * Set the plant out along the wall, in the order the water meets it.
 *
 * Floor-standing plant is packed along the wall from the outside corner, because that is where
 * the pipes come through and the run to the first thing they meet should be the short one.
 * What hangs on the wall is packed the same way in its own band above, which is how a plant
 * room is actually built: the cylinder and the buffer take the floor, and the vessels and the
 * gear go over them.
 */
function setOut(
  components: PlantComponent[],
  wallLengthMm: number,
): { arrangement: PlantPlacement[]; usedMm: number } {
  const arrangement: PlantPlacement[] = []
  // Three rows: what stands on the floor, what hangs at working height, and what goes above
  // it. All three start clear of the penetration, because the pipes come through there.
  const next = [PENETRATION_ZONE_MM, PENETRATION_ZONE_MM, PENETRATION_ZONE_MM]
  const rowOf = (baseMm: number): number =>
    baseMm === 0 ? 0 : baseMm < WORKING_HEIGHT_MM ? 1 : 2

  for (const component of components) {
    const mount = component.mount
    if (!mount || component.quantity === 0) continue
    const row = rowOf(mount.baseMm)
    const at = next[row]
    arrangement.push({
      componentId: component.id,
      name: component.name,
      tag: arrangement.length + 1,
      atMm: at,
      mount,
    })
    next[row] = at + mount.widthMm + PLANT_GAP_MM
  }

  void wallLengthMm
  return { arrangement, usedMm: Math.max(...next) - PLANT_GAP_MM }
}

/** How many rooms in the house have something you bathe in. */
function countBathrooms(project: Project): number {
  const rooms = new Set<string>()
  for (const fixture of project.fixtures) {
    if (BATHING.has(fixture.type) && fixture.roomId) rooms.add(fixture.roomId)
  }
  return rooms.size
}

/** Smallest supply size that carries the heat pump's flow quietly. */
function sizeFor(project: Project, flowLh: number): number {
  const material = project.settings.supply.material
  const ladder = supplySizes(material)
  const flowM3s = flowLh / 1000 / 3600
  const needed = Math.sqrt((4 * flowM3s) / (Math.PI * PRIMARY_VELOCITY)) * 1000
  for (const size of ladder) {
    if (boreOf(material, size.od) >= needed) return size.od
  }
  return ladder[ladder.length - 1].od
}

/** Height of the topmost heated floor's pipe, which is what the vessel is charged against. */
function topOfSystem(project: Project): number {
  const levels = sortedLevels(project)
  const top = levels[levels.length - 1]
  return top ? top.elevation : 0
}

/**
 * Does this room have a wall on the outside of the building?
 *
 * Stepping out through each wall and asking whether that lands in another room on the same
 * storey. Cheaper than resolving the building outline, and it gives the same answer for the
 * only question being asked: can a pipe leave this room without crossing another one.
 */
function facesOutside(project: Project, room: Room): boolean {
  return edgesOf(room.outline).some((_, index) => outsideOf(project, room, index))
}

/** Is there outside on the other side of this particular wall? */
function outsideOf(project: Project, room: Room, index: number): boolean {
  const edges = edgesOf(room.outline)
  const edge = edges[index]
  if (!edge || edge.length < 600) return false
  const neighbours = roomsOnLevel(project, room.levelId).filter((r) => r.id !== room.id)
  const middle = add2(edge.a, scale2(edge.dir, edge.length / 2))
  // Outward is whichever side of the wall is not the room itself.
  const step = scale2(norm2(perp2(edge.dir)), room.wallThickness + 200)
  const outward = pointInPolygon(add2(middle, step), room.outline)
    ? sub2(middle, step)
    : add2(middle, step)
  return !neighbours.some((other) => pointInPolygon(outward, other.outline))
}
