/**
 * The façade scaffold — what has to stand round the house, and what that is to hire.
 *
 * Everything else in this app is inside the building. This is the one thing that goes round the
 * outside of it, and it is designed the way the plant room is: from a finished model rather
 * than from inside the solver, because it needs the whole envelope — every storey's footprint,
 * which of them stand over which, and how far above the last slab the work goes.
 *
 * The hard part is not the arithmetic, it is working out **what the façades actually are**. A
 * plan is a pile of rooms; a façade is the outside of their union, which is a different shape
 * and one nobody has drawn. So the outer face of every room is taken, the parts of it that have
 * another room on the far side are cut away, and what survives is grouped onto the straight
 * lines it lies on. Those lines are the façades — and because they are found rather than
 * assumed, a house with a set-back upper storey comes out as what it is: some runs standing on
 * the ground and going all the way up, and some standing on the terrace roof of the storey
 * below, which is exactly how such a house gets scaffolded and exactly the bit that gets
 * forgotten when somebody prices it off the perimeter.
 *
 * From there it is a kit-of-parts problem. A wall is continuous and a scaffold is not: it comes
 * in 2,00 m frames and whichever bays the yard's system is made in, so the length of the wall
 * has to be turned into a count of bays, the height into a count of lifts, and the two into
 * frames, decks, braces, guardrails and ties. `standards/scaffold.ts` holds the kit and the
 * rules; this module holds the geometry and the schedule that comes off it.
 *
 * Pure, like everything under `domain/`: it reads a project and returns a description. It
 * places nothing, mutates nothing and consults no clock.
 */

import { edgesOf, pointInPolygon } from './geometry/polygon.ts'
import { add2, dist2, dot2, norm2, perp2, scale2, sub2, type Vec2 } from './geometry/vec.ts'
import { outerOutline, roomsOnLevel, sortedLevels } from './model.ts'
import {
  ACCESS_EVERY_MM,
  BASE_JACK_MM,
  DEFAULT_SCAFFOLD,
  DESIGN_REQUIRED_ABOVE_MM,
  GUARDRAIL_MM,
  LIFT_MM,
  LOAD_CLASSES,
  MAX_WALL_GAP_MM,
  NET_ROLL_M2,
  TIE_FROM_MM,
  TIE_HORIZONTAL_MM,
  TIE_VERTICAL_MM,
  TOEBOARD_MM,
  VAN_PAYLOAD_KG,
  liftsFor,
  packBays,
  scaffoldSystem,
  tiesFor,
  type ScaffoldLoadClass,
  type ScaffoldSystem,
} from './standards/scaffold.ts'
import type { Level, Project, ScaffoldSettings } from './types.ts'

/**
 * What the scaffold is drawn in, shared by the plan and the elevations so the two read as one
 * drawing — the same argument `SYSTEM_COLOR` makes, with a different answer. A scaffold is not
 * one of the five services and should not borrow one of their colours: it is galvanised steel
 * standing outside the building, and it is drawn as such.
 */
export const SCAFFOLD_COLOR = '#9fb3c8'

/* ---------------------------------------------------------------------- types */

/** Where a run's feet are. */
export type ScaffoldFooting = 'ground' | 'roof'

/** One straight length of scaffold against one straight length of façade. */
export interface ScaffoldRun {
  id: string
  /** A, B, C… — the letter on the plan and the title of the elevation. */
  mark: string
  /** Which way the façade faces, as a compass point. */
  face: string
  faceRo: string
  /** The wall line: the outer face of the building in plan. */
  a: Vec2
  b: Vec2
  /** Unit vector out of the building, perpendicular to a→b. */
  normal: Vec2
  /** Façade this run covers, mm. */
  facadeLengthMm: number
  /** Extra taken round an external corner at one end, mm. */
  returnMm: number
  /** What has to be covered: the façade plus the return. */
  lengthMm: number
  /** The bays it is made of, in order along the run. */
  bays: number[]
  /** What those bays come to — the scaffold that actually gets erected and hired, mm. */
  builtLengthMm: number
  /** How far that lands over what was asked of it, mm. Negative where it falls a little short. */
  overrunMm: number
  lifts: number
  /** Ends that stop in the open rather than turning a corner — they need guarding too. */
  openEnds: number
  /** Where the feet stand above the site datum, mm, and what they stand on. */
  baseMm: number
  standsOn: ScaffoldFooting
  /** The storey whose façade this is, and the top of the work on it, mm above the datum. */
  topLevelName: string
  workTopMm: number
  /** Top deck, and the top of the guardrail over it — both above this run's own base, mm. */
  deckHeightMm: number
  standingHeightMm: number
  /** How far under the top of the work the top deck lands, mm. */
  reachMm: number
  /** Façade area this run is billed as, m². */
  areaM2: number
  ties: number
}

export type ScaffoldStage = 'base' | 'structure' | 'decking' | 'guarding' | 'ties' | 'access' | 'extras'

export interface ScaffoldItem {
  id: string
  stage: ScaffoldStage
  /** What it is called on a drawing. */
  name: string
  /** What it is called on a Romanian hire list, which is where it gets ordered. */
  nameRo: string
  /** Its size — the line that makes it an order rather than a wish. */
  size: string
  /** Why it is on the list at all. */
  why: string
  quantity: number
  unit: 'pc' | 'm²'
  /** What the line weighs, kg — the lorry is loaded by weight, not by piece. */
  massKg: number
}

