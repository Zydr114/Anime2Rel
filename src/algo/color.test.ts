import { describe, expect, it } from 'vitest'
import { hexToHsv, hsvToHex, parseHex } from './color'

describe('hex and HSV colors', () => {
  it('parses short and long hex and round-trips through HSV', () => {
    expect(parseHex('3AF')).toBe('#33aaff')
    expect(parseHex('#12345')).toBeNull()
    expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 })
    expect(hexToHsv('#808080')).toMatchObject({ h: 0, s: 0 })
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#3366ff', '#c9a96e', '#ff00aa', '#12ab34']) expect(hsvToHex(hexToHsv(hex)!)).toBe(hex)
  })
})
