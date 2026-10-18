import { describe, expect, it } from 'vitest'
import { CubeError, parseCube } from './cube'
import { registerLut } from './luts'

const identity3d = `# 注释
TITLE "Identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`

describe('parseCube', () => {
  it('reads a 3D LUT with title and domain', () => {
    const lut = parseCube(identity3d)
    expect(lut.title).toBe('Identity')
    expect(lut.size).toBe(2)
    expect(Array.from(lut.data.slice(3, 6))).toEqual([1, 0, 0])
    expect(lut.domainMax).toEqual([1, 1, 1])
  })

  it('expands a 1D LUT per channel', () => {
    const lut = parseCube('LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0 2\n0 0 0\n0.5 1 0.25\n1 1 1\n')
    expect(lut.domainMax).toEqual([2, 2, 2])
    const s = lut.size
    // 网格中点 (r, g, b) = (0.5, 0, 0) → 一维表的中间一行的 R
    const k = (s - 1) / 2
    expect(lut.data[k * 3]).toBeCloseTo(0.5, 6)
    expect(lut.data[(k * s) * 3 + 1]).toBeCloseTo(1, 6)
  })

  it('rejects malformed files', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(CubeError)
    expect(() => parseCube('0 0 0\n')).toThrow(CubeError)
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x\n')).toThrow(CubeError)
  })

  it('registers identical data under the same id', () => {
    expect(registerLut(parseCube(identity3d), 'a.cube').id).toBe(registerLut(parseCube(identity3d), 'b.cube').id)
  })
})
