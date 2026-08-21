/**
 * Façade scaffolding — the sizes it is actually hired in, and the rules it is put up to.
 *
 * A scaffold is not bought by the metre, it is hired by the piece, and the pieces are a fixed
 * kit: whatever the yard sends, the frames are 2,00 m tall and the bays are one of four or five
 * lengths. That is the whole reason this module exists — a façade is a continuous thing and a
 * scaffold is not, so the length of wall has to be turned into a count of parts before anybody
 * can be asked for a price.
 *
 * Two systems get hired for a house in Romania and they are genuinely different kit:
 *
 *  - **Schelă tip italian** — the yard scaffold. A 2,00 × 1,00 m welded frame, a fixed 2,00 m
 *    bay set by the length of the cross braces, wooden or steel decks laid on the frame's own
 *    transom. It only comes in that one bay, it goes up fast, and it is what stands outside
 *    most houses being rendered or insulated in this country.
 *  - **Schelă de fațadă cu cadre** — the system scaffold (Layher, Plettac, Baumann and their
 *    clones), certified to SR EN 12810 with bays from 0,73 to 3,07 m and decks that hook and
 *    lock. It costs more per square metre, it fits an awkward wall without a filler bay, and
 *    on a long straight façade it needs a third fewer frames because the bays are half as
 *    many again.
 *
 * The rules are SR EN 12811-1 (what a scaffold has to carry and how it is guarded) and
 * SR EN 12810-1/-2 (façade scaffolds assembled from prefabricated components), which is what
 * both systems are sold against. What sits on top of them in Romania is HG 300/2006 for the
 * site and HG 1146/2006 for the equipment: the scaffold is erected, altered and struck under a
 * competent person, and it is inspected before first use and again after any weather that could
 * have moved it. None of that is a formality — the two ways a house scaffold hurts somebody are
 * a deck that was never tied to the wall and a guardrail that was taken off to pass material up
 * and not put back.
 *
 * Sizes and weights below are trade figures — the common denominator of what the yards stock —
 * and are close enough to plan a lorry and a slab load with. Check them against the kit that
 * actually turns up before anything is set out to them.
 */

import type { ScaffoldSettings, ScaffoldSystemId } from '../types.ts'

/**
 * How a house gets scaffolded when nobody has said otherwise.
 *
 * The yard scaffold, a metre of deck, class 3, netted, two months on hire — which is what a
 * render or an insulation job on a P+1 actually books, and every one of them is a decision the
 * scaffold view lets you take back.
 */
export const DEFAULT_SCAFFOLD: ScaffoldSettings = {
  system: 'italian',
  deckWidth: 1000,
  loadClass: 3,
  wallGap: 300,
  roofRise: 500,
  months: 2,
  ratePerM2Month: null,
  deckEveryLift: true,
  netting: true,
}

/**
 * One lift, mm.
 *
 * Both systems stack in two-metre frames, so every deck level in the country is at a multiple
 * of 2,00 m off the base plate. It is the single number that decides how many levels a wall
 * needs, and it is not adjustable — a frame is welded.
 */
export const LIFT_MM = 2000

/**
 * How far up somebody works from the deck they stand on, mm.
 *
 * Comfortable overhead work is about two metres: at the wall, arms up, a trowel or a fixing gun
 * in hand. It is what decides where the top deck goes — high enough to reach the eaves, low
 * enough that the work is not being done off the guardrail.
 */
export const REACH_ABOVE_DECK_MM = 2000

/**
 * Guardrail height above the deck, mm — SR EN 12811-1 §5.5.
 *
 * The standard asks for the top of the principal rail at 1,00 m, an intermediate rail so no gap
 * exceeds 470 mm, and a toe board. All three, every deck, every open side: two rails and a board
 * is one guarded edge, not three optional extras.
 */
export const GUARDRAIL_MM = 1000
export const TOEBOARD_MM = 150

/**
 * Largest gap between the deck edge and the wall, mm — SR EN 12811-1 §6.2.6.5.
 *
 * Wider than this and the deck needs an inside guardrail as well, because the gap is now a hole
 * somebody can go through. 300 is also about the smallest gap that still lets a rendered wall
 * be finished behind the standards.
 */
export const MAX_WALL_GAP_MM = 300

