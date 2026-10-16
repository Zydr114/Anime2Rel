// 下载 Depth Anything V2 Small 的 ONNX 模型到 public/models/，供站点自托管（docs/Plan.md §1.2）。
//
// 超过 partSize 的文件会切成多个分片（Cloudflare Pages 单文件上限 25 MiB），
// 浏览器端按 src/depth/models.json 中的大小和 SHA-256 拼接、校验。
//
// 环境变量：
//   A2R_MODELS       要下载的精度，逗号分隔，默认全部；设为 none 跳过（例如 CI）
//   A2R_HF_ENDPOINT  下载源，默认 https://huggingface.co，可改为 https://hf-mirror.com
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'src/depth/models.json'), 'utf8'))
const endpoint = (process.env.A2R_HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '')
const wanted = (process.env.A2R_MODELS ?? 'all').trim()
const outDir = join(root, 'public/models', manifest.name, manifest.revision.slice(0, 8))

/** 与 src/depth/models.ts 中的 partNames 保持一致。 */
function partNames(file, size, partSize) {
  const count = Math.ceil(size / partSize)
  if (count <= 1) return [file]
  return Array.from({ length: count }, (_, i) => `${file}.${String(i).padStart(3, '0')}`)
}

function complete(variant) {
  const names = partNames(variant.file, variant.size, manifest.partSize)
  let total = 0
  for (const n of names) {
    const p = join(outDir, n)
    if (!existsSync(p)) return false
    total += statSync(p).size
  }
  return total === variant.size
}

async function download(variant) {
  const url = `${endpoint}/${manifest.repo}/resolve/${manifest.revision}/onnx/${variant.file}`
  console.log(`[models] 下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} ${url}`)
  const buf = new Uint8Array(variant.size)
  let offset = 0
  let lastLog = 0
  for await (const chunk of res.body) {
    if (offset + chunk.length > buf.length) throw new Error(`文件大小超出预期：${variant.file}`)
    buf.set(chunk, offset)
    offset += chunk.length
    if (offset - lastLog > 8 << 20 || offset === buf.length) {
      lastLog = offset
      process.stdout.write(`\r[models] ${variant.file} ${(offset / 1048576).toFixed(1)} / ${(buf.length / 1048576).toFixed(1)} MiB`)
    }
  }
  process.stdout.write('\n')
  if (offset !== variant.size) throw new Error(`文件大小不符：${variant.file}，期望 ${variant.size}，实际 ${offset}`)
  const sha = createHash('sha256').update(buf).digest('hex')
  if (sha !== variant.sha256) throw new Error(`SHA-256 校验失败：${variant.file}`)
  const names = partNames(variant.file, variant.size, manifest.partSize)
  mkdirSync(outDir, { recursive: true })
  names.forEach((n, i) => writeFileSync(join(outDir, n), buf.subarray(i * manifest.partSize, Math.min(buf.length, (i + 1) * manifest.partSize))))
  console.log(`[models] 已写入 ${names.length} 个文件：${names.join(', ')}`)
}

if (wanted === 'none') {
  console.log('[models] A2R_MODELS=none，跳过模型下载')
} else {
  const keys = wanted === 'all' ? Object.keys(manifest.variants) : wanted.split(',').map((s) => s.trim())
  for (const key of keys) {
    const variant = manifest.variants[key]
    if (!variant) throw new Error(`未知的模型精度：${key}，可选 ${Object.keys(manifest.variants).join(', ')}`)
    if (complete(variant)) continue
    await download(variant)
  }
}
