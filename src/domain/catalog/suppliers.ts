/**
 * The shopping list: the bill of materials turned into things you can actually put in a
 * basket at a Romanian merchant.
 *
 * The BOM is written in the language of the drawing — `Waste pipe DN100`, `Oblique tee 45°`,
 * `MCB 16 A` — which is the right language for a schedule and the wrong one for a counter in
 * Bacău. Nobody stocks "DN100 waste pipe"; they stock *țeavă PVC canalizare Ø110*. This module
 * is the translation layer, and it does three jobs the BOM deliberately does not:
 *
 *  - **Renames.** Every line gets the words a Romanian catalogue uses, so the search that
 *    follows returns pipe rather than nothing.
 *  - **Resizes.** The router works in the nominal bores the standards are written in; the
 *    merchant sells the outside diameters the extruders make. DN100 drainage is Ø110 PVC and
 *    DN15 copper-equivalent supply is Ø20 PPR, and pretending otherwise puts an unbuyable
 *    number on the list.
 *  - **Adds the trade's usual allowance.** Pipe is sold in bars, not metres, and no fitter
 *    orders the exact count of bends. The allowance is stated in the row rather than folded
 *    silently into the quantity, because a number you cannot explain is a number you cannot
 *    check.
 *
 * It also derives the parts of a consumer unit that the routed geometry cannot know about —
 * the enclosure, the main switch, the RCCBs, the comb, the rail, the bars, the blanks. Those
 * come off `PanelDesign`, not off `fittings.ts`, which only ever sees pipe and cable.
 *
 * Nothing here invents a product URL. Every link is the merchant's own search page with the
 * Romanian terms in it: a search always resolves, whereas a guessed SKU is a 404 dressed up
 * as knowledge.
 */

import type { BomLine, Circuit, PanelDesign, Project, RoutingResult } from '../types.ts'

/* --------------------------------------------------------------------- trades */

/**
 * How a builder splits the job, which is not how the solver splits it: cold and hot are one
 * visit to one aisle and one fitter, even though they are two networks.
 */
export type Trade = 'drainage' | 'water' | 'electrical'

export const TRADES: Trade[] = ['drainage', 'water', 'electrical']

export const TRADE_LABEL: Record<Trade, string> = {
  drainage: 'Drainage',
  water: 'Water supply',
  electrical: 'Electrical',
}

/** The Romanian aisle, for anyone reading the list at the counter. */
export const TRADE_LABEL_RO: Record<Trade, string> = {
  drainage: 'Canalizare',
  water: 'Instalații sanitare',
  electrical: 'Electrice',
}

/* ---------------------------------------------------------------------- items */

export interface ShoppingItem {
  /** Stable within one solve, so a list can be keyed and diffed without re-sorting. */
  id: string
  trade: Trade
  /** English, in the drawing's own words, so the row can be traced back to the schedule. */
  description: string
  /** How a Romanian merchant's catalogue names the part, diacritics and all. */
  romanian: string
  /** The same words without diacritics, which is what goes into a search box. */
  terms: string
  unit: 'm' | 'pc'
  /** What the drawing needs. */
  required: number
  /** What to order once the trade's usual allowance is on it. */
  quantity: number
  /** Why `quantity` is not `required`, or null when the two agree. */
  note: string | null
}

/* ------------------------------------------------------------------ the sizes */

/**
 * Drainage is sold in these outside diameters and no others.
 *
 * The router sizes to EN 12056-2, which talks in nominal bores — DN40, DN50, DN70, DN100.
 * A merchant's rack has Ø40, Ø50, Ø75, Ø110. The two series are the same pipes under
 * different names, so the mapping is up to the next stocked size rather than a rounding: a
 * DN70 branch is served by Ø75 and never by Ø50.
 */
const PVC_DIAMETERS = [32, 40, 50, 75, 110, 125]

/**
 * Nominal supply bore to the PPR pipe that carries it.
 *
 * PPR is racked by *outside* diameter — Ø16, Ø20, Ø25, Ø32 — and its walls are thick, so the
 * match has to be made on the waterway rather than on the label. Ø20 has about 13 mm of bore,
 * which is a DN15; Ø25 about 17, a DN18; Ø32 about 21, a DN22. Reading the labels across
 * instead — DN22 to Ø25 because both are called "three-quarter" — would quietly throttle the
 * run it was meant to serve.
 */
