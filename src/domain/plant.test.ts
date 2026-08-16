/**
 * Golden cases for the plant room.
 *
 * The schematic is a picture and pictures are checked by looking at them. What is checked here
 * is the engineering underneath it — the parts of a heat pump plant that are wrong in ways a
 * drawing does not show. A defrost with nothing to draw heat back out of, a cylinder coil too
 * small to take the unit's output, a vessel charged below the height of the house it serves:
 * each of those builds, runs for a season and then fails, and none of them is visible.
 */

import { describe, expect, test } from 'vitest'

import { designPlant } from './plant.ts'
import { createProject, createRoom, createServicePoint, relevel, sampleProject } from './project.ts'
import { createFixture } from './project.ts'
import { solve } from './routing/index.ts'
import { boreOf, pipeVolumeLitres } from './standards/en806.ts'
import { ufhPipe } from './standards/en1264.ts'
import {
  COIL_M2_PER_KW,
  HEAT_PUMP_SIZES,
  MIN_SYSTEM_VOLUME_L_PER_KW,
  PENETRATION_ZONE_MM,
  WORKING_HEIGHT_MM,
} from './standards/heatpump.ts'
import type { Project } from './types.ts'

const plantOf = (project: Project) => designPlant(project, solve(project))

/** One heated room with a manifold, a heat source and a drain in a plant room off it. */
function scenario(width = 6000, depth = 5000, spacing = 150): Project {
  const project = createProject('plant test')
  project.settings.heating.spacing = spacing
  const ground = project.levels[0]
  const living = createRoom('Living', { x: 0, y: 0 }, width, depth, ground)
  const plant = createRoom('C.T.', { x: width + 100, y: 0 }, 2500, 2500, ground)
  project.rooms.push(living, plant)
  project.fixtures.push(
    createFixture(project, 'water-heater', plant.id, { wallIndex: 3, wallOffset: 900 }),
    createFixture(project, 'floor-drain', plant.id, { position: { x: width + 1300, y: 1200 } }),
  )
  project.servicePoints.push(
    createServicePoint('heatingManifold', { x: 300, y: 300 }, ground, living.id),
  )
  return relevel(project)
}

describe('the plant room', () => {
  test('it is the room the heat source stands in', () => {
    const project = sampleProject()
    const design = plantOf(project)
    const source = project.fixtures.find((f) => f.type === 'water-heater')!
    expect(design.room?.id).toBe(source.roomId)
    // The sample's plant room is on the facade with a drain in it, which is what a monobloc
    // needs: somewhere for the line set to leave and somewhere for the relief to go.
    expect(design.hasExternalWall).toBe(true)
    expect(design.hasFloorDrain).toBe(true)
    expect(design.checks.some((c) => c.severity === 'error')).toBe(false)
  })

  test('with no heat source there is nothing to design, and it says so', () => {
    const project = sampleProject()
    project.fixtures = project.fixtures.filter((f) => f.type !== 'water-heater')
    const design = plantOf(project)
    expect(design.room).toBeNull()
    expect(design.checks.some((c) => c.severity === 'error')).toBe(true)
  })

  test('a plant room with nowhere for the relief to discharge is an error', () => {
    const project = sampleProject()
    project.fixtures = project.fixtures.filter((f) => f.type !== 'floor-drain')
    const design = plantOf(project)
    expect(design.hasFloorDrain).toBe(false)
    expect(
      design.checks.some((c) => c.severity === 'error' && c.message.includes('floor drain')),
    ).toBe(true)
  })
})