export interface ScaffoldCheck {
  id: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface ScaffoldRental {
  months: number
  /** Façade area the hire is priced on, m². */
  areaM2: number
  /** The same area as the 2,00 × 2,00 m modules a yard with a fixed bay quotes in. */
  modules: number
  massKg: number
  /** Van loads at 1,7 t of payload. */
  loads: number
  ratePerM2Month: number | null
  /** Hire only, lei — erection, striking, transport and the netting are quoted separately. */
  hireCost: number | null
}

export interface ScaffoldDesign {
  settings: ScaffoldSettings
  system: ScaffoldSystem
  loadClass: ScaffoldLoadClass
  runs: ScaffoldRun[]
  /** External corners the scaffold turns. */
  corners: number
  /** The storeys, for the elevations to draw their floor lines against. */
  storeys: { id: string; name: string; floorMm: number; ceilingMm: number }[]
  totals: {
    /** Façade covered, mm, and the scaffold line that covers it. */
    facadeLengthMm: number
    lineLengthMm: number
    areaM2: number
    /** Deck area actually laid, m² — what somebody stands on. */
    deckAreaM2: number
    bays: number
    /** Tallest run, measured from its own base, mm. */
    maxHeightMm: number
    /** Highest guardrail above the site datum, mm. */
    topOfScaffoldMm: number
    frames: number
    ties: number
    massKg: number
    /** Runs that stand on a roof rather than on the ground. */
    roofRuns: number
  }
  items: ScaffoldItem[]
  checks: ScaffoldCheck[]
  rental: ScaffoldRental
}

/* ------------------------------------------------------------------- settings */

/**
 * The scaffold settings, with the deck snapped to a width the chosen kit is made in.
 *
 * A file may carry a metre of deck and then be switched to the system scaffold, which is not
 * made in a metre — it is made in 0,73 and 1,09. Resolving here rather than at every reader
 * means there is one definition of what the deck is, and nothing downstream can quietly order a
 * width nobody stocks.
 */
export function scaffoldSettingsOf(project: Project): ScaffoldSettings {
  const stored = { ...DEFAULT_SCAFFOLD, ...(project.settings.scaffold ?? {}) }
  const system = scaffoldSystem(stored.system)
  const deckWidth = nearest(stored.deckWidth, system.widths)
  return { ...stored, deckWidth }
}

const nearest = (value: number, options: number[]): number =>
  options.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best,
  )

/* --------------------------------------------------------------------- design */

export function designScaffold(project: Project): ScaffoldDesign {
  const settings = scaffoldSettingsOf(project)
  const system = scaffoldSystem(settings.system)
  const loadClass = LOAD_CLASSES[settings.loadClass] ?? LOAD_CLASSES[3]

  let counter = 0
  const nextId = (): string => `scaffold-${++counter}`

  const levels = sortedLevels(project)
  const storeys = levels.map((level) => ({
    id: level.id,
    name: level.name,
    floorMm: level.elevation,
    ceilingMm: level.elevation + level.height,
  }))

  const { runs, corners } = layOut(project, levels, settings, system, nextId)

  const totals = tally(runs, settings, system)
  const items = schedule(runs, corners, settings, system, loadClass, nextId)
  const massKg = items.reduce((sum, item) => sum + item.massKg, 0)

  const rental: ScaffoldRental = {
    months: settings.months,
    areaM2: totals.areaM2,
    // A yard with one bay length prices in modules of a bay by a lift, and a 2,00 m bay by a
    // 2,00 m lift is the four square metres everybody in the trade means by "un modul".
    modules: Math.ceil(totals.areaM2 / 4),
    massKg,
    loads: Math.max(1, Math.ceil(massKg / VAN_PAYLOAD_KG)),
    ratePerM2Month: settings.ratePerM2Month,
    hireCost:
      settings.ratePerM2Month === null
        ? null
        : totals.areaM2 * settings.ratePerM2Month * settings.months,
  }

  const design: ScaffoldDesign = {
    settings,
    system,
    loadClass,
    runs,
    corners,
    storeys,
    totals: { ...totals, massKg },
    items,
    checks: [],
    rental,
  }
  design.checks = audit(project, design, nextId)
  return design
}

/* ------------------------------------------------------------------- geometry */

/** A length of one storey's outside face, before anything is known about what is under it. */
interface FacadePiece {
  levelIndex: number
  /** Coordinates along the supporting line. */
  s0: number
  s1: number
}

/** Everything found on one straight line, from every storey. */
interface FacadeLine {
  /** Unit direction of the line, and the unit normal pointing out of the building. */
  dir: Vec2
  normal: Vec2
  /** Signed offset of the line from the origin, along `normal`. */
  offset: number
  pieces: FacadePiece[]
}

/** Below this a length of outside face is a nib rather than a façade, mm. */
const MIN_FACADE_MM = 400

/** How far out of the wall to step when asking whether there is another room on the far side. */
const PROBE_MM = 60

/** Two run ends this close to each other are the same external corner, mm. */
const CORNER_TOL_MM = 900