const PPR_FOR_DN: Array<[maxDn: number, outsideDiameter: number]> = [
  [12, 16],
  [15, 20],
  [18, 25],
  [Infinity, 32],
]

/** Conductor sizes a domestic installation is wired in. */
const CABLE_MM2 = [1.5, 2.5, 4, 6, 10, 16]

const atLeast = (value: number, stocked: number[]): number =>
  stocked.find((size) => size >= value) ?? stocked[stocked.length - 1]

const pvcSize = (dn: number): number => atLeast(dn, PVC_DIAMETERS)

const pprSize = (dn: number): number =>
  (PPR_FOR_DN.find(([maxDn]) => dn <= maxDn) ?? PPR_FOR_DN[PPR_FOR_DN.length - 1])[1]

const cableSize = (mm2: number): number => atLeast(mm2, CABLE_MM2)

/**
 * Angles PVC drainage fittings are actually moulded in.
 *
 * The catalogue runs 15°, 30°, 45°, 67°30' and 87°30' — the last two are the ones printed as
 * "67" and "87" on the box, and neither is a right angle, because a drain turned square is a
 * drain that blocks.
 */
const PVC_ANGLES = [15, 30, 45, 67, 87]

const pvcAngle = (degrees: number): number =>
  PVC_ANGLES.reduce((best, angle) =>
    Math.abs(angle - degrees) < Math.abs(best - degrees) ? angle : best,
  )

/** RCCBs below 40 A exist but are not what a merchant has on the shelf. */
const RCCB_RATINGS = [40, 63, 80, 100]

/* ----------------------------------------------------------- the parts, named */

/**
 * A part before quantities are known: what it is, what to call it, and what to search for.
 *
 * `key` is what two lines have to agree on to be the same purchase. It matters that the
 * drainage runs and the soil stack collapse onto one row — they are the same pipe off the
 * same rack, and a list that asks for it twice gets it bought twice.
 */
interface Part {
  trade: Trade
  key: string
  description: string
  romanian: string
  terms: string
  allowance: Allowance
}

/**
 * How much more than the drawing to buy.
 *
 * `bars` is the honest one: PVC and PPR are sold in fixed lengths and the offcuts are yours
 * whether you wanted them or not. `slack` covers cable, which comes off a roll but is never
 * cut to the exact routed length. `spare` puts a few extra fittings in the van, but only once
 * the count is high enough that one more is noise rather than a doubling.
 */
type Allowance =
  | { kind: 'none' }
  | { kind: 'bars'; length: number }
  | { kind: 'slack'; fraction: number }
  | { kind: 'spare'; fraction: number; threshold: number }

const NONE: Allowance = { kind: 'none' }
/** Interior PVC drainage is racked in 3 m bars; the shorter cuts are a special order. */
const PVC_BARS: Allowance = { kind: 'bars', length: 3 }
/** PPR comes in 4 m bars, and welding one costs a stub at each end. */
const PPR_BARS: Allowance = { kind: 'bars', length: 4 }
const CABLE_SLACK: Allowance = { kind: 'slack', fraction: 0.1 }
const FITTING_SPARE: Allowance = { kind: 'spare', fraction: 0.1, threshold: 10 }

/* --------------------------------------------------------------- drainage */

function drainagePipe(dn: number): Part {
  const d = pvcSize(dn)
  return {
    trade: 'drainage',
    key: `pvc-pipe-${d}`,
    description: `PVC soil and waste pipe Ø${d} mm`,
    romanian: `Țeavă PVC canalizare interioară Ø${d}`,
    terms: `teava PVC canalizare ${d}`,
    allowance: PVC_BARS,
  }
}

