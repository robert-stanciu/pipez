/** Small helpers shared by the plan components. Plan y is north; SVG y grows down. */

import type { Vec2 } from '../../domain/geometry/vec.ts'

export const toPoints = (poly: Vec2[]): string => poly.map((p) => `${p.x},${-p.y}`).join(' ')

/**
 * Screen rotation for a label following a plan direction, flipped where needed so text is
 * never upside down.
 */
export function labelAngle(dx: number, dy: number): number {
  let angle = (Math.atan2(-dy, dx) * 180) / Math.PI
  if (angle > 90) angle -= 180
  if (angle < -90) angle += 180
  return angle
}