function layOut(
  project: Project,
  levels: Level[],
  settings: ScaffoldSettings,
  system: ScaffoldSystem,
  nextId: () => string,
): { runs: ScaffoldRun[]; corners: number } {
  const envelopes = new Map<string, Vec2[][]>()
  for (const level of levels) {
    envelopes.set(level.id, roomsOnLevel(project, level.id).map(outerOutline))
  }

  const lines = facadeLines(levels, envelopes)
  const runs: ScaffoldRun[] = []

  for (const line of lines) {
    for (const span of elementary(line.pieces)) {
      const lengthMm = span.s1 - span.s0
      if (lengthMm < MIN_FACADE_MM) continue

      const topLevel = levels[span.topLevelIndex]
      const a = pointOn(line, span.s0)
      const b = pointOn(line, span.s1)
      const middle = pointOn(line, (span.s0 + span.s1) / 2)

      // What the feet stand on. The storey that owns the façade may not be the storey that
      // reaches the ground under it: an upper floor set back from the one below is scaffolded
      // off the terrace roof it sits on, not off the garden four metres further out.
      const footing = footingFor(
        levels,
        envelopes,
        span,
        add2(middle, scale2(line.normal, settings.wallGap + settings.deckWidth / 2)),
      )

      const workTopMm =
        topLevel.elevation + topLevel.height + topLevel.slabThickness + settings.roofRise
      const heightMm = Math.max(LIFT_MM, workTopMm - footing.baseMm)
      const lifts = liftsFor(heightMm)
      const deckHeightMm = lifts * LIFT_MM

      runs.push({
        id: nextId(),
        mark: '',
        face: bearing(line.normal).name,
        faceRo: bearing(line.normal).nameRo,
        a,
        b,
        normal: line.normal,
        facadeLengthMm: lengthMm,
        returnMm: 0,
        lengthMm,
        bays: [],
        builtLengthMm: lengthMm,
        overrunMm: 0,
        lifts,
        openEnds: 2,
        baseMm: footing.baseMm,
        standsOn: footing.standsOn,
        topLevelName: topLevel.name,
        workTopMm,
        deckHeightMm,
        standingHeightMm: deckHeightMm + GUARDRAIL_MM,
        reachMm: workTopMm - footing.baseMm - deckHeightMm,
        areaM2: 0,
        ties: 0,
      })
    }
  }

  // Walk the compass from north, so the marks go round the house the way somebody walking round
  // it would meet them rather than in whatever order the rooms happen to be stored.
  runs.sort(
    (x, y) =>
      compass(x.normal) - compass(y.normal) ||
      x.baseMm - y.baseMm ||
      x.a.x - y.a.x ||
      x.a.y - y.a.y,
  )

  const corners = turnCorners(runs, settings)

  runs.forEach((run, index) => {
    run.mark = mark(index)
    const packed = packBays(run.lengthMm, system.bays)
    run.bays = packed.bays
    run.overrunMm = packed.overrunMm
    // Everything downstream is measured on what gets erected rather than on what was asked
    // for: the bays are what stands there, and the bays are what the hire is measured on.
    run.builtLengthMm = packed.bays.reduce((sum, bay) => sum + bay, 0)
    run.areaM2 = (run.builtLengthMm / 1000) * (run.standingHeightMm / 1000)
    run.ties = tiesFor(run.builtLengthMm, run.deckHeightMm) * (settings.netting ? 2 : 1)
  })

  return { runs, corners }
}

/** Every straight line the building's outside face lies on, with what each storey puts on it. */
function facadeLines(levels: Level[], envelopes: Map<string, Vec2[][]>): FacadeLine[] {
  const lines = new Map<string, FacadeLine>()

  levels.forEach((level, levelIndex) => {
    const polygons = envelopes.get(level.id) ?? []
    polygons.forEach((polygon, index) => {
      for (const edge of edgesOf(polygon)) {
        if (edge.length < MIN_FACADE_MM) continue

        // Step just outside the wall and ask which parts of it have another room behind them.
        // What is left is outside face: the boundary of the union, without ever having to
        // build the union.
        const offset = scale2(edge.normal, PROBE_MM)
        const from = add2(edge.a, offset)
        const to = add2(edge.b, offset)
        let open: Span[] = [{ t0: 0, t1: 1 }]
        for (let other = 0; other < polygons.length && open.length > 0; other++) {
          if (other === index) continue
          open = subtract(open, inside(from, to, polygons[other]))
        }
        if (open.length === 0) continue

        const dir = flip(edge.dir) ? scale2(edge.dir, -1) : edge.dir
        const normal = perp2(dir)
        const sign = dot2(normal, edge.normal) >= 0 ? 1 : -1
        const outward = scale2(normal, sign)
        const along = dot2(dir, edge.a)
        const key = `${round(dir.x)},${round(dir.y)},${Math.round(dot2(normal, edge.a))},${sign}`

        let line = lines.get(key)
        if (!line) {
          line = {
            dir,
            normal: outward,
            offset: Math.round(dot2(normal, edge.a)) * sign,
            pieces: [],
          }
          lines.set(key, line)
        }

        for (const span of open) {
          // Params along the *edge*, which runs a→b; the line's own coordinate is along `dir`,
          // which may be the other way round.
          const s = [along + span.t0 * edge.length * side(edge.dir, dir),
                     along + span.t1 * edge.length * side(edge.dir, dir)].sort((p, q) => p - q)
          if (s[1] - s[0] >= MIN_FACADE_MM) {
            line.pieces.push({ levelIndex, s0: s[0], s1: s[1] })
          }
        }
      }
    })
  })

  // Sorted so the whole thing is order-independent: two projects with the same geometry produce
  // the same runs whatever order their rooms were drawn in.
  return [...lines.values()].sort(
    (x, y) => compass(x.normal) - compass(y.normal) || x.offset - y.offset,
  )
}

/** A point on the line at coordinate `s` along it. */
const pointOn = (line: FacadeLine, s: number): Vec2 =>
  add2(scale2(line.dir, s), scale2(line.normal, line.offset))

const side = (edgeDir: Vec2, lineDir: Vec2): number => (dot2(edgeDir, lineDir) >= 0 ? 1 : -1)

