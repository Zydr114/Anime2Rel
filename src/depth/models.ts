/** 深度模型清单、下载地址与降级链（docs/Plan.md §1.2）。 */
import manifest from './models.json'

export type Precision = keyof typeof manifest.variants
export type Device = 'webgpu' | 'wasm'
export type ModelSource = 'self' | 'hf' | 'mirror'

export const MODEL = manifest
export const PRECISIONS = Object.keys(manifest.variants) as Precision[]
export const MODEL_SOURCES: readonly ModelSource[] = ['self', 'hf', 'mirror']

const HOSTS: Record<Exclude<ModelSource, 'self'>, string> = {
  hf: 'https://huggingface.co',
  mirror: 'https://hf-mirror.com',
}

/** 与 scripts/fetch-models.mjs 中的 partNames 保持一致。 */
export function partNames(file: string, size: number, partSize: number): string[] {
  const count = Math.ceil(size / partSize)
  if (count <= 1) return [file]
  return Array.from({ length: count }, (_, i) => `${file}.${String(i).padStart(3, '0')}`)
}

/** 某个精度的模型在指定来源下的分片地址；远程来源只有一个完整文件。 */
export function modelUrls(precision: Precision, source: ModelSource, siteBase: string): string[] {
  const v = manifest.variants[precision]
  if (source === 'self') {
    const dir = new URL(`models/${manifest.name}/${manifest.revision.slice(0, 8)}/`, siteBase).href
    return partNames(v.file, v.size, manifest.partSize).map((n) => dir + n)
  }
  return [`${HOSTS[source]}/${manifest.repo}/resolve/${manifest.revision}/onnx/${v.file}`]
}

export interface Attempt {
  device: Device
  precision: Precision
}

export interface DeviceCaps {
  webgpu: boolean
  shaderF16: boolean
}

const needsF16 = (p: Precision) => p === 'q4f16' || p === 'fp16'

/**
 * 按用户偏好和设备能力生成尝试顺序。
 * 自动：WebGPU q4f16 → WebGPU fp16（二者需要 shader-f16）→ WebGPU q4 → WASM q4。
 * 指定精度或设备时只在对应范围内尝试。
 */
export function planAttempts(device: Device | 'auto', precision: Precision | 'auto', caps: DeviceCaps): Attempt[] {
  const gpuOrder: Precision[] = ['q4f16', 'fp16', 'q4']
  const cpuOrder: Precision[] = ['q4']
  const out: Attempt[] = []
  if (caps.webgpu && device !== 'wasm') {
    const list = precision === 'auto' ? gpuOrder : [precision]
    for (const p of list) if (!needsF16(p) || caps.shaderF16) out.push({ device: 'webgpu', precision: p })
  }
  if (device !== 'webgpu') {
    const list = precision === 'auto' ? cpuOrder : [precision]
    for (const p of list) out.push({ device: 'wasm', precision: p })
  }
  return out
}