function drainageFitting(label: string, angle: number | null, dn: number): Part | null {
  const d = pvcSize(dn)
  const base = { trade: 'drainage' as const, allowance: FITTING_SPARE }

  if (label === 'Bend' || label === 'Elbow') {
    const a = pvcAngle(angle ?? 87)
    return {
      ...base,
      key: `pvc-bend-${a}-${d}`,
      description: `PVC bend ${a}° Ø${d} mm`,
      romanian: `Cot PVC canalizare ${a}° Ø${d}`,
      terms: `cot PVC ${a} grade ${d}`,
    }
  }

  if (label === 'Oblique tee' || label === 'Square tee' || label === 'Tee') {
    // A drainage branch is bought by its angle, and the 45 and the 87 are not interchangeable
    // parts: the oblique one turns the flow, the square one stops it.
    const a = label === 'Tee' ? 45 : pvcAngle(angle ?? 45)
    return {
      ...base,
      key: `pvc-branch-${a}-${d}`,
      description: `PVC branch ${a}° Ø${d} mm`,
      romanian: `Ramificație PVC ${a}° Ø${d}`,
      terms: `ramificatie PVC ${a} grade ${d}`,
    }
  }

  switch (label) {
    case 'Reducer':
      return {
        ...base,
        key: `pvc-reducer-${d}`,
        description: `PVC reducer to Ø${d} mm`,
        romanian: `Reducție PVC canalizare Ø${d}`,
        terms: `reductie PVC canalizare ${d}`,
      }
    // A stack connector and a plain coupling are the same slip socket off the same rack.
    case 'Coupling':
    case 'Stack connector':
      return {
        ...base,
        key: `pvc-coupling-${d}`,
        description: `PVC slip coupling Ø${d} mm`,
        romanian: `Mufă PVC canalizare Ø${d}`,
        terms: `mufa PVC canalizare ${d}`,
      }
    case 'Trap':
      return {
        ...base,
        key: `pvc-trap-${d}`,
        description: `Trap Ø${d} mm`,
        romanian: `Sifon PVC Ø${d}`,
        terms: `sifon PVC ${d}`,
      }
    case 'Air admittance valve':
      return {
        ...base,
        key: `pvc-aav-${d}`,
        description: `Air admittance valve Ø${d} mm`,
        romanian: `Aerator canalizare Ø${d}`,
        terms: `aerator canalizare ${d}`,
      }
    case 'Terminal connection':
      return {
        ...base,
        key: `pvc-connector-${d}`,
        description: `Waste connection Ø${d} mm`,
        romanian: `Racord canalizare Ø${d}`,
        terms: `racord canalizare ${d}`,
      }
    default:
      return null
  }
}

/* ------------------------------------------------------------------ supply */

/**
 * Hot and cold are the same aisle but not the same pipe.
 *
 * Hot runs get fibreglass-reinforced PPR — *PPR cu inserție de fibră* — because plain PPR
 * moves about three times as much over its length when it is hot, and a long straight hot run
 * clipped like a cold one will bow out of its clips within a season.
 */
function supplyPipe(hot: boolean, size: number, alreadyOutsideDiameter = false): Part {
  const d = alreadyOutsideDiameter ? size : pprSize(size)
  return {
    trade: 'water',
    key: `ppr-pipe-${hot ? 'fibre' : 'plain'}-${d}`,
    description: `PPR ${hot ? 'hot' : 'cold'} water pipe Ø${d} mm${hot ? ', fibreglass-reinforced' : ''}`,
    romanian: hot ? `Țeavă PPR cu inserție fibră Ø${d}` : `Țeavă PPR Ø${d}`,
    terms: hot ? `teava PPR fibra ${d}` : `teava PPR ${d}`,
    allowance: PPR_BARS,
  }
}