/** Canonical direction for a line: east-ish, or north when it runs exactly north–south. */
const flip = (dir: Vec2): boolean => dir.x < -1e-9 || (Math.abs(dir.x) <= 1e-9 && dir.y < 0)

const round = (value: number): number => Math.round(value * 1e6) / 1e6

interface Elementary {
  s0: number
  s1: number
  topLevelIndex: number
  levelIndexes: number[]
}

/**
 * Cut the pieces on one line into the intervals over which the answer does not change.
 *
 * Two storeys on one line rarely start and stop together — an upper floor runs past the porch
 * below it, a ground floor runs past the end of the upper one — and each of those overlaps is a
 * different scaffold height. Splitting at every start and stop and taking the highest storey
 * over each piece is what gives a run that steps down at the right place.
 */
function elementary(pieces: FacadePiece[]): Elementary[] {
  if (pieces.length === 0) return []
  const cuts = [...new Set(pieces.flatMap((piece) => [piece.s0, piece.s1]))].sort((a, b) => a - b)

  const out: Elementary[] = []
  for (let i = 1; i < cuts.length; i++) {
    const s0 = cuts[i - 1]
    const s1 = cuts[i]
    const middle = (s0 + s1) / 2
    const covering = pieces.filter((piece) => piece.s0 <= middle && piece.s1 >= middle)
    if (covering.length === 0) continue
    const levelIndexes = [...new Set(covering.map((piece) => piece.levelIndex))].sort(
      (a, b) => a - b,
    )
    const topLevelIndex = levelIndexes[levelIndexes.length - 1]

    // Merge straight back into the previous interval when nothing about it changed — the cut
    // was somewhere else on the line and this run has no reason to stop here. It has to be the
    // same *set* of storeys, not merely the same top one: a length of wall the ground floor
    // stands under and a length it does not are the same height and a different scaffold.
    const previous = out[out.length - 1]
    if (
      previous &&
      previous.s1 === s0 &&
      previous.levelIndexes.join() === levelIndexes.join()
    ) {
      previous.s1 = s1
      continue
    }
    out.push({ s0, s1, topLevelIndex, levelIndexes })
  }
  return out
}

/** What this length of façade is scaffolded off. */
function footingFor(
  levels: Level[],
  envelopes: Map<string, Vec2[][]>,
  span: Elementary,
  deckPoint: Vec2,
): { baseMm: number; standsOn: ScaffoldFooting } {
  // The ground floor's own façade is on this line, so the scaffold stands in the garden.
  if (span.levelIndexes.includes(0)) return { baseMm: 0, standsOn: 'ground' }

  // Otherwise the highest storey below whose roof reaches out under the deck.
  for (let index = span.topLevelIndex - 1; index >= 0; index--) {
    const level = levels[index]
    const polygons = envelopes.get(level.id) ?? []
    if (polygons.some((polygon) => pointInPolygon(deckPoint, polygon))) {
      return {
        baseMm: level.elevation + level.height + level.slabThickness,
        standsOn: 'roof',
      }
    }
  }
  // Nothing under it: the storey oversails, and the scaffold comes up past it from the ground.
  return { baseMm: 0, standsOn: 'ground' }
}

/**
 * Find the external corners and charge each of them to one run.
 *
 * A scaffold turns a corner by running one side past the end of the other, so the corner costs
 * the depth of the scaffold plus its gap from the wall — once, not twice. Giving the return to
 * the first run of each pair keeps the total honest: the sum of the runs is the perimeter plus
 * one return per corner, which is what gets erected.
 */
function turnCorners(runs: ScaffoldRun[], settings: ScaffoldSettings): number {
  const returnMm = settings.deckWidth + settings.wallGap
  let corners = 0

  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const one = runs[i]
      const two = runs[j]
      // Parallel runs meeting end to end are one wall with a step in it, not a corner.
      if (Math.abs(dot2(one.normal, two.normal)) > 0.9) continue
      // Two runs only turn into each other where they exist at the same height. A run standing
      // on a terrace roof and one standing in the garden below it share a corner of the house
      // and no scaffold at all unless they overlap by a lift or more.
      const overlap =
        Math.min(one.baseMm + one.standingHeightMm, two.baseMm + two.standingHeightMm) -
        Math.max(one.baseMm, two.baseMm)
      if (overlap < LIFT_MM) continue

      const meets = [one.a, one.b].some((end) =>
        [two.a, two.b].some((other) => dist2(end, other) <= CORNER_TOL_MM),
      )
      if (!meets) continue

      corners++
      // The return goes on whichever of the two is carrying less of it already, so a corner is
      // paid for exactly once and no single run ends up carrying every corner in the house.
      const carries = one.returnMm <= two.returnMm ? one : two
      carries.returnMm += returnMm
      carries.lengthMm = carries.facadeLengthMm + carries.returnMm
      one.openEnds = Math.max(0, one.openEnds - 1)
      two.openEnds = Math.max(0, two.openEnds - 1)
    }
  }
  return corners
}

/* ------------------------------------------------------------------ intervals */

interface Span {
  t0: number
  t1: number
}

/** The parts of segment from→to that lie inside the polygon, as parameters along it. */
function inside(from: Vec2, to: Vec2, polygon: Vec2[]): Span[] {
  const dir = sub2(to, from)
  const cuts = [0, 1]
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]
    const q = polygon[(i + 1) % polygon.length]
    const t = crossing(from, dir, p, q)
    if (t !== null) cuts.push(t)
  }
  cuts.sort((a, b) => a - b)

  const spans: Span[] = []
  for (let i = 1; i < cuts.length; i++) {
    const t0 = cuts[i - 1]
    const t1 = cuts[i]
    if (t1 - t0 < 1e-9) continue
    if (!pointInPolygon(add2(from, scale2(dir, (t0 + t1) / 2)), polygon)) continue
    const previous = spans[spans.length - 1]
    if (previous && Math.abs(previous.t1 - t0) < 1e-9) previous.t1 = t1
    else spans.push({ t0, t1 })
  }
  return spans
}