/**
 * Tie pattern, mm — every 4 m up the scaffold and every 8 m along it.
 *
 * This is the manufacturers' default grid for a façade scaffold with an unclad outer face, and
 * it is where the numbers below come from. A scaffold sheeted in netting or, worse, in tarpaulin
 * catches wind like a sail and wants ties at twice that density — which is why the netting is
 * priced here as a decision rather than thrown in.
 *
 * Ties are the part that gets left out. A frame scaffold standing free is a ladder leaning on
 * nothing: it is the wall that holds it up, not the diagonals.
 */
export const TIE_VERTICAL_MM = 4000
export const TIE_HORIZONTAL_MM = 8000

/** Above this the scaffold stops being a standard configuration and needs a design, mm. */
export const DESIGN_REQUIRED_ABOVE_MM = 24_000

/** Below this a façade scaffold is still stood free; above it, it is tied to the wall, mm. */
export const TIE_FROM_MM = 4000

/** Adjustment in the base jacks, mm — what the ground is allowed to fall across a run. */
export const BASE_JACK_MM = 600

/** One access tower — a deck with a trapdoor and a ladder — every this many metres of run. */
export const ACCESS_EVERY_MM = 30_000

/** Protective netting is sold in rolls this big, m². */
export const NET_ROLL_M2 = 150

/**
 * What a van takes, kg.
 *
 * A house scaffold is hired with delivery, and the delivery is priced per load. 3,5 t on the
 * plate is about 1,7 t of payload once the vehicle and two fitters are in it, and scaffold is
 * dense — a load is decided by weight long before it is decided by volume.
 */
export const VAN_PAYLOAD_KG = 1700

/**
 * Load classes, SR EN 12811-1 Table 3.
 *
 * The class is what the deck may carry, and it is the number that decides whether the pallet of
 * adhesive can go up with the man. Class 3 is the ordinary façade class and is what a yard means
 * when it says nothing at all.
 */
export interface ScaffoldLoadClass {
  /** Uniformly distributed load on the deck, kN/m². */
  kNm2: number
  /** The same figure in the units the site thinks in. */
  kgM2: number
  work: string
  workRo: string
}

export const LOAD_CLASSES: Record<2 | 3 | 4, ScaffoldLoadClass> = {
  2: {
    kNm2: 1.5,
    kgM2: 150,
    work: 'Inspection, painting, rendering — no material stored on the deck',
    workRo: 'Inspecție, zugrăveli, tencuieli — fără depozitare pe podină',
  },
  3: {
    kNm2: 2.0,
    kgM2: 200,
    work: 'Rendering, external insulation, pointing — light material on the deck',
    workRo: 'Tencuieli, termosistem, rostuiri — material mărunt pe podină',
  },
  4: {
    kNm2: 3.0,
    kgM2: 300,
    work: 'Masonry and cladding — units stacked on the deck',
    workRo: 'Zidărie și placaje — material stivuit pe podină',
  },
}

/** Per-piece weights, kg. Anything measured by the bay is given per metre of bay. */
export interface ScaffoldMasses {
  /** One frame, whatever its width — a 2 m frame is a 2 m frame. */
  frame: number
  /** Deck, per metre of bay, for one board of `plankWidth`. */
  deckPerM: number
  diagonalPerM: number
  ledgerPerM: number
  guardrailPerM: number
  toeboardPerM: number
  baseJack: number
  tie: number
}

export interface ScaffoldSystem {
  id: ScaffoldSystemId
  name: string
  nameRo: string
  /** What it is, in one line, and what hiring it means. */
  why: string
  /** Bay lengths the kit is made in, mm, ascending. */
  bays: number[]
  /** Deck depths the kit is made in, mm. */
  widths: number[]
  /** Width of one board of decking, mm — several make up the deck's depth. */
  plankWidth: number
  /**
   * Bays between braced bays. The Italian kit braces every bay because the brace *is* the
   * bay — it is what sets the 2,00 m. A system scaffold braces every fifth, which is what
   * SR EN 12810 assembles them to.
   */
  bracedEvery: number
  /** How tall it is put up on a house without a specific design, mm. */
  maxHeight: number
  masses: ScaffoldMasses
}

