/**
 * EN 806-3 sizing tables, transcribed and checked.
 *
 * These are the numbers a drawing is only as right as, so they are asserted against the
 * standard's own tables rather than against whatever the code happened to return. The unit
 * cases matter as much as the table ones: a loading unit is 0,1 l/s, an outside diameter is
 * not a bore, and confusing either quietly changes every figure downstream by a third.
 */

import { describe, expect, test } from 'vitest'

import {
  boreOf,
  connectionSize,
  drawOffFlow,
  flowFromLu,
  MAX_HOT_DEAD_LEG_LITRES,
  MAX_VELOCITY_CONNECTION,
  MAX_VELOCITY_DISTRIBUTION,
  maxRunLength,
  minFlowRate,
  pipeVolumeLitres,
  pressureLossKpa,
  staticHeadKpa,
  supplyDiameter,
  supplyPipeLabel,
  supplySizes,
  velocity,
} from './en806.ts'

describe('loading units and flow', () => {
  test('a loading unit is 0,1 l/s, so the annex B curve takes litres and not units', () => {
    expect(drawOffFlow(1)).toBeCloseTo(0.1, 9)
    // QD = 0,682·QT^0,45 − 0,14 with QT = 2,0 l/s. Feeding the curve 20 instead of 2,0
    // returns 2,40 l/s — three times the real demand, and two pipe sizes too big.
    expect(flowFromLu(20)).toBeCloseTo(0.79, 2)
    expect(flowFromLu(0)).toBe(0)
  })

  test('one tap on its own gets at least its own draw-off rate', () => {
    // The curve is only defined from QT = 0,2 l/s and dips below zero underneath it.
    expect(flowFromLu(1)).toBeGreaterThanOrEqual(drawOffFlow(1))
    expect(flowFromLu(0.5)).toBeGreaterThan(0)
  })

  test('minimum flow rates come from Table 2', () => {
    expect(minFlowRate(1)).toBe(0.1)
    expect(minFlowRate(2)).toBe(0.15)
    expect(minFlowRate(4)).toBe(0.3)
    expect(minFlowRate(5)).toBe(0.4)
  })
})

describe('Table 3.2 — copper', () => {
  test('the maximum loads are the standard’s, not a neighbouring column', () => {
    const maxLu = supplySizes('copper').map((row) => row.tiers[0].maxLu)
    expect(maxLu).toEqual([1, 3, 10, 20, 50, 165, 430, 1050, 2100])
  })

  test('sizes step where the table says they step', () => {
    expect(supplyDiameter(1, 0, 'copper')).toBe(12)
    expect(supplyDiameter(3, 0, 'copper')).toBe(15)
    // 18 × 1,0 carries 10 LU. The 8 that used to sit here is the "highest value" row —
    // the largest single draw-off allowed on the section, not the section's own load.
    expect(supplyDiameter(9, 0, 'copper')).toBe(18)
    expect(supplyDiameter(10, 0, 'copper')).toBe(18)
    expect(supplyDiameter(11, 0, 'copper')).toBe(22)
    // 28 × 1,5 carries 50, not 55, and the two above it were far too small.
    expect(supplyDiameter(50, 0, 'copper')).toBe(28)
    expect(supplyDiameter(51, 0, 'copper')).toBe(35)
    expect(supplyDiameter(165, 0, 'copper')).toBe(35)
    expect(supplyDiameter(430, 0, 'copper')).toBe(42)
    expect(supplyDiameter(1050, 0, 'copper')).toBe(54)
  })

  test('a connection size is a floor whatever the load says', () => {
    expect(supplyDiameter(1, 22, 'copper')).toBe(22)
  })

  test('the figures are outside diameters, and the bore is carried beside them', () => {
    expect(boreOf('copper', 22)).toBe(20)
    expect(boreOf('copper', 15)).toBe(13)
    expect(boreOf('PPR', 20)).toBe(13.2)
  })

  test('maximum run lengths tighten as the load on the size rises', () => {
    expect(maxRunLength('copper', 12, 1)).toBe(20_000)
    expect(maxRunLength('copper', 12, 2)).toBe(7_000)
    expect(maxRunLength('copper', 12, 3)).toBe(5_000)
    expect(maxRunLength('copper', 15, 3)).toBe(15_000)
    // Beyond the two smallest sizes the table sets no length limit.
    expect(maxRunLength('copper', 22, 20)).toBe(Infinity)
  })
})