/** Parameter along a→a+dir where it crosses the segment p–q, or null. */
function crossing(a: Vec2, dir: Vec2, p: Vec2, q: Vec2): number | null {
  const edge = sub2(q, p)
  const denom = dir.x * edge.y - dir.y * edge.x
  if (Math.abs(denom) < 1e-12) return null
  const delta = sub2(p, a)
  const t = (delta.x * edge.y - delta.y * edge.x) / denom
  const u = (delta.x * dir.y - delta.y * dir.x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return t
}

/** `spans` with `cuts` taken out of them. */
function subtract(spans: Span[], cuts: Span[]): Span[] {
  if (cuts.length === 0) return spans
  let out = spans
  for (const cut of cuts) {
    const next: Span[] = []
    for (const span of out) {
      if (cut.t1 <= span.t0 + 1e-9 || cut.t0 >= span.t1 - 1e-9) {
        next.push(span)
        continue
      }
      if (cut.t0 > span.t0 + 1e-9) next.push({ t0: span.t0, t1: cut.t0 })
      if (cut.t1 < span.t1 - 1e-9) next.push({ t0: cut.t1, t1: span.t1 })
    }
    out = next
  }
  return out
}

/* ------------------------------------------------------------------- bearings */

/** Angle of an outward normal, clockwise from north — the order you walk round a house in. */
const compass = (normal: Vec2): number => {
  const angle = Math.atan2(normal.x, normal.y)
  return angle < 0 ? angle + Math.PI * 2 : angle
}

const POINTS = [
  { name: 'North', nameRo: 'Nord' },
  { name: 'North-east', nameRo: 'Nord-Est' },
  { name: 'East', nameRo: 'Est' },
  { name: 'South-east', nameRo: 'Sud-Est' },
  { name: 'South', nameRo: 'Sud' },
  { name: 'South-west', nameRo: 'Sud-Vest' },
  { name: 'West', nameRo: 'Vest' },
  { name: 'North-west', nameRo: 'Nord-Vest' },
]

const bearing = (normal: Vec2): { name: string; nameRo: string } =>
  POINTS[Math.round((compass(norm2(normal)) / (Math.PI * 2)) * 8) % 8]

/** A, B … Z, then AA, AB — a house never gets there, but the marks stay unique if it does. */
function mark(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26))
  return index < 26 ? letter : `${String.fromCharCode(64 + Math.floor(index / 26))}${letter}`
}

/* --------------------------------------------------------------------- totals */

function tally(
  runs: ScaffoldRun[],
  settings: ScaffoldSettings,
  system: ScaffoldSystem,
): Omit<ScaffoldDesign['totals'], 'massKg'> {
  const boards = boardsAcross(settings, system)
  let facadeLengthMm = 0
  let lineLengthMm = 0
  let areaM2 = 0
  let deckAreaM2 = 0
  let bays = 0
  let frames = 0
  let ties = 0
  let maxHeightMm = 0
  let topOfScaffoldMm = 0
  let roofRuns = 0

  for (const run of runs) {
    facadeLengthMm += run.facadeLengthMm
    lineLengthMm += run.builtLengthMm
    areaM2 += run.areaM2
    bays += run.bays.length
    frames += (run.bays.length + 1) * run.lifts
    ties += run.ties
    deckAreaM2 +=
      (run.builtLengthMm / 1000) * ((boards * system.plankWidth) / 1000) * deckedLifts(run, settings)
    maxHeightMm = Math.max(maxHeightMm, run.standingHeightMm)
    topOfScaffoldMm = Math.max(topOfScaffoldMm, run.baseMm + run.standingHeightMm)
    if (run.standsOn === 'roof') roofRuns++
  }

  return {
    facadeLengthMm,
    lineLengthMm,
    areaM2,
    deckAreaM2,
    bays,
    maxHeightMm,
    topOfScaffoldMm,
    frames,
    ties,
    roofRuns,
  }
}

const boardsAcross = (settings: ScaffoldSettings, system: ScaffoldSystem): number =>
  Math.max(1, Math.round(settings.deckWidth / system.plankWidth))

/**
 * How many lifts of a run are decked.
 *
 * Every one, or the top two moved up as the work rises. Two is the working minimum: you stand
 * on one and you are caught by the other, and a single deck with nothing under it is how a
 * dropped trowel reaches the ground at forty miles an hour.
 */
const deckedLifts = (run: ScaffoldRun, settings: ScaffoldSettings): number =>
  settings.deckEveryLift ? run.lifts : Math.min(run.lifts, 2)

/* ------------------------------------------------------------------ the order */

/** Metres, with the comma a Romanian order is written with. */
const m = (mm: number): string => (mm / 1000).toFixed(2).replace('.', ',')