function supplyFitting(
  label: string,
  angle: number | null,
  size: number,
  alreadyOutsideDiameter = false,
): Part | null {
  const d = alreadyOutsideDiameter ? size : pprSize(size)
  const base = { trade: 'water' as const, allowance: FITTING_SPARE }

  if (label === 'Bend' || label === 'Elbow') {
    // PPR is welded, so its elbows come in 45 and 90 only; anything else is made from two.
    const a = (angle ?? 90) <= 60 ? 45 : 90
    return {
      ...base,
      key: `ppr-elbow-${a}-${d}`,
      description: `PPR elbow ${a}° Ø${d} mm`,
      romanian: `Cot PPR ${a}° Ø${d}`,
      terms: `cot PPR ${a} grade ${d}`,
    }
  }

  if (label === 'Oblique tee' || label === 'Square tee' || label === 'Tee') {
    // There is no oblique tee in a welded pressure system: every branch is a square teu, and
    // an angle on the drawing is made by turning the pipe into it rather than the fitting.
    return {
      ...base,
      key: `ppr-tee-${d}`,
      description: `PPR tee Ø${d} mm`,
      romanian: `Teu PPR Ø${d}`,
      terms: `teu PPR ${d}`,
    }
  }

  switch (label) {
    case 'Reducer':
      return {
        ...base,
        key: `ppr-reducer-${d}`,
        description: `PPR reducer to Ø${d} mm`,
        romanian: `Reducție PPR Ø${d}`,
        terms: `reductie PPR ${d}`,
      }
    case 'Coupling':
    case 'Stack connector':
      return {
        ...base,
        key: `ppr-coupling-${d}`,
        description: `PPR socket Ø${d} mm`,
        romanian: `Mufă PPR Ø${d}`,
        terms: `mufa PPR ${d}`,
      }
    case 'Terminal connection':
      // Where the pipe stops and a tap begins: the wall-plate elbow with a female thread that
      // every basin, sink and shower in the country is fed from.
      return {
        ...base,
        key: `ppr-wallplate-${d}`,
        description: `PPR wall-plate elbow with female thread, Ø${d} mm`,
        romanian: `Cot PPR cu filet interior Ø${d}`,
        terms: `cot PPR filet interior ${d}`,
      }
    case 'Trap':
      return {
        ...base,
        key: `ppr-valve-${d}`,
        description: `Isolating valve Ø${d} mm`,
        romanian: `Robinet PPR Ø${d}`,
        terms: `robinet PPR ${d}`,
      }
    default:
      return null
  }
}

/* -------------------------------------------------------------- electrical */

function cablePart(cores: number, mm2: number): Part {
  const size = cableSize(mm2)
  const gauge = `${cores}x${size}`
  return {
    trade: 'electrical',
    key: `cable-${gauge}`,
    description: `Cable ${cores} × ${size} mm²`,
    romanian: `Cablu MYYM ${gauge}`,
    terms: `cablu MYYM ${gauge}`,
    allowance: CABLE_SLACK,
  }
}

function mcbPart(amps: number, poles: number, curve = 'C'): Part {
  const prefix = poles === 3 ? '3P ' : ''
  return {
    trade: 'electrical',
    key: `mcb-${poles}p-${curve}${amps}`,
    description: `MCB ${amps} A curve ${curve}, ${poles === 3 ? 'three-pole' : 'single-pole'}`,
    romanian: `Siguranță automată ${prefix}${curve}${amps}`,
    terms: `siguranta automata ${prefix}${curve}${amps}`,
    allowance: NONE,
  }
}

/* ------------------------------------------------------- reading the BOM back */

/** `Bend 45° DN110` → label `Bend`, angle 45, size 110. */
interface ParsedItem {
  label: string
  angle: number | null
  size: number
  /** True where the schedule already gave a shelf size, so `pprSize` must not run again. */
  alreadyOutsideDiameter: boolean
}

/**
 * The BOM writes its item names by hand in `fittings.ts`, so they are read back by hand here.
 *
 * That is a seam worth being honest about: a new fitting label there and no case for it here
 * leaves a row that falls back to the English text, which the tests catch rather than the
 * user.
 */
function parseFitting(item: string): ParsedItem | null {
  // Drainage is still scheduled by nominal bore; supply is scheduled by the outside diameter
  // and material it is bought in, and needs no conversion here.
  const withSize = /^(.+?) (?:DN(\d+)|Ø(\d+) [\w-]+)$/.exec(item)
  const body = withSize ? withSize[1] : item
  const size = withSize ? Number(withSize[2] ?? withSize[3]) : 0
  const alreadyOutsideDiameter = Boolean(withSize?.[3])

  const angled = /^(Bend|Elbow|Oblique tee|Square tee) (\d+)°$/.exec(body)
  if (angled) {
    return { label: angled[1], angle: Number(angled[2]), size, alreadyOutsideDiameter }
  }

  const plain = /^(Tee|Reducer|Coupling|Trap|Stack connector|Air admittance valve|Terminal connection)$/.exec(
    body,
  )
  if (plain) return { label: plain[1], angle: null, size, alreadyOutsideDiameter }

  return null
}

