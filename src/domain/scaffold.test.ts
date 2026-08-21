/**
 * Golden cases for the façade scaffold.
 *
 * The part that can be wrong without looking wrong is the geometry: a façade is the outside of
 * the union of the rooms, and getting that even slightly wrong gives a scaffold that is priced
 * round a wall which is actually inside the house, or one that stops short of a corner. So the
 * cases below are built from rooms whose outside face can be worked out on paper — a single
 * room, an L, a storey set back over another — and the assertions are the invariants rather
 * than the coordinates: the runs cover the perimeter exactly once, they reach the top of the
 * work without standing over it, and a storey that does not reach the ground says so.
 */

import { describe, expect, test } from 'vitest'

import { designScaffold, scaffoldRequestText, scaffoldSettingsOf } from './scaffold.ts'
import { createProject, createRoom, createLevel, relevel, sampleProject } from './project.ts'
import {
  BAY_TOLERANCE_MM,
  LIFT_MM,
  REACH_ABOVE_DECK_MM,
  liftsFor,
  packBays,
} from './standards/scaffold.ts'
import type { Project } from './types.ts'

/** One rectangular room on the ground floor, with the wall thickness the defaults give it. */
function oneRoom(width = 6000, depth = 4000): Project {
  const project = createProject('scaffold test')
  project.rooms.push(createRoom('Living', { x: 0, y: 0 }, width, depth, project.levels[0]))
  return relevel(project)
}

const perimeterOf = (design: ReturnType<typeof designScaffold>): number =>
  design.runs.reduce((sum, run) => sum + run.facadeLengthMm, 0)

describe('finding the façades', () => {
  test('a single room is four runs, and they add up to its outside face', () => {
    const project = oneRoom()
    const room = project.rooms[0]
    const design = designScaffold(project)

    expect(design.runs).toHaveLength(4)
    // The outside face, not the inside one: a 6 × 4 m room in 100 mm walls is 6,2 × 4,2 m round
    // the outside, and that is what the scaffold stands against.
    const outer = 2 * (6000 + 2 * room.wallThickness) + 2 * (4000 + 2 * room.wallThickness)
    expect(perimeterOf(design)).toBeCloseTo(outer, 6)
    expect(design.corners).toBe(4)
    // Every end turns a corner, so nothing needs an end guardrail.
    expect(design.runs.every((run) => run.openEnds === 0)).toBe(true)
    expect(design.runs.map((run) => run.face)).toEqual(['North', 'East', 'South', 'West'])
    expect(design.runs.map((run) => run.mark)).toEqual(['A', 'B', 'C', 'D'])
  })

  test('a wall between two rooms is not a façade', () => {
    const project = oneRoom()
    const ground = project.levels[0]
    const first = project.rooms[0]
    // Butted against the east wall: the two inner faces are one wall thickness apart, which is
    // how every room in this app is laid out next to its neighbour.
    project.rooms.push(
      createRoom('Kitchen', { x: 6000 + first.wallThickness, y: 0 }, 4000, 4000, ground),
    )
    relevel(project)

    const design = designScaffold(project)
    const outer = 2 * (6000 + first.wallThickness + 4000 + 2 * first.wallThickness) + 2 * 4200
    expect(perimeterOf(design)).toBeCloseTo(outer, 6)
    // The shared wall is inside the building, so no run faces along it: the north and south
    // runs are continuous across both rooms rather than broken into four.
    expect(design.runs).toHaveLength(4)
  })

  test('an L-shaped plan comes out as six runs, still adding up to the outside face', () => {
    const project = oneRoom()
    const ground = project.levels[0]
    const room = project.rooms[0]
    const t = room.wallThickness
    // A wing off the north face of the first room, half as wide.
    project.rooms.push(createRoom('Wing', { x: 0, y: 4000 + t }, 3000, 3000, ground))
    relevel(project)

    const design = designScaffold(project)
    expect(design.runs).toHaveLength(6)
    // Walking the outside of the L, corner to corner: south, east, the step back in, the wing's
    // east side, the wing's north end, and the whole west side in one.
    const outer =
      6000 + 2 * t + (4000 + 2 * t) + (3000 + t) + (3000 + t) + (3000 + 2 * t) + (7000 + 2 * t)
    expect(perimeterOf(design)).toBeCloseTo(outer, 6)
    expect(design.corners).toBe(6)
  })
})