function schedule(
  runs: ScaffoldRun[],
  corners: number,
  settings: ScaffoldSettings,
  system: ScaffoldSystem,
  loadClass: ScaffoldLoadClass,
  nextId: () => string,
): ScaffoldItem[] {
  const boards = boardsAcross(settings, system)

  let frames = 0
  let jacks = 0
  let groundJacks = 0
  let deckPieces = 0
  let deckMetres = 0
  let bracePieces = 0
  let braceMetres = 0
  let railPieces = 0
  let railMetres = 0
  let toePieces = 0
  let toeMetres = 0
  let ties = 0
  let netM2 = 0
  let maxLifts = 0
  let lineMetres = 0

  for (const run of runs) {
    const bays = run.bays.length
    const decked = deckedLifts(run, settings)
    const bayMetres = run.bays.reduce((sum, bay) => sum + bay, 0) / 1000

    frames += (bays + 1) * run.lifts
    jacks += bays + 1
    if (run.standsOn === 'ground') groundJacks += bays + 1

    deckPieces += boards * bays * decked
    deckMetres += boards * bayMetres * decked

    // Braced bays: every bay on the Italian kit, every fifth on a system scaffold. A brace is
    // the diagonal of a bay by a lift, so it is longer than the bay it braces.
    const braced = Math.max(1, Math.ceil(bays / system.bracedEvery))
    bracePieces += 2 * braced * run.lifts
    braceMetres +=
      (2 * braced * run.lifts * Math.hypot(bayMetres / Math.max(1, bays), LIFT_MM / 1000))

    // Two rails at every deck on the outer face, and the same again across any end that stops
    // in the open. The inside face is guarded too where the gap to the wall is over 300.
    const insideFace = settings.wallGap > MAX_WALL_GAP_MM ? 1 : 0
    railPieces += 2 * bays * run.lifts * (1 + insideFace) + 2 * run.openEnds * run.lifts
    railMetres +=
      2 * bayMetres * run.lifts * (1 + insideFace) +
      (2 * run.openEnds * run.lifts * settings.deckWidth) / 1000

    toePieces += bays * run.lifts + run.openEnds * run.lifts
    toeMetres += bayMetres * run.lifts + (run.openEnds * run.lifts * settings.deckWidth) / 1000

    ties += run.ties
    netM2 += run.areaM2
    maxLifts = Math.max(maxLifts, run.lifts)
    lineMetres += run.builtLengthMm / 1000
  }

  const towers = Math.max(1, Math.ceil((lineMetres * 1000) / ACCESS_EVERY_MM))
  const ladderDecks = towers * maxLifts
  const masses = system.masses

  const items: ScaffoldItem[] = []
  const add = (item: Omit<ScaffoldItem, 'id'>): void => {
    if (item.quantity > 0) items.push({ id: nextId(), ...item })
  }

  add({
    stage: 'base',
    name: 'Adjustable base jacks with base plates',
    nameRo: 'Tălpi reglabile cu placă de bază',
    size: `${BASE_JACK_MM} mm of adjustment, one under every standard`,
    why: 'The ground round a house falls away and a frame scaffold has to start level — every lift above it lands where the frames put it, so a base out of level is out of level all the way to the top.',
    quantity: jacks,
    unit: 'pc',
    massKg: jacks * masses.baseJack,
  })
  add({
    stage: 'base',
    name: 'Sole boards under the jacks',
    nameRo: 'Dulapi de repartiție sub tălpi',
    size: '200 × 50 mm timber, one per standard',
    why: 'A base plate on soil is a spike. The board spreads it, and it is what keeps the scaffold out of the ground after three days of rain — which is also when nobody is watching it.',
    quantity: groundJacks,
    unit: 'pc',
    massKg: groundJacks * 6,
  })

  add({
    stage: 'structure',
    name: system.name,
    nameRo: `Cadre de schelă ${m(LIFT_MM)} × ${m(settings.deckWidth)} m`,
    size: `${m(LIFT_MM)} m high, ${m(settings.deckWidth)} m deep — ${frames} in ${maxLifts} lifts`,
    why: system.why,
    quantity: frames,
    unit: 'pc',
    massKg: frames * masses.frame,
  })
  add({
    stage: 'structure',
    name: 'Cross braces',
    nameRo: 'Diagonale',
    size:
      system.bracedEvery === 1
        ? 'a pair to every bay, every lift'
        : `a pair to every ${system.bracedEvery}th bay, every lift`,
    why:
      system.bracedEvery === 1
        ? 'On this kit the brace is the bay: it is what holds the two frames the 2,00 m apart the decks are cut to, and a bay without its pair is a parallelogram waiting to happen.'
        : 'What stops the scaffold racking along its own length. SR EN 12810 assembles a system scaffold with a braced bay every fifth one — not every fifth one you feel like.',
    quantity: bracePieces,
    unit: 'pc',
    massKg: braceMetres * masses.diagonalPerM,
  })
  add({
    stage: 'structure',
    name: 'Corner returns',
    nameRo: 'Racorduri de colț',
    size: `${m(settings.deckWidth + settings.wallGap)} m past each external corner`,
    why: 'One run passes the end of the other so the deck is continuous round the corner. Without it the two runs stop short of each other and the corner of the house — the part that always needs the most work — is the part nobody can reach.',
    quantity: corners,
    unit: 'pc',
    massKg: 0,
  })

  add({
    stage: 'decking',
    name: 'Decks',
    nameRo: 'Podine',
    size: `${boards} across the ${m(settings.deckWidth)} m depth, ${m(system.plankWidth)} m each`,
    why: settings.deckEveryLift
      ? 'A full deck at every lift. It is more to hire and it is the difference between working the whole wall and rebuilding the scaffold twice.'
      : 'Decks for the top two lifts only, moved up as the work rises. A real saving on the hire, and a working-at-height job every time they move.',
    quantity: deckPieces,
    unit: 'pc',
    massKg: deckMetres * masses.deckPerM,
  })
  add({
    stage: 'access',
    name: 'Trapdoor decks with ladders',
    nameRo: 'Podine cu trapă și scară de acces',
    size: `${towers} access bay${towers === 1 ? '' : 's'}, one deck per lift`,
    why: 'How people get up. Climbing the frames is what happens when there is no ladder bay, and it is the most common way somebody falls off a house scaffold.',
    quantity: ladderDecks,
    unit: 'pc',
    massKg: ladderDecks * (masses.deckPerM * 2 + 6),
  })

  add({
    stage: 'guarding',
    name: 'Guardrails, principal and intermediate',
    nameRo: 'Balustrade (mână curentă și intermediară)',
    size: `top rail at ${GUARDRAIL_MM} mm, no gap over 470 mm`,
    why: 'SR EN 12811-1 wants two rails and a toe board on every open edge of every deck. They are also the first thing taken off to pass material up and the last thing put back, which is why they are counted rather than assumed.',
    quantity: railPieces,
    unit: 'pc',
    massKg: railMetres * masses.guardrailPerM,
  })
  add({
    stage: 'guarding',
    name: 'Toe boards',
    nameRo: 'Borduri de protecție (plinte)',
    size: `${TOEBOARD_MM} mm, every decked bay`,
    why: 'Stops what is on the deck reaching the pavement. A tile kicked off the fourth lift is not a tidiness problem.',
    quantity: toePieces,
    unit: 'pc',
    massKg: toeMetres * masses.toeboardPerM,
  })

  add({
    stage: 'ties',
    name: 'Wall ties with expansion anchors',
    nameRo: 'Ancore de perete cu dibluri metalice',
    size: `${m(TIE_VERTICAL_MM)} m up × ${m(TIE_HORIZONTAL_MM)} m along${settings.netting ? ', doubled for the netting' : ''}`,
    why: settings.netting
      ? 'The wall is what holds the scaffold up. Netting turns the outer face into a sail, so the grid is doubled — a netted scaffold on the tie pattern of a bare one is the one that ends up in the garden after a storm.'
      : 'The wall is what holds the scaffold up: braces stop it racking, ties stop it falling away from the house. This is the item that gets left out, and it is the one that matters.',
    quantity: ties,
    unit: 'pc',
    massKg: ties * masses.tie,
  })

  add({
    stage: 'extras',
    name: 'Protective netting',
    nameRo: 'Plasă de protecție',
    size: `${Math.ceil(netM2)} m² — ${Math.ceil(netM2 / NET_ROLL_M2)} roll${Math.ceil(netM2 / NET_ROLL_M2) === 1 ? '' : 's'} of ${NET_ROLL_M2} m²`,
    why: 'Keeps dust and dropped material on the site rather than on the neighbour, and keeps the render off the cars. It is also why the ties above are doubled.',
    quantity: settings.netting ? Math.ceil(netM2) : 0,
    unit: 'm²',
    massKg: settings.netting ? netM2 * 0.1 : 0,
  })
  add({
    stage: 'extras',
    name: 'Load class notice and inspection tag',
    nameRo: 'Placă de identificare și fișă de control (scafftag)',
    size: `Class ${settings.loadClass} — ${loadClass.kNm2.toFixed(1)} kN/m², ${loadClass.kgM2} kg/m²`,
    why: `${loadClass.work}. HG 1146/2006 wants the scaffold checked before first use and again after weather that could have moved it, and the tag is where that is recorded — including the day somebody signs that the guardrails went back on.`,
    quantity: 1,
    unit: 'pc',
    massKg: 0,
  })

  return items
}