/**
 * The runs, however the schedule chose to name them.
 *
 * A drain, a soil stack and the vent stub above it are three different lines on the drawing
 * for three different reasons — and one product on the rack. The same is true of a rising
 * main and the branch it feeds. They are all matched here and merged downstream.
 */
const PIPE_ITEM =
  /^(Cold water pipe|Hot water pipe|Waste pipe|Vent pipe|Cold water rising main|Hot water rising main|Soil stack) (?:DN(\d+)|Ø(\d+) [\w-]+)$/
const CABLE_ITEM = /^(?:Cable|Cable riser) (\d+) × ([\d.]+) mm²$/
/** `MCB C16 · 6 kA — Kitchen sockets`, and its three-phase form `MCB 3P+N C16 · 6 kA — …`. */
const MCB_ITEM = /^MCB (?:(3P\+N) )?([BC])(\d+) · ([\d.]+) kA — (.+)$/

/**
 * A line the mapping does not recognise still has to be orderable.
 *
 * The fallback is the English text, unchanged and untranslated: it will not search well, but
 * it is visibly a gap rather than a plausible-looking Romanian phrase for a part that may not
 * be the right one. The tests assert the sample project never reaches it.
 */
function untranslated(line: BomLine): Part {
  return {
    trade: line.system === 'waste' ? 'drainage' : line.system === 'power' ? 'electrical' : 'water',
    key: `raw-${line.system}-${line.item}`,
    description: line.item,
    romanian: line.item,
    terms: line.item,
    allowance: NONE,
  }
}

function partFor(line: BomLine, circuits: Circuit[]): Part {
  const pipe = PIPE_ITEM.exec(line.item)
  if (pipe) {
    if (line.system === 'waste') return drainagePipe(Number(pipe[2]))
    // The supply schedule already names the diameter it is sold in.
    return supplyPipe(line.system === 'hot', Number(pipe[2] ?? pipe[3]), Boolean(pipe[3]))
  }

  const cable = CABLE_ITEM.exec(line.item)
  if (cable) return cablePart(Number(cable[1]), Number(cable[2]))

  const mcb = MCB_ITEM.exec(line.item)
  if (mcb) {
    const circuit = circuits.find((c) => c.name === mcb[5])
    return mcbPart(Number(mcb[3]), mcb[1] ? 3 : (circuit?.poles ?? 1), mcb[2])
  }

  const fitting = parseFitting(line.item)
  if (fitting) {
    const mapped =
      line.system === 'waste'
        ? drainageFitting(fitting.label, fitting.angle, fitting.size)
        : line.system === 'power'
          ? null
          : supplyFitting(
              fitting.label,
              fitting.angle,
              fitting.size,
              fitting.alreadyOutsideDiameter,
            )
    if (mapped) return mapped
  }

  return untranslated(line)
}

/* ----------------------------------------------------- the board, as parts */

/**
 * What a consumer unit is made of besides its breakers.
 *
 * The routed geometry knows about cable and the standards module knows about protection, so
 * between them the BOM gets the MCBs — and stops. Everything the enclosure itself is built
 * from has to be read off the finished board design: the box, the incomer, the RCCBs behind
 * which the ways are grouped, the comb that feeds each row, the rail they clip to, the bars
 * the neutrals and earths land on, and blanks for the modules left over.
 */
