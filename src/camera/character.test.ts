import { describe, expect, it } from 'vitest'
import { UNIT_CORNERS } from '@/fusion/warp'
import { initialDoc, type DocState } from '@/state/store'
import { cameraCorners, characterMeters } from './character'
import { DEFAULT_CAMERA } from './model'

const doc: DocState = {
  ...initialDoc,
  background: { id: 'bg', name: 'bg', width: 800, height: 600, sourceWidth: 800, sourceHeight: 600, hasTransparency: false },
  character: { id: 'ch', name: 'ch', width: 200, height: 400, sourceWidth: 200, sourceHeight: 400, hasTransparency: true },
  charTransform: { x: 400, y: 320, scale: 0.8, rotation: 0, flipX: false },
}

describe('character in the calibrated camera', () => {
  it('applies the camera perspective once', () => {
    // 相机水平时没有透视
    const level = cameraCorners(doc)!
    level.forEach((p, i) => {
      expect(p.x).toBeCloseTo(UNIT_CORNERS[i].x, 6)
      expect(p.y).toBeCloseTo(UNIT_CORNERS[i].y, 6)
    })
    // 俯视：上宽下窄；在已有透视上再用一次结果不变
    const tilted = { ...doc, camera: { ...DEFAULT_CAMERA, pitch: -0.3, roll: 0.05 } }
    const corners = cameraCorners(tilted)!
    expect(corners[1].x - corners[0].x).toBeGreaterThan(corners[2].x - corners[3].x)
    const again = cameraCorners({ ...tilted, charWarp: { ...tilted.charWarp, corners } })!
    again.forEach((p, i) => {
      expect(p.x).toBeCloseTo(corners[i].x, 6)
      expect(p.y).toBeCloseTo(corners[i].y, 6)
    })
    // 头顶在地平线上：与相机一样高
    expect(characterMeters({ ...doc, charTransform: { ...doc.charTransform, y: 300 + 160 } })).toBeCloseTo(DEFAULT_CAMERA.height, 6)
  })
})
