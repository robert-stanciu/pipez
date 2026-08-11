/**
 * Vector primitives. Everything in the domain is in **millimetres**.
 *
 * Coordinate convention:
 *   x — east, y — north (i.e. "up" on the plan), z — elevation above the level datum.
 *
 * three.js is y-up, so the render layer maps (x, y, z) -> (x, z, -y). That mapping keeps
 * the handedness of the frame, so plan-north ends up pointing away from the default camera.
 */

export interface Vec2 {
  x: number
  y: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y })
export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale2 = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
export const cross2 = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
export const len2 = (a: Vec2): number => Math.hypot(a.x, a.y)
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y)

export function norm2(a: Vec2): Vec2 {
  const l = len2(a)
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

/** Rotate 90° counter-clockwise. */
export const perp2 = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x })

export function rotate2(a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }
}

export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

export const eq2 = (a: Vec2, b: Vec2, tol = 1e-6): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol

export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
export const to3 = (a: Vec2, z: number): Vec3 => ({ x: a.x, y: a.y, z })
export const to2 = (a: Vec3): Vec2 => ({ x: a.x, y: a.y })

export const eq3 = (a: Vec3, b: Vec3, tol = 1e-6): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol

/** Manhattan (rectilinear) distance — the metric pipe and cable runs actually follow. */
export const manhattan3 = (a: Vec3, b: Vec3): number =>
  Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z)

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

/** Round to the nearest multiple of `step` (used for grid snapping and node keys). */
export const snapTo = (value: number, step: number): number =>
  step <= 0 ? value : Math.round(value / step) * step

/** Map a domain point into three.js' y-up frame. */
export const toThree = (p: Vec3): [number, number, number] => [p.x, p.z, -p.y]

/** Closest point to `p` on the segment a–b, plus the parameter t along it. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub2(b, a)
  const lengthSq = dot2(ab, ab)
  if (lengthSq < 1e-9) return { point: { ...a }, t: 0 }
  const t = clamp(dot2(sub2(p, a), ab) / lengthSq, 0, 1)
  return { point: add2(a, scale2(ab, t)), t }
}

/**
 * Intersection of two infinite lines, each given as a point and a direction.
 * Returns null when they are (near) parallel.
 */
export function lineIntersection(a: Vec2, dirA: Vec2, b: Vec2, dirB: Vec2): Vec2 | null {
  const denom = cross2(dirA, dirB)
  if (Math.abs(denom) < 1e-9) return null
  const t = cross2(sub2(b, a), dirB) / denom
  return add2(a, scale2(dirA, t))
}
