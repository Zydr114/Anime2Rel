import { describe, expect, it } from 'vitest'
import { groundPoint } from './geometry'
import { dragOrigin, grabHeight, guideGeometry, yawToward } from './guides'
import { DEFAULT_CAMERA } from './model'

const size = { width: 800, height: 600 }
const camera = { ...DEFAULT_CAMERA, pitch: -0.25, roll: 0.05, yaw: 0.4 }

describe('reference guides', () => {
  it('moves with the pointer and turns toward it', () => {
    const origin = { x: 400, y: 480 }
    // 拖动地面：按下处的地面点始终在指针下方，即原点在地面上平移了相同的距离
    const moved = dragOrigin(camera, size, origin, 0, { x: 300, y: 500 }, { x: 520, y: 420 })!
    const [a, b] = [groundPoint(camera, size, { x: 300, y: 500 })!, groundPoint(camera, size, { x: 520, y: 420 })!]
    const [o, m] = [groundPoint(camera, size, origin)!, groundPoint(camera, size, moved)!]
    for (let i = 0; i < 3; i++) expect(m[i] - o[i]).toBeCloseTo(b[i] - a[i], 6)
    // 红轴的末端拖到哪里，红轴就指向哪里
    const geo = guideGeometry(camera, size, 'box', origin)!
    expect(yawToward(camera, size, origin, geo.axes.x!, 'x')).toBeCloseTo(camera.yaw, 6)
    expect(yawToward(camera, size, origin, geo.axes.z!, 'z')).toBeCloseTo(camera.yaw, 6)
    // 按在立方体顶上时在立方体的高度上平移
    expect(grabHeight(camera, size, 'box', origin, geo.axes.y!, 1)).toBeCloseTo(1, 6)
  })
})