/* --------------------------------------------------------------------- checks */

function audit(project: Project, design: ScaffoldDesign, nextId: () => string): ScaffoldCheck[] {
  const checks: ScaffoldCheck[] = []
  const say = (severity: ScaffoldCheck['severity'], message: string): void => {
    checks.push({ id: nextId(), severity, message })
  }

  const { runs, totals, settings, system } = design

  if (project.rooms.length === 0) {
    say('error', 'There is no building yet — draw a room and the façades will be found from it.')
    return checks
  }
  if (runs.length === 0) {
    say(
      'error',
      'No façade could be found. Every wall in the model has another room on the far side of it, which means the plan has no outside.',
    )
    return checks
  }

  say(
    'info',
    `Class ${settings.loadClass}: ${design.loadClass.kgM2} kg on any square metre of deck, and ${design.loadClass.work.toLowerCase()}. A pallet of adhesive lifted onto the deck is over that on its own.`,
  )

  if (totals.topOfScaffoldMm > DESIGN_REQUIRED_ABOVE_MM) {
    say(
      'warning',
      `The scaffold reaches ${m(totals.topOfScaffoldMm)} m, which is past the ${m(DESIGN_REQUIRED_ABOVE_MM)} m a standard configuration covers. Above that it needs a design and a calculation note from the hire company, not just a delivery.`,
    )
  }
  if (totals.maxHeightMm > system.maxHeight) {
    say(
      'warning',
      `The tallest run is ${m(totals.maxHeightMm)} m, above the ${m(system.maxHeight)} m this kit is normally stood to. Ask the yard to confirm it before it is booked.`,
    )
  }

  if (totals.topOfScaffoldMm > TIE_FROM_MM) {
    say(
      'warning',
      `${totals.ties} ties have to be drilled into the façade — the thing being renovated. Agree where they land before the render starts: they come out at the end and the holes are made good, and a tie through a finished coat is a repair somebody has to pay for.`,
    )
  }

  const roof = runs.filter((run) => run.standsOn === 'roof')
  if (roof.length > 0) {
    const marks = roof.map((run) => run.mark).join(', ')
    say(
      'warning',
      `Run${roof.length === 1 ? '' : 's'} ${marks} do not reach the ground: the storey above is set back, so ${roof.length === 1 ? 'it stands' : 'they stand'} on the terrace roof below. The slab has to be checked for the point loads under the base plates, and the waterproofing protected under every one of them — that is a conversation with the structural engineer, not a decision for the day of erection.`,
    )
  }

  // How the lifts landed. Nothing here can be out of range — the count is chosen so it cannot
  // be — but *where* the top deck lands is the number an extra lift gets argued about on site,
  // and it is decided by the roof allowance rather than by anything on the drawing.
  const worst = runs.reduce((a, b) => (b.reachMm > a.reachMm ? b : a))
  say(
    'info',
    `The frames are welded at ${m(LIFT_MM)} m, so a deck can only land at a multiple of it. On run ${worst.mark} that leaves ${m(Math.max(0, worst.reachMm))} m of wall over the top deck — within reach, but if the roof edge turns out to be higher than the ${m(settings.roofRise)} m allowed for it above the last slab, raise that allowance rather than adding a lift on the day.`,
  )

  if (settings.wallGap > MAX_WALL_GAP_MM) {
    say(
      'warning',
      `The deck stands ${settings.wallGap} mm off the wall, over the ${MAX_WALL_GAP_MM} mm SR EN 12811-1 allows. The gap is now a hole, so the inside face needs guarding as well — it has been priced that way.`,
    )
  }

  const overruns = runs.filter((run) => run.overrunMm > 200)
  if (overruns.length > 0) {
    const worst = overruns.reduce((a, b) => (b.overrunMm > a.overrunMm ? b : a))
    say(
      'info',
      `The bays do not divide the walls exactly: run ${worst.mark} ends ${Math.round(worst.overrunMm)} mm past the corner${overruns.length > 1 ? `, and ${overruns.length - 1} other${overruns.length > 2 ? 's' : ''} do the same` : ''}. Check there is room for it against the boundary${settings.system === 'italian' ? ' — a fixed 2,00 m bay has nothing shorter to fall back on' : ''}.`,
    )
  }

  const footprint = settings.wallGap + settings.deckWidth
  say(
    'info',
    `The scaffold takes ${footprint} mm of ground outside every wall it stands against, plus room to work and to stack. On a tight boundary that is the measurement to take before the hire is booked, not after the lorry arrives.`,
  )

  if (!settings.deckEveryLift) {
    say(
      'info',
      'Only the top two lifts are decked, and they move up with the work. It is a genuine saving on the hire and it is a working-at-height job every time — it does not get done by whoever happens to be free.',
    )
  }

  say(
    'info',
    'The scaffold is erected, altered and struck under a competent person (HG 300/2006, HG 1146/2006), and it is checked before first use and after any weather that could have moved it. Anything crossing the line of the scaffold — an overhead service drop above all — is dealt with by the network operator before the first frame goes up, not worked around.',
  )

  return checks
}