describe('sizing', () => {
  test('the unit is a size you can buy, and it covers what the floor gives', () => {
    const design = plantOf(sampleProject())
    expect(HEAT_PUMP_SIZES).toContain(design.heatPump.capacityKw)
    expect(design.heatPump.capacityKw).toBeGreaterThanOrEqual(design.heatPump.demandKw)
  })

  test('the fill is measured off the pipe the router laid, not off a rule of thumb', () => {
    // The one number every other number here comes from — the buffer, the vessel and the
    // glycol order all scale off it — so it is worth proving it is the real pipe.
    const project = sampleProject()
    const result = solve(project)
    const design = designPlant(project, result)
    const pipe = ufhPipe(project.settings.heating.pipe)
    const material = project.settings.supply.material

    let expected = 0
    for (const segment of result.networks.find((n) => n.system === 'heating')?.segments ?? []) {
      const bore =
        segment.role === 'loop' || segment.role === 'branch'
          ? pipe.bore
          : boreOf(material, segment.size)
      expected += pipeVolumeLitres(bore, segment.length)
    }
    expect(design.water.systemL).toBeCloseTo(expected, 6)
    expect(design.water.emitterL + design.water.primaryL).toBeCloseTo(design.water.systemL, 6)
  })

  test('the fill always covers what a defrost draws, buffer or no buffer', () => {
    // This is the whole reason the buffer line exists. Whether the screed happens to hold
    // enough on its own is a property of the house; that the total is enough is not optional.
    for (const project of [sampleProject(), scenario(), scenario(2600, 2200), scenario(9000, 8000, 100)]) {
      const design = plantOf(project)
      expect(design.water.systemL + design.water.bufferL).toBeGreaterThanOrEqual(
        design.heatPump.capacityKw * MIN_SYSTEM_VOLUME_L_PER_KW - 0.5,
      )
    }
  })

  test('the pitch is what decides whether a buffer is needed at all', () => {
    // Both the water held and the heat demanded scale with floor area, so the size of the
    // house very nearly cancels out and what is left is the pitch: a floor at 150 mm holds
    // about three quarters of what its own defrost wants, and the same floor at 100 mm holds
    // more than all of it. Which is a real result and not an arithmetic accident — half as
    // much again of the same pipe in the same screed.
    const open = plantOf(scenario(9000, 8000, 150))
    const tight = plantOf(scenario(9000, 8000, 100))

    expect(tight.water.systemL).toBeGreaterThan(open.water.systemL)
    expect(open.water.bufferL).toBeGreaterThan(0)
    expect(tight.water.bufferL).toBe(0)
    expect(tight.water.systemL).toBeGreaterThan(tight.water.requiredL)
  })

  test('the cylinder coil is sized on the unit, not on the cylinder', () => {
    // The specification most often got wrong. A boiler cylinder of the same volume carries
    // about 1 m², and on one of those the unit can only put in what the coil will pass.
    const design = plantOf(sampleProject())
    expect(design.cylinder.coilM2).toBeCloseTo(design.heatPump.capacityKw * COIL_M2_PER_KW, 6)
    expect(design.cylinder.coilM2).toBeGreaterThan(1)
  })

  test('the vessel is charged above the height of the house it serves', () => {
    // Below the static head the top of the system runs under vacuum and draws air in through
    // every gland it has — which on a heat pump reads as a flow switch trip, not a bleed.
    const design = plantOf(sampleProject())
    expect(design.vessel.staticHeadMm).toBeGreaterThan(0)
    expect(design.vessel.prechargeBar).toBeGreaterThanOrEqual(
      design.vessel.staticHeadMm / 10_000 + 0.3 - 0.05,
    )
    expect(design.vessel.prechargeBar).toBeLessThan(design.vessel.safetyValveBar)
    expect(design.vessel.litres).toBeGreaterThan(0)
  })
})

