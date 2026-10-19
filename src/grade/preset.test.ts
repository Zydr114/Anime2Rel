import { describe, expect, it } from 'vitest'
import { getLut, registerLut } from './luts'
import { DEFAULT_GRADE, IDENTITY_CURVE, isNeutralAdjust, isNeutralCreative, newBlendLayer } from './model'
import { DEFAULT_POST, isNeutralPost } from './post'
import { BUILTIN_PRESET_IDS, BUILTIN_PRESETS, matchesPreset, parsePreset, PresetError, PRESET_FORMAT, serializePreset } from './preset'

describe('preset files', () => {
  it('round-trips parameters and embeds the LUT in use', () => {
    const data = new Float32Array(2 ** 3 * 3).map((_, i) => (i % 7) / 6 + 1e-3)
    const ref = registerLut({ title: 't', size: 2, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }, 'warm.cube')
    const grade = {
      ...DEFAULT_GRADE,
      creative: { ...DEFAULT_GRADE.creative, lut: ref, lutIntensity: 0.6, layers: [{ ...newBlendLayer(), mode: 'multiply' as const }] },
    }
    const post = { ...DEFAULT_POST, rays: { ...DEFAULT_POST.rays, intensity: 0.4, light: 'light-1' } }
    const text = serializePreset({ name: '暖色', grade, post })
    const preset = parsePreset(text, 'x')
    expect(preset.name).toBe('暖色')
    expect(matchesPreset(grade, post, preset)).toBe(true)
    expect(preset.post.rays.light).toBeNull()
    expect(preset.grade.creative.lut).toEqual(ref)
    expect(getLut(ref.id)?.data).toEqual(data)
  })

  it('rejects other files and clamps or drops invalid fields', () => {
    expect(() => parsePreset('{', 'x')).toThrow(PresetError)
    expect(() => parsePreset('{"format":"other"}', 'x')).toThrow(PresetError)
    const preset = parsePreset(
      JSON.stringify({
        format: PRESET_FORMAT,
        version: 1,
        grade: {
          levels: { global: { exposure: 99, contrast: 'high', curves: { master: [[0, 0], [0.5, 2], [0.4, 1], [1, 1]] }, hsl: { hue: [5] } } },
          creative: { lut: { id: 'lut-missing', name: 'gone' }, layers: Array.from({ length: 9 }, () => ({ mode: 'bogus', color: 'red', opacity: 3 })) },
        },
        post: { grain: { amount: -1 }, lens: { vignette: -5 }, toneMapping: 'filmic' },
      }),
      '文件名',
    )
    const global = preset.grade.levels.global
    expect(preset.name).toBe('文件名')
    expect(global.exposure).toBe(5)
    expect(global.contrast).toBe(0)
    expect(global.curves.master).toEqual(IDENTITY_CURVE)
    expect(global.hsl.hue).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(preset.grade.creative.lut).toBeNull()
    expect(preset.grade.creative.layers).toHaveLength(4)
    expect(preset.grade.creative.layers[0]).toMatchObject({ mode: 'soft-light', color: '#ff9d4d', opacity: 1 })
    expect(preset.post.grain.amount).toBe(0)
    expect(preset.post.lens.vignette).toBe(-1)
    expect(preset.post.toneMapping).toBe('none')
  })

  it('built-in presets are valid and survive a round trip', () => {
    for (const id of BUILTIN_PRESET_IDS) {
      const p = BUILTIN_PRESETS[id]
      expect(isNeutralAdjust(p.grade.levels.global) && isNeutralCreative(p.grade.creative) && isNeutralPost(p.post)).toBe(false)
      expect(matchesPreset(p.grade, p.post, parsePreset(serializePreset({ name: id, ...p }), 'x'))).toBe(true)
    }
  })
})