function panelParts(
  panel: PanelDesign,
  storey: string,
): Array<{ part: Part; quantity: number; unit: 'm' | 'pc'; context: string }> {
  const context = `${panel.name} — ${storey}`
  const rows: Array<{ part: Part; quantity: number; unit: 'm' | 'pc'; context: string }> = []
  const add = (part: Part, quantity: number, unit: 'm' | 'pc' = 'pc') =>
    rows.push({ part, quantity, unit, context })

  const threePhase = panel.supply === 'three-phase'
  const poles = threePhase ? 4 : 2

  add(
    {
      trade: 'electrical',
      key: `enclosure-${panel.enclosureModules}-${panel.rows}`,
      description: `Consumer unit enclosure, ${panel.enclosureModules} modules over ${panel.rows} row${panel.rows === 1 ? '' : 's'}`,
      romanian: `Tablou electric ${panel.enclosureModules} module`,
      terms: `tablou electric ${panel.enclosureModules} module`,
      allowance: NONE,
    },
    1,
  )

  add(
    {
      trade: 'electrical',
      key: `main-switch-${poles}-${panel.mainBreakerAmps}`,
      // On the main board this is the incomer; on a sub-board the same device is the isolator
      // that lets the board be worked on without killing the house.
      description: `${panel.isMain ? 'Main switch' : 'Isolator'} ${panel.mainBreakerAmps} A, ${poles}-pole`,
      romanian: `Întrerupător general ${poles}P ${panel.mainBreakerAmps} A`,
      terms: `intrerupator general ${poles}P ${panel.mainBreakerAmps}A`,
      allowance: NONE,
    },
    1,
  )

  for (const group of panel.rcdGroups) {
    // An RCCB has to carry everything behind it, so it is rated at or above the incomer —
    // never at the sum of the breakers it protects, which would be an accident of grouping.
    const rating = atLeast(panel.mainBreakerAmps, RCCB_RATINGS)
    add(
      {
        trade: 'electrical',
        key: `rccb-${group.poles}-${rating}-${group.sensitivity}`,
        description: `RCCB ${rating} A ${group.sensitivity} mA, ${group.poles}-pole`,
        romanian: `Întrerupător diferențial ${group.poles}P ${rating}A ${group.sensitivity}mA`,
        terms: `intrerupator diferential ${group.poles}P ${rating}A ${group.sensitivity}mA`,
        allowance: NONE,
      },
      1,
    )
  }

  add(
    {
      trade: 'electrical',
      key: `comb-${poles}`,
      description: `Busbar comb, ${poles}-pole, one per row`,
      romanian: `Pieptene de conexiune ${poles}P`,
      terms: `pieptene conexiune ${poles}P`,
      allowance: NONE,
    },
    panel.rows,
  )

  add(
    {
      trade: 'electrical',
      key: 'din-rail',
      // 35 mm top-hat rail, the only kind a modular device clips to. It is sold long and cut
      // to the enclosure, so one length per row is the order rather than one per board.
      description: 'DIN rail 35 mm, cut to the enclosure width',
      romanian: 'Șină DIN 35 mm',
      terms: 'sina DIN 35mm',
      allowance: NONE,
    },
    panel.rows,
  )

  add(
    {
      trade: 'electrical',
      key: 'busbar-terminals',
      description: 'Neutral and earth terminal bars',
      romanian: 'Regletă de nul și de împământare',
      terms: 'regleta nul si pamant tablou',
      allowance: NONE,
    },
    2,
  )

  const blanks = Math.max(0, panel.enclosureModules - panel.modulesUsed)
  if (blanks > 0) {
    add(
      {
        trade: 'electrical',
        key: 'blank-module',
        // The gaps are a finger's width from a live busbar; a board is not finished until
        // they are closed.
        description: 'Blanking plate, 1 module',
        romanian: 'Capac orb 1 modul',
        terms: 'capac orb 1 modul',
        allowance: NONE,
      },
      blanks,
    )
  }

  // A sub-board is only as good as the cable that reaches it, and that cable is not on any
  // circuit, so nothing upstream of here has counted it.
  if (!panel.isMain && panel.submainMm2 !== null && panel.submainLength > 0) {
    add(cablePart(threePhase ? 5 : 3, panel.submainMm2), panel.submainLength / 1000, 'm')
  }

  return rows
}

/* ------------------------------------------------------------- the allowance */

const round2 = (value: number): number => Math.round(value * 100) / 100