describe('the parts that get left off', () => {
  // Each of these is a component whose absence does not show on a drawing and shows up two
  // winters later. They are asserted by name because the point is that they are *present*.
  const named = (design: ReturnType<typeof plantOf>, fragment: string) =>
    design.components.find((c) => c.name.toLowerCase().includes(fragment) && c.quantity > 0)

  test('the cold feed carries a check valve, a vessel and a relief', () => {
    // The three that go together. The check valve stops stored hot water pushing back into the
    // main; having stopped it, the expansion has nowhere to go, so the vessel is no longer
    // optional; and the relief is what covers the vessel failing.
    const design = plantOf(sampleProject())
    expect(named(design, 'check valve on the cold feed')).toBeDefined()
    expect(named(design, 'expansion vessel for the store')).toBeDefined()
    expect(named(design, 'cylinder safety group')).toBeDefined()
    expect(design.coldFeed.vesselL).toBeGreaterThan(0)
    expect(design.coldFeed.reliefBar).toBeGreaterThan(design.coldFeed.mainBar)
  })

  test('a stopped circulator is not a path backwards', () => {
    const design = plantOf(sampleProject())
    const checks = named(design, 'check valve on each circulator')
    expect(checks?.quantity).toBe(design.circuits.length)
    expect(named(design, 'isolating valves either side')?.quantity).toBe(
      design.circuits.length * 2,
    )
  })

  test('a glycol system can be drained and can be read', () => {
    const design = plantOf(sampleProject())
    expect(named(design, 'fill and drain cocks')).toBeDefined()
    expect(named(design, 'drain cock under the cylinder')).toBeDefined()
    expect(named(design, 'thermometers')).toBeDefined()
  })

  test('the pressure reducing valve appears only where the main is too high for the store', () => {
    const low = sampleProject()
    low.settings.supply.entryPressureKpa = 300
    expect(plantOf(low).coldFeed.reducedToBar).toBeNull()
    expect(named(plantOf(low), 'pressure reducing valve')).toBeUndefined()

    const high = sampleProject()
    high.settings.supply.entryPressureKpa = 600
    const design = plantOf(high)
    expect(design.coldFeed.reducedToBar).not.toBeNull()
    expect(named(design, 'pressure reducing valve')).toBeDefined()
    // Reducing the feed also shrinks the vessel, because a vessel only uses the band between
    // the feed pressure and the relief.
    expect(design.coldFeed.vesselL).toBeLessThanOrEqual(plantOf(low).coldFeed.vesselL * 2)
  })

  test('the circulation loop is what the hot network asked for, not a preference', () => {
    const project = sampleProject()
    const result = solve(project)
    const design = designPlant(project, result)
    const deadLegs = result.warnings.filter((w) => w.code === 'hot-dead-leg').length
    expect(deadLegs).toBeGreaterThan(0)
    expect(design.recirculation?.deadLegs).toBe(deadLegs)
    expect(named(design, 'circulation pump')).toBeDefined()
    // And its own check valve, without which a draw pulls water backwards round the loop.
    expect(named(design, 'check valve on the circulation return')).toBeDefined()
  })
})

