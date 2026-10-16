import { describe, expect, it } from 'vitest'
import { rowStride, unpackRows } from './readback'

describe('rowStride', () => {
  it('aligns WebGPU rows to 256 bytes', () => {
    expect(rowStride(400, 4, 1, 256)).toBe(1792)
    expect(rowStride(64, 4, 1, 256)).toBe(256)
    expect(rowStride(2, 4, 2, 256)).toBe(128)
  })

  it('keeps tight rows when alignment is 1', () => {
    expect(rowStride(400, 4, 1, 1)).toBe(1600)
  })
})

describe('unpackRows', () => {
  it('returns tight top-down data unchanged', () => {
    const src = new Uint8Array([1, 2, 3, 4])
    expect(unpackRows(src, 1, 4, 1, 1, false)).toBe(src)
  })

  it('removes row padding, including an unpadded last row', () => {
    const src = new Uint8Array([1, 2, 0, 0, 3, 4])
    expect(Array.from(unpackRows(src, 2, 2, 1, 4, false))).toEqual([1, 2, 3, 4])
  })

  it('flips bottom-up rows', () => {
    const src = new Uint8Array([3, 4, 1, 2])
    expect(Array.from(unpackRows(src, 2, 2, 1, 2, true))).toEqual([1, 2, 3, 4])
  })

  it('rejects undersized buffers', () => {
    expect(() => unpackRows(new Uint8Array(3), 2, 2, 1, 2, false)).toThrow()
  })
})