/* ------------------------------------------------------------- the enquiry */

/**
 * The hire enquiry, in Romanian, ready to be pasted into a message.
 *
 * A yard quotes off two numbers — square metres of façade and how long you want it — and then
 * argues about everything else. Giving them the runs, the heights and the piece count up front
 * is what turns a quote into a delivery note without three phone calls, and it is what stops
 * the scaffold arriving without the ties.
 */
export function scaffoldRequestText(design: ScaffoldDesign, projectName: string): string {
  const { rental, settings, system, runs, totals } = design
  const lines: string[] = []

  lines.push(`Cerere ofertă — închiriere schelă de fațadă`)
  lines.push(`Lucrare: ${projectName}`)
  lines.push(
    `Sistem: ${system.nameRo}, podină ${m(settings.deckWidth)} m, clasa de încărcare ${settings.loadClass} (${design.loadClass.kNm2.toFixed(1)} kN/m²)`,
  )
  lines.push(`Durata estimată: ${settings.months} luni`)
  lines.push('')
  lines.push(
    `Suprafață de fațadă: ${rental.areaM2.toFixed(0)} m² (${rental.modules} module de ${m(LIFT_MM)} × ${m(LIFT_MM)} m)`,
  )
  lines.push(
    `Desfășurare: ${(totals.lineLengthMm / 1000).toFixed(1)} m de schelă, înălțime maximă ${m(totals.maxHeightMm)} m`,
  )
  lines.push('')
  lines.push('Tronsoane:')
  for (const run of runs) {
    lines.push(
      `  ${run.mark} — ${run.faceRo}: ${m(run.builtLengthMm)} m × ${m(run.standingHeightMm)} m, ` +
        `${run.bays.length} travee × ${run.lifts} niveluri` +
        (run.standsOn === 'roof' ? ` (sprijinită pe terasa de la cota +${m(run.baseMm)} m)` : ''),
    )
  }
  lines.push('')
  lines.push('Necesar estimativ de piese:')
  for (const item of design.items) {
    if (item.quantity <= 0) continue
    lines.push(`  ${item.quantity} ${item.unit === 'm²' ? 'm²' : 'buc'} — ${item.nameRo}`)
  }
  lines.push('')
  lines.push(`Greutate totală estimată: ${Math.round(rental.massKg)} kg (${rental.loads} transport${rental.loads === 1 ? '' : 'uri'})`)
  lines.push(
    'Vă rugăm să includeți în ofertă: transportul dus-întors, montajul și demontajul, ancorarea în fațadă și fișa de control a schelei.',
  )
  return lines.join('\n')
}