describe('setting the wall out', () => {
  test('the plant goes on the wall the heat source is fixed to', () => {
    const project = sampleProject()
    const design = plantOf(project)
    const source = project.fixtures.find((f) => f.type === 'water-heater')!
    expect(design.wall?.index).toBe(source.wallIndex)
    // In the sample that is the west wall, with the unit on the other side of it.
    expect(design.wall?.external).toBe(true)
    expect(design.wall?.lengthMm).toBeGreaterThan(0)
  })

  test('everything with a footprint is set out, and nothing overlaps', () => {
    const design = plantOf(sampleProject())
    expect(design.arrangement.length).toBeGreaterThan(8)

    // Three rows, because that is how a plant room is built: what stands on the floor, what
    // hangs at working height where it is reached and read, and what goes above that. Within
    // a row nothing may sit on top of anything else — that is the whole point of setting it
    // out — and none of it may stand in front of the penetration.
    const row = (baseMm: number) => (baseMm === 0 ? 0 : baseMm < WORKING_HEIGHT_MM ? 1 : 2)
    for (const band of [0, 1, 2]) {
      const inBand = design.arrangement
        .filter((item) => row(item.mount.baseMm) === band)
        .sort((a, b) => a.atMm - b.atMm)
      for (const item of inBand) {
        expect(item.atMm, `${item.name} stands over the pipe entry`).toBeGreaterThanOrEqual(
          PENETRATION_ZONE_MM,
        )
      }
      for (let i = 1; i < inBand.length; i++) {
        const previous = inBand[i - 1]
        expect(
          inBand[i].atMm,
          `${inBand[i].name} runs into ${previous.name}`,
        ).toBeGreaterThanOrEqual(previous.atMm + previous.mount.widthMm)
      }
    }
  })

  test('the rows are what make it fit — strung out in one line it would not', () => {
    // The reason the three rows exist. A house's worth of plant laid end to end is longer than
    // any wall in a house; stacked the way it is actually built, it goes on comfortably.
    const design = plantOf(sampleProject())
    const endToEnd = design.arrangement.reduce((sum, item) => sum + item.mount.widthMm, 0)
    expect(design.wallUsedMm).toBeLessThan(endToEnd)
    expect(design.wallUsedMm).toBeLessThan(design.wall!.lengthMm)
  })

  test('what is set out is what is on the schedule, and it is numbered', () => {
    const design = plantOf(sampleProject())
    const tags = design.arrangement.map((item) => item.tag)
    expect(tags).toEqual(tags.map((_, i) => i + 1))
    for (const item of design.arrangement) {
      const component = design.components.find((c) => c.id === item.componentId)
      expect(component, item.name).toBeDefined()
      expect(component!.quantity).toBeGreaterThan(0)
      expect(item.mount.widthMm).toBeGreaterThan(0)
      expect(item.mount.heightMm).toBeGreaterThan(0)
    }
  })

  test('a plant that will not go on the wall says so rather than overlapping itself', () => {
    // The check that stops a plant room being drawn and then not being buildable. Everything
    // still gets set out — it is just set out past the end of the wall, and reported.
    const project = sampleProject()
    const room = project.rooms.find((r) => r.name === 'C.T.')!
    room.outline = [
      { x: 0, y: 5900 },
      { x: 1800, y: 5900 },
      { x: 1800, y: 7300 },
      { x: 0, y: 7300 },
    ]
    const design = plantOf(project)
    expect(design.wall!.lengthMm).toBeLessThan(design.wallUsedMm)
    expect(design.checks.some((c) => c.message.includes('sets out to'))).toBe(true)
  })
})

describe('the schedule', () => {
  test('every part carries what it is for, in both languages', () => {
    const design = plantOf(sampleProject())
    expect(design.components.length).toBeGreaterThan(10)
    for (const component of design.components) {
      expect(component.name.length, component.id).toBeGreaterThan(3)
      expect(component.nameRo.length, component.name).toBeGreaterThan(3)
      expect(component.size.length, component.name).toBeGreaterThan(2)
      // The reason is the point of the schedule: a list of boxes teaches nobody which of them
      // they can leave out.
      expect(component.why.length, component.name).toBeGreaterThan(40)
    }
  })

  test('a buffer and a header are one vessel, never two', () => {
    const design = plantOf(sampleProject())
    const vessels = design.components.filter(
      (c) => c.stage === 'buffer' && c.quantity > 0,
    )
    expect(vessels).toHaveLength(1)
  })

  test('one circulator per manifold, at the duty the heating solver worked out', () => {
    const project = sampleProject()
    const result = solve(project)
    const design = designPlant(project, result)
    expect(design.circuits).toHaveLength(result.manifolds.length)
    for (const circuit of design.circuits) {
      const manifold = result.manifolds.find((m) => m.id === circuit.id)!
      expect(circuit.flowLh).toBeCloseTo(manifold.flowKgH, 6)
      // Glycol costs head, so the pump is asked for more than the water-only figure.
      expect(circuit.headKpa).toBeGreaterThan(manifold.pumpHeadKpa)
    }
    expect(design.components.filter((c) => c.name.startsWith('Circulator'))).toHaveLength(
      result.manifolds.length,
    )
  })
})

describe('determinism', () => {
  test('the same house designs the same plant', () => {
    const project = sampleProject()
    const result = solve(project)
    expect(designPlant(project, result)).toEqual(designPlant(project, result))
  })
})