describe('how high it goes', () => {
  test('the top deck reaches the work without standing above it', () => {
    const design = designScaffold(sampleProject())
    expect(design.runs.length).toBeGreaterThan(0)
    for (const run of design.runs) {
      const height = run.workTopMm - run.baseMm
      // Within arm's reach of the top of the work…
      expect(run.deckHeightMm + REACH_ABOVE_DECK_MM).toBeGreaterThanOrEqual(height)
      // …and never over it, because you cannot render a wall you are standing level with.
      expect(run.deckHeightMm).toBeLessThanOrEqual(height)
      expect(run.deckHeightMm % LIFT_MM).toBe(0)
    }
  })

  test('a storey set back over the one below is scaffolded off the roof it sits on', () => {
    const project = oneRoom(12000, 6000)
    const first = createLevel(1, project.settings)
    project.levels.push(first)
    relevel(project)
    // Half the ground floor's footprint, pushed to the east end: the west half of the ground
    // floor's roof is now a terrace, and the upper storey's west wall stands on it.
    project.rooms.push(createRoom('Bedroom', { x: 6000, y: 0 }, 6000, 6000, first))
    relevel(project)

    const design = designScaffold(project)
    const roofRuns = design.runs.filter((run) => run.standsOn === 'roof')
    expect(roofRuns.length).toBeGreaterThan(0)
    // Its feet are on the ground floor's roof, which is the upper storey's own floor level.
    expect(roofRuns[0].baseMm).toBeCloseTo(first.elevation, 6)
    expect(design.totals.roofRuns).toBe(roofRuns.length)
    expect(
      design.checks.some((check) => check.severity === 'warning' && check.message.includes('set back')),
    ).toBe(true)

    // The east wall exists on both storeys, so its run starts on the ground and goes all the
    // way up — one run, not two stacked ones.
    const east = design.runs.filter((run) => run.face === 'East')
    expect(east).toHaveLength(1)
    expect(east[0].baseMm).toBe(0)
    expect(east[0].workTopMm).toBeGreaterThan(first.elevation)
  })

  test('the sample house is scaffolded on the ground and off its own terraces', () => {
    // The upper storey is set back onto gridlines 3–6, so the west end of the house has a flat
    // roof at first-floor level and the façades above it cannot be reached from the garden.
    const design = designScaffold(sampleProject())
    expect(design.totals.roofRuns).toBeGreaterThan(0)
    expect(design.runs.some((run) => run.standsOn === 'ground')).toBe(true)
    expect(design.checks.some((check) => check.severity === 'error')).toBe(false)
  })
})

describe('turning it into an order', () => {
  test('the bays cover the run, and what hangs past the end is reported', () => {
    for (const length of [1000, 2000, 4400, 7300, 15_200]) {
      const { bays, overrunMm } = packBays(length, [730, 1090, 1570, 2070, 2570, 3070])
      const total = bays.reduce((sum, bay) => sum + bay, 0)
      // It covers the run, give or take the hand's width at the corner that is not worth
      // another bay — and whichever way it lands, the difference is on the drawing.
      expect(total).toBeGreaterThanOrEqual(length - BAY_TOLERANCE_MM)
      expect(total - length).toBeCloseTo(overrunMm, 6)
      expect(overrunMm).toBeLessThan(3070)
    }
  })

  test('a fixed-bay kit still covers an awkward wall, and says how far past it goes', () => {
    const { bays, overrunMm } = packBays(7300, [2000])
    expect(bays).toEqual([2000, 2000, 2000, 2000])
    expect(overrunMm).toBe(700)
  })

  test('lifts follow from the height and nothing else', () => {
    expect(liftsFor(2000)).toBe(1)
    expect(liftsFor(4000)).toBe(1)
    expect(liftsFor(4100)).toBe(2)
    expect(liftsFor(6100)).toBe(3)
  })

  test('the schedule counts frames the way the runs are built', () => {
    const design = designScaffold(sampleProject())
    const frames = design.runs.reduce((sum, run) => sum + (run.bays.length + 1) * run.lifts, 0)
    expect(design.totals.frames).toBe(frames)
    const line = design.items.find((item) => item.nameRo.startsWith('Cadre'))
    expect(line?.quantity).toBe(frames)
    // The kit that goes on the lorry is weighed, because the lorry is loaded by weight and the
    // delivery is priced by the load.
    for (const romanian of ['Cadre', 'Podine', 'Diagonale', 'Balustrade', 'Ancore', 'Tălpi']) {
      const item = design.items.find((entry) => entry.nameRo.startsWith(romanian))
      expect(item, romanian).toBeDefined()
      expect(item!.massKg, romanian).toBeGreaterThan(0)
    }
    expect(design.rental.loads).toBeGreaterThanOrEqual(1)
  })

  test('the hire is priced only once there is a rate to price it at', () => {
    const project = sampleProject()
    expect(designScaffold(project).rental.hireCost).toBeNull()

    project.settings.scaffold = { ...scaffoldSettingsOf(project), ratePerM2Month: 3 }
    const priced = designScaffold(project)
    expect(priced.rental.hireCost).toBeCloseTo(priced.rental.areaM2 * 3 * priced.settings.months, 6)
  })

  test('the deck is snapped to a width the chosen kit is actually made in', () => {
    const project = sampleProject()
    project.settings.scaffold = {
      ...scaffoldSettingsOf(project),
      system: 'facade-frame',
      deckWidth: 1000,
    }
    // The system scaffold comes in W06 and W09 — 0,73 and 1,09 — and a metre is neither.
    expect(scaffoldSettingsOf(project).deckWidth).toBe(1090)
  })

  test('the enquiry names every run and every part', () => {
    const design = designScaffold(sampleProject())
    const text = scaffoldRequestText(design, 'Locuință P+1E')
    for (const run of design.runs) expect(text).toContain(`${run.mark} — ${run.faceRo}`)
    expect(text).toContain('Plasă de protecție')
    expect(text).toContain('Ancore de perete')
  })
})

describe('the solve is repeatable', () => {
  test('same house, same scaffold', () => {
    const project = sampleProject()
    expect(JSON.stringify(designScaffold(project))).toBe(JSON.stringify(designScaffold(project)))
  })

  test('and it does not depend on the order the rooms were drawn in', () => {
    const project = sampleProject()
    const shuffled = { ...project, rooms: [...project.rooms].reverse() }
    const one = designScaffold(project)
    const two = designScaffold(shuffled)
    expect(two.runs.map((run) => [run.mark, run.facadeLengthMm, run.baseMm])).toEqual(
      one.runs.map((run) => [run.mark, run.facadeLengthMm, run.baseMm]),
    )
  })
})