/** Apply the trade's usual over-order and say, in the row, what was done and why. */
function applyAllowance(
  allowance: Allowance,
  required: number,
): { quantity: number; note: string | null } {
  switch (allowance.kind) {
    case 'bars': {
      // The 10% goes on before the rounding, not after: a run that needs 5.9 m of a 3 m bar
      // wants three bars, and deciding that from 5.9 rather than from 6.5 is how you end up
      // one coupling short on site.
      const bars = Math.max(1, Math.ceil((required * 1.1) / allowance.length))
      const quantity = bars * allowance.length
      return {
        quantity,
        note: `${round2(required)} m of run; sold in ${allowance.length} m bars, so ${bars} bar${bars === 1 ? '' : 's'} — ${quantity} m — with the offcuts covering the 10% for cuts.`,
      }
    }
    case 'slack': {
      const quantity = Math.ceil(required * (1 + allowance.fraction))
      return {
        quantity,
        note: `${round2(required)} m routed, ordered as ${quantity} m — ${Math.round(allowance.fraction * 100)}% for slack at the board, the boxes and the terminations.`,
      }
    }
    case 'spare': {
      if (required < allowance.threshold) return { quantity: required, note: null }
      const spare = Math.ceil(required * allowance.fraction)
      return {
        quantity: required + spare,
        note: `${required} on the drawing, ${spare} spare — a part this numerous is one you will drop, split or mis-cut at least once.`,
      }
    }
    case 'none':
      return { quantity: required, note: null }
  }
}

/* ---------------------------------------------------------------- the list */

const TRADE_RANK: Record<Trade, number> = { drainage: 0, water: 1, electrical: 2 }

/**
 * Everything the design needs, as rows you could read out at a counter.
 *
 * Lines that resolve to the same part are merged — the drainage runs and the soil stack are
 * one entry for one pipe — because the point of the list is what goes in the basket, and a
 * basket does not care which branch of the drawing a metre came from.
 */
export function shoppingList(project: Project, result: RoutingResult): ShoppingItem[] {
  const storeyName = (levelId: string): string =>
    project.levels.find((level) => level.id === levelId)?.name ?? 'unplaced'

  interface Row {
    part: Part
    unit: 'm' | 'pc'
    context: string
    required: number
  }
  const merged = new Map<string, Row>()

  const collect = (part: Part, unit: 'm' | 'pc', quantity: number, context: string): void => {
    // The context is part of the key so that two boards on two storeys stay two rows: the
    // parts are identical but the errands are not.
    const key = `${part.key}|${unit}|${context}`
    const existing = merged.get(key)
    if (existing) existing.required += quantity
    else merged.set(key, { part, unit, context, required: quantity })
  }

  for (const line of result.bom) {
    collect(partFor(line, result.circuits), line.unit, line.quantity, '')
  }

  for (const panel of result.panels) {
    for (const row of panelParts(panel, storeyName(panel.levelId))) {
      collect(row.part, row.unit, row.quantity, row.context)
    }
  }

  const items = [...merged.values()].map(({ part, unit, context, required }): ShoppingItem => {
    const rounded = unit === 'pc' ? Math.round(required) : round2(required)
    const { quantity, note } = applyAllowance(part.allowance, rounded)
    const forBoard = context ? `For ${context}.` : ''
    return {
      id: `${part.key}${context ? `|${context}` : ''}`,
      trade: part.trade,
      description: part.description,
      romanian: part.romanian,
      terms: part.terms,
      unit,
      required: rounded,
      quantity,
      note: [note, forBoard].filter(Boolean).join(' ') || null,
    }
  })

  // Deterministic, and in the order the trades turn up on site: the drain goes in before the
  // pipe and the pipe before the cable.
  return items.sort(
    (a, b) =>
      TRADE_RANK[a.trade] - TRADE_RANK[b.trade] ||
      a.description.localeCompare(b.description) ||
      a.id.localeCompare(b.id),
  )
}

/* ------------------------------------------------------------- the merchants */

export type SupplierId = 'dedeman' | 'leroy-merlin' | 'hornbach' | 'brico-depot' | 'romstal'

export interface Supplier {
  id: SupplierId
  name: string
  /** Short label for a link that has to fit in a table cell. */
  short: string
  /** The merchant's own search page for these words. */
  search: (terms: string) => string
}

/** Query-string merchants: `URLSearchParams` gets the encoding right, including the spaces. */
const query = (base: string, params: Record<string, string>): string =>
  `${base}?${new URLSearchParams(params).toString()}`