describe('materials a Romanian house is actually plumbed in', () => {
  test('PP-R runs from ø20 up, and reads as ø20 PPR rather than DN15', () => {
    expect(supplySizes('PPR')[0].od).toBe(20)
    expect(supplyDiameter(3, 0, 'PPR')).toBe(20)
    expect(supplyDiameter(4, 0, 'PPR')).toBe(25)
    expect(supplyDiameter(9, 0, 'PPR')).toBe(32)
    expect(supplyPipeLabel('PPR', 20)).toBe('Ø20 PPR')
  })

  test('a copper tap tail translates by its bore, not by the number outside', () => {
    // 15 mm copper is a 13 mm bore: ø20 in PP-R, ø20 in composite — not the ø16 the digits
    // would suggest. 22 mm copper is a 20 mm bore, which is ø32 in PP-R.
    expect(connectionSize('copper', 15)).toBe(15)
    expect(connectionSize('PPR', 15)).toBe(20)
    expect(connectionSize('PPR', 22)).toBe(32)
    expect(connectionSize('PEX-AL-PEX', 15)).toBe(20)
  })

  test('every derived ladder clears the PE-X row it borrows its capacity from', () => {
    for (const material of ['PPR', 'PEX-AL-PEX'] as const) {
      for (const row of supplySizes(material)) {
        const source = supplySizes('PE-X').find((pex) => pex.tiers[0].maxLu === row.tiers[0].maxLu)
        expect(source).toBeDefined()
        expect(row.bore).toBeGreaterThanOrEqual(source!.bore)
      }
    }
  })
})

describe('velocity', () => {
  test('velocity is taken over the bore, not the outside diameter', () => {
    // 22 × 1,0 copper is a 20 mm bore. Using the 22 over-states the area by 21 % and
    // under-states the speed of the water by the same.
    expect(velocity(0.5, 20)).toBeCloseTo(1.59, 2)
    expect(velocity(0.5, 20) / velocity(0.5, 22)).toBeCloseTo(1.21, 2)
  })

  test('§4.4 allows a connection pipe to a single fitting twice the speed', () => {
    expect(MAX_VELOCITY_DISTRIBUTION).toBe(2.0)
    expect(MAX_VELOCITY_CONNECTION).toBe(4.0)
  })
})

describe('pressure', () => {
  test('a metre of climb costs about 9,8 kPa', () => {
    expect(staticHeadKpa(1000)).toBeCloseTo(9.81, 2)
    expect(staticHeadKpa(-1000)).toBeCloseTo(-9.81, 2)
  })

  test('head loss grows with length and falls away sharply with bore', () => {
    const short = pressureLossKpa(0.5, 20, 10_000, 1.31e-6)
    const long = pressureLossKpa(0.5, 20, 20_000, 1.31e-6)
    const wide = pressureLossKpa(0.5, 26, 10_000, 1.31e-6)
    expect(long).toBeCloseTo(short * 2, 6)
    expect(wide).toBeLessThan(short / 2)
    expect(pressureLossKpa(0, 20, 10_000, 1.31e-6)).toBe(0)
  })
})

describe('the hot dead leg is a volume, not a length', () => {
  test('three litres is about 22 m of 15 mm copper but only 9,5 m of 22 mm', () => {
    expect(MAX_HOT_DEAD_LEG_LITRES).toBe(3)
    expect(pipeVolumeLitres(boreOf('copper', 15), 22_600)).toBeCloseTo(3, 1)
    expect(pipeVolumeLitres(boreOf('copper', 22), 9_550)).toBeCloseTo(3, 1)
  })

  test('the old flat 12 m limit was wrong in both directions', () => {
    // Too strict on the small pipe: 12 m of 15 mm copper holds well under three litres.
    expect(pipeVolumeLitres(boreOf('copper', 15), 12_000)).toBeLessThan(MAX_HOT_DEAD_LEG_LITRES)
    // Too lenient on the large one: 12 m of 22 mm copper is nearly four.
    expect(pipeVolumeLitres(boreOf('copper', 22), 12_000)).toBeGreaterThan(MAX_HOT_DEAD_LEG_LITRES)
  })
})