export const SCAFFOLD_SYSTEMS: Record<ScaffoldSystemId, ScaffoldSystem> = {
  italian: {
    id: 'italian',
    name: 'Frame scaffold, Italian type',
    nameRo: 'Schelă tip italian (cadre și diagonale)',
    why: 'The yard scaffold: a welded 2,00 × 1,00 m frame, a 2,00 m bay set by the cross braces, decks laid on the frame. One bay length, nothing to think about, and it is what stands outside most houses in the country being rendered.',
    bays: [2000],
    widths: [1000],
    // Wooden decks are the common ones and they are a shade over 300 wide; three of them make
    // up the metre of depth, which is exactly what the frame is built to take.
    plankWidth: 320,
    bracedEvery: 1,
    maxHeight: 20_000,
    masses: {
      frame: 15,
      deckPerM: 7,
      diagonalPerM: 2,
      ledgerPerM: 2.4,
      guardrailPerM: 2.4,
      toeboardPerM: 2.6,
      baseJack: 3.5,
      tie: 2.2,
    },
  },
  'facade-frame': {
    id: 'facade-frame',
    name: 'System façade scaffold, SR EN 12810',
    nameRo: 'Schelă de fațadă cu cadre (tip Layher / Plettac)',
    why: 'The system kit, certified as a whole rather than as a pile of tube: bays from 0,73 to 3,07 m, decks that hook and lock, guardrails that clip. It costs more per square metre and it needs a third fewer frames on a long wall, because the bays are half as long again.',
    bays: [730, 1090, 1570, 2070, 2570, 3070],
    // W06 and W09, the two width classes SR EN 12810 sells a façade scaffold in.
    widths: [730, 1090],
    plankWidth: 320,
    bracedEvery: 5,
    maxHeight: 24_000,
    masses: {
      frame: 18,
      deckPerM: 6.5,
      diagonalPerM: 2,
      ledgerPerM: 2.4,
      guardrailPerM: 2.4,
      toeboardPerM: 2.6,
      baseJack: 4,
      tie: 2.2,
    },
  },
}

export const SCAFFOLD_SYSTEM_IDS: ScaffoldSystemId[] = ['italian', 'facade-frame']

export const scaffoldSystem = (id: ScaffoldSystemId): ScaffoldSystem =>
  SCAFFOLD_SYSTEMS[id] ?? SCAFFOLD_SYSTEMS.italian

/**
 * How far a run may fall short of what was asked of it before another bay is added, mm.
 *
 * The length asked for is the wall plus an allowance for turning the corner, and the allowance
 * is an allowance. Adding a whole 2,00 m bay — six more frames on a three-lift run — to cover
 * the last hand's width of it is how a scaffold ends up a quarter bigger than the house.
 */
export const BAY_TOLERANCE_MM = 300

/**
 * Split a length of scaffold line into the bays the kit is made in.
 *
 * Longest first, because every joint is a frame and a frame is the expensive piece. A tail
 * longer than the tolerance still gets a bay of its own — a scaffold cannot stop half a bay
 * short of the corner, it runs past it. What it ends up over or under by is returned rather
 * than hidden: it is the number that says whether the run fits between the house and the fence.
 */
export function packBays(lengthMm: number, ladder: number[]): { bays: number[]; overrunMm: number } {
  const sizes = [...ladder].sort((a, b) => b - a)
  const smallest = sizes[sizes.length - 1]
  const bays: number[] = []
  let left = Math.max(0, lengthMm)

  while (left >= smallest) {
    const bay = sizes.find((size) => size <= left) ?? smallest
    bays.push(bay)
    left -= bay
  }
  // The tail. One more bay covers it, and hangs past the end by the difference.
  if (left > BAY_TOLERANCE_MM) {
    const bay = [...sizes].reverse().find((size) => size >= left) ?? smallest
    bays.push(bay)
    left -= bay
  }
  if (bays.length === 0) bays.push(smallest)

  const total = bays.reduce((sum, bay) => sum + bay, 0)
  return { bays, overrunMm: total - Math.max(0, lengthMm) }
}

/**
 * How many lifts a wall of this height needs.
 *
 * The top deck has to be within arm's reach of the top of the work and must not be above it —
 * you cannot render a wall you are standing level with, and you cannot render one two and a
 * half metres over your head either. Everything below the top deck follows from the frame
 * height, because the frames are welded and the decks land where they land.
 */
export const liftsFor = (workHeightMm: number): number =>
  Math.max(1, Math.ceil((workHeightMm - REACH_ABOVE_DECK_MM) / LIFT_MM))

/** Ties on one run: the 4 m × 8 m grid, with the top lift always tied. */
export function tiesFor(runLengthMm: number, deckHeightMm: number): number {
  const rows = Math.max(1, Math.round(deckHeightMm / TIE_VERTICAL_MM))
  const perRow = Math.floor(runLengthMm / TIE_HORIZONTAL_MM) + 1
  return rows * perRow
}
