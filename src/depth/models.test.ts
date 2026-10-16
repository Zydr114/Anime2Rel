import { describe, expect, it } from 'vitest'
import { MODEL, modelUrls, partNames, planAttempts } from './models'

describe('partNames', () => {
  it('keeps small files whole and numbers the parts of large ones', () => {
    expect(partNames('a.onnx', 10, 20)).toEqual(['a.onnx'])
    expect(partNames('a.onnx', 20, 20)).toEqual(['a.onnx'])
    expect(partNames('a.onnx', 41, 20)).toEqual(['a.onnx.000', 'a.onnx.001', 'a.onnx.002'])
  })

  it('splits every model into files below the Cloudflare Pages limit', () => {
    expect(MODEL.partSize).toBeLessThanOrEqual(25 * 1024 * 1024)
  })
})

describe('modelUrls', () => {
  it('builds self-hosted part URLs relative to the site base', () => {
    const urls = modelUrls('fp16', 'self', 'https://example.com/app/')
    expect(urls).toHaveLength(3)
    expect(urls[0]).toBe(`https://example.com/app/models/depth-anything-v2-small/${MODEL.revision.slice(0, 8)}/model_fp16.onnx.000`)
  })

  it('pins the revision for remote sources', () => {
    expect(modelUrls('q4f16', 'mirror', 'https://example.com/')).toEqual([
      `https://hf-mirror.com/onnx-community/depth-anything-v2-small/resolve/${MODEL.revision}/onnx/model_q4f16.onnx`,
    ])
  })
})

describe('planAttempts', () => {
  const full = { webgpu: true, shaderF16: true }
  it('walks the fallback chain automatically', () => {
    expect(planAttempts('auto', 'auto', full)).toEqual([
      { device: 'webgpu', precision: 'q4f16' },
      { device: 'webgpu', precision: 'fp16' },
      { device: 'webgpu', precision: 'q4' },
      { device: 'wasm', precision: 'q4' },
    ])
  })

  it('skips f16 models without shader-f16 and WebGPU entirely when unavailable', () => {
    expect(planAttempts('auto', 'auto', { webgpu: true, shaderF16: false })).toEqual([
      { device: 'webgpu', precision: 'q4' },
      { device: 'wasm', precision: 'q4' },
    ])
    expect(planAttempts('auto', 'auto', { webgpu: false, shaderF16: false })).toEqual([{ device: 'wasm', precision: 'q4' }])
  })

  it('respects explicit choices', () => {
    expect(planAttempts('wasm', 'int8', full)).toEqual([{ device: 'wasm', precision: 'int8' }])
    expect(planAttempts('webgpu', 'auto', { webgpu: false, shaderF16: false })).toEqual([])
    expect(planAttempts('auto', 'fp16', { webgpu: true, shaderF16: false })).toEqual([{ device: 'wasm', precision: 'fp16' }])
  })
})
