import { describe, expect, it } from 'vitest'
import { PSEUDO_SCALE } from '@/algo/camera'
import { groundPoint } from '@/camera/geometry'
import { DEFAULT_CAMERA } from '@/camera/model'
import { add, dot, unit } from '@/camera/vec'
import { sphereDirection, snapDirection } from './drag'
import { docToWorld, lampFromWorld } from './layout'
import { pickSurface, type SurfaceModel } from './pick'
import { worldFromCamera } from './space'

const size = { width: 640, height: 480 }
const camera = { ...DEFAULT_CAMERA, pitch: -0.3, height: 1.6 }

describe('3D view geometry', () => {
  it('picks the photo surface, and the calibrated ground outside the photo', () => {
    // 照片中的地面比标定的地面高 5 cm：从侧上方看向原相机前方的地面
    const model: SurfaceModel = {
      camera,
      size,
      background: (p) => {
        const g = groundPoint(camera, size, p, camera.height - 0.05)
        return g ? -g[2] : Infinity
      },
      character: () => null,
    }
    const p = { x: 320, y: 400 }
    const target = docToWorld(camera, size, p, -groundPoint(camera, size, p, camera.height - 0.05)![2])
    expect(target[1]).toBeCloseTo(0.05, 6)
    const origin = add(target, [3, 4, 2])
    const hit = pickSurface(model, { origin, dir: unit(add(target, origin, -1)) }, 0.01, 1000)
    expect(hit?.on).toBe('background')
    expect(Math.hypot(...add(hit!.point, target, -1))).toBeLessThan(0.02)
    // 原相机后方的地面不在照片里
    const behind = pickSurface(model, { origin: [0, 2, 3], dir: [0, -1, 0] }, 0.01, 1000)
    expect(behind).toMatchObject({ on: 'ground', doc: null })
    expect(behind!.point[1]).toBeCloseTo(0, 9)
    // 朝上看只有天空
    expect(pickSurface(model, { origin, dir: [0, 1, 0] }, 0.01, 1000)).toBeNull()
  })

  it('stores lamps as image position plus depth and keeps them in front of the camera', () => {
    const w = worldFromCamera(camera, [0.4, -0.2, -2])
    const p = lampFromWorld(camera, size, { ...PSEUDO_SCALE, state: 'noDepth', samples: 0, inliers: 0 }, w)!
    const back = docToWorld(camera, size, p, 1 / (p.depth + PSEUDO_SCALE.b))
    expect(Math.hypot(...add(back, w, -1))).toBeLessThan(1e-9)
    expect(lampFromWorld(camera, size, { ...PSEUDO_SCALE, state: 'noDepth', samples: 0, inliers: 0 }, worldFromCamera(camera, [0, 0, 1]))).toBeNull()
  })

  it('drags suns on the sphere and snaps to ground angles', () => {
    const center: [number, number, number] = [0, 1, -5]
    const ray = { origin: [0, 1, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number] }
    expect(sphereDirection(ray, center, 2, true)).toEqual([0, 0, 1])
    expect(sphereDirection(ray, center, 2, false)).toEqual([0, 0, -1])
    // 视线从球外经过：取球面上离视线最近的方向
    expect(sphereDirection({ origin: [5, 1, 0], dir: [0, 0, -1] }, center, 2, true)).toEqual([1, 0, 0])
    const s = snapDirection([Math.sin(0.5) * Math.cos(0.3), Math.sin(0.3), Math.cos(0.5) * Math.cos(0.3)], Math.PI / 12)
    expect(Math.atan2(s[0], s[2])).toBeCloseTo(Math.PI / 6, 9)
    expect(Math.asin(s[1])).toBeCloseTo(Math.PI / 12, 9)
    expect(dot(s, s)).toBeCloseTo(1, 12)
  })
})
