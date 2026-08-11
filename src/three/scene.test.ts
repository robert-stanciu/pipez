/**
 * The bend placement is pure trigonometry that is hard to check by eye — a torus that is
 * subtly mis-oriented still looks like a bend from most angles. So it is checked here
 * instead: the arc has to start exactly where the pipe stops being straight, and end exactly
 * where it starts being straight again.
 */

import { describe, expect, test } from 'vitest'
import { Vector3 } from 'three'

import type { Fitting } from '../domain/types.ts'
import { bendPlacement, toScene } from './scene.ts'

const elbow = (dirIn: [number, number, number], dirOut: [number, number, number]): Fitting => ({
  id: 'f',
  kind: 'elbow',
  system: 'waste',
  position: { x: 1000, y: 2000, z: -100 },
  size: 100,
  angle: 90,
  dirIn: { x: dirIn[0], y: dirIn[1], z: dirIn[2] },
  dirOut: { x: dirOut[0], y: dirOut[1], z: dirOut[2] },
})

/** Where the torus arc begins and ends, in world space. */
function arcEnds(placement: NonNullable<ReturnType<typeof bendPlacement>>) {
  const at = (angle: number) =>
    new Vector3(Math.cos(angle) * placement.radius, Math.sin(angle) * placement.radius, 0)
      .applyQuaternion(placement.quaternion)
      .add(placement.position)
  return { start: at(0), end: at(placement.arc) }
}

/** Direction mapped the same way the renderer maps it. */
const sceneDir = (d: { x: number; y: number; z: number }) =>
  new Vector3(d.x, d.z, -d.y).normalize()

describe('bend placement', () => {
  const cases: Array<[string, [number, number, number], [number, number, number], number]> = [
    ['a square turn in plan', [1, 0, 0], [0, 1, 0], 90],
    ['a 45° turn in plan', [1, 0, 0], [Math.SQRT1_2, Math.SQRT1_2, 0], 45],
    ['a vertical drop into a horizontal branch', [0, 0, -1], [1, 0, 0], 90],
    ['a turn the other way round', [0, 1, 0], [-1, 0, 0], 90],
  ]

  for (const [name, dirIn, dirOut, expectedTurn] of cases) {
    test(`${name} is tangent to both legs`, () => {
      const fitting = elbow(dirIn, dirOut)
      const placement = bendPlacement(fitting)
      expect(placement).not.toBeNull()
      if (!placement) return

      expect((placement.arc * 180) / Math.PI).toBeCloseTo(expectedTurn, 4)

      const corner = toScene(fitting.position)
      const inbound = sceneDir(fitting.dirIn!)
      const outbound = sceneDir(fitting.dirOut!)
      const tangent = placement.radius * Math.tan(placement.arc / 2)

      const expectedStart = corner.clone().addScaledVector(inbound, -tangent)
      const expectedEnd = corner.clone().addScaledVector(outbound, tangent)

      const { start, end } = arcEnds(placement)
      expect(start.distanceTo(expectedStart)).toBeLessThan(1e-6)
      expect(end.distanceTo(expectedEnd)).toBeLessThan(1e-6)
    })
  }

  test('a straight-through joint is not a bend', () => {
    expect(bendPlacement(elbow([1, 0, 0], [1, 0, 0]))).toBeNull()
  })

  test('a fitting with no recorded directions is skipped rather than guessed at', () => {
    const fitting = elbow([1, 0, 0], [0, 1, 0])
    delete fitting.dirOut
    expect(bendPlacement(fitting)).toBeNull()
  })
})