/**
 * Where to buy it.
 *
 * Every entry is the merchant's *search* URL, never a product page. A deep link would need a
 * SKU, and a SKU we did not read off their catalogue is a guess that 404s the first time
 * somebody clicks it — a search for the right Romanian words always resolves, and degrades
 * into a short list rather than into a dead end.
 *
 * The URL shapes below were each checked against the live sites on 2026-08-11:
 *
 *  - **Dedeman** — `/ro/catalogsearch/result/?q=` fetched with `teava pvc canalizare 110` and
 *    returned 12 products (Magento's standard search route).
 *  - **Hornbach** — `/s/<terms>` fetched with the same words and returned 494 results; the
 *    query is a path segment, not a parameter.
 *  - **Leroy Merlin** — `/produse/search/<terms>`, also a path segment. The site refuses
 *    automated fetches (403), so it was confirmed two other ways: their `robots.txt` carries
 *    a long list of `Disallow: /produse/search/*…` rules, and the shape appears in the search
 *    index as `/produse/search/compo` titled "Cauti compo? Avem 136 de produse".
 *  - **Brico Dépôt** — `/catalogsearch/result/?q=`, the same Magento route as Dedeman, which
 *    fits their `.html`-suffixed category URLs. Their host would not answer this machine at
 *    all (connection reset on every request), so it was confirmed from the search index,
 *    which lists the live `bricodepot.ro/catalogsearch/result/?q=teka`.
 *  - **Romstal** — `index.php?page=search&sn.q=`, read straight off the search form on their
 *    home page (`<form action="index.php" name="luigisbox_search">` with a hidden
 *    `page=search` and a text input named `sn.q`) and then fetched, which returned a page
 *    headed "Rezultatele cautarii".
 *
 * These are search endpoints, so they change less often than a catalogue does — but if a link
 * ever lands on a home page rather than a result list, this comment is the thing to re-check.
 */
export const SUPPLIERS: Supplier[] = [
  {
    id: 'dedeman',
    name: 'Dedeman',
    short: 'Dedeman',
    search: (terms) => query('https://www.dedeman.ro/ro/catalogsearch/result/', { q: terms }),
  },
  {
    id: 'leroy-merlin',
    name: 'Leroy Merlin România',
    short: 'Leroy Merlin',
    search: (terms) => `https://www.leroymerlin.ro/produse/search/${encodeURIComponent(terms)}`,
  },
  {
    id: 'hornbach',
    name: 'Hornbach România',
    short: 'Hornbach',
    search: (terms) => `https://www.hornbach.ro/s/${encodeURIComponent(terms)}`,
  },
  {
    id: 'brico-depot',
    name: 'Brico Dépôt România',
    short: 'Brico Dépôt',
    search: (terms) => query('https://www.bricodepot.ro/catalogsearch/result/', { q: terms }),
  },
  {
    id: 'romstal',
    name: 'Romstal',
    short: 'Romstal',
    // The installation merchant rather than the DIY shed: the only one of the five that
    // stocks a 4-pole RCCB and a fibre-insert PPR bar in the same visit.
    search: (terms) => query('https://www.romstal.ro/index.php', { page: 'search', 'sn.q': terms }),
  },
]

export interface SupplierLink {
  supplier: SupplierId
  name: string
  short: string
  url: string
}

/** One search link per merchant, in the order a Romanian buyer would try them. */
export function searchLinks(item: ShoppingItem): SupplierLink[] {
  return SUPPLIERS.map((supplier) => ({
    supplier: supplier.id,
    name: supplier.name,
    short: supplier.short,
    url: supplier.search(item.terms),
  }))
}

/* ------------------------------------------------------------------ plain text */

/**
 * The list as text, because that is how it actually reaches a merchant — pasted into a
 * WhatsApp message, an email, or a request for a quote.
 *
 * Romanian first and the English underneath: the person reading it is quoting from the
 * Romanian, and the English is there for whoever has the drawing open.
 */
export function shoppingListText(items: ShoppingItem[], projectName: string): string {
  const lines: string[] = [`${projectName} — listă de materiale`, '']

  for (const trade of TRADES) {
    const group = items.filter((item) => item.trade === trade)
    if (group.length === 0) continue
    lines.push(`${TRADE_LABEL_RO[trade].toUpperCase()} (${TRADE_LABEL[trade]})`)
    for (const item of group) {
      const unit = item.unit === 'm' ? 'm' : 'buc'
      lines.push(`  ${item.quantity} ${unit}  ${item.romanian}`)
      lines.push(`        ${item.description}${item.note ? ` — ${item.note}` : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
