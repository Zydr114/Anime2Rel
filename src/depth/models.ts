/** 深度模型清单、下载地址与降级链（docs/Plan.md §1.2）。 */
import manifest from './models.json'

export type Precision = keyof typeof manifest.variants
export type Device = 'webgpu' | 'wasm'
export type ModelSource = 'self' | 'hf' | 'modelscope'

export const MODEL = manifest
export const PRECISIONS = Object.keys(manifest.variants) as Precision[]
/** 第一个为默认源：魔搭 ModelScope 国内外都能访问，本站自托管和 Hugging Face 作为备用 */
export const MODEL_SOURCES: readonly ModelSource[] = ['modelscope', 'self', 'hf']

/**
 * 远程源的下载地址。Hugging Face 固定到清单中的提交。
 * 魔搭（ModelScope）同步了同名仓库但只有 master 分支，内容由 SHA-256 校验保证。
 * hf-mirror.com 会拒绝带有第三方 Referer 的请求（防盗链），不适合网页直接下载，因此不提供。
 */
const REMOTE: Record<Exclude<ModelSource, 'self'>, (file: string) => string> = {
  hf: (file) => `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/onnx/${file}`,
  modelscope: (file) => `https://modelscope.cn/models/${manifest.repo}/resolve/master/onnx/${file}`,
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
  return [REMOTE[source](v.file)]
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
