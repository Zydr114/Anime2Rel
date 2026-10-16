/**
 * 把 onnxruntime-web 的 WebAssembly 运行时切成分片发布（docs/Plan.md §1.4）。
 *
 * WebGPU 版运行时约 26 MB，超过 Cloudflare Pages 25 MiB 的单文件上限。这里把它切成
 * 不超过 20 MiB 的分片输出到 assets/ort-<哈希>/，并通过虚拟模块 `virtual:ort-runtime`
 * 向推理 Worker 提供分片清单（路径、大小、SHA-256）。Worker 下载拼接后通过
 * `ort.env.wasm.wasmBinary` 交给 ONNX Runtime。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

export const ORT_WASM = 'ort-wasm-simd-threaded.asyncify.wasm'
const VIRTUAL_ID = 'virtual:ort-runtime'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const PART_SIZE = 20 * 1024 * 1024

const require = createRequire(import.meta.url)
const wasmPath = require.resolve(`onnxruntime-web/${ORT_WASM}`)

/** onnxruntime-web 中不内嵌运行时的 WebGPU 入口（运行时由 wasmBinary 提供）。 */
export const ortWebgpuEntry = join(dirname(wasmPath), 'ort.webgpu.min.mjs')

export function ortRuntime(): { main: Plugin; worker: Plugin } {
  const bytes = readFileSync(wasmPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const dir = `assets/ort-${sha256.slice(0, 8)}/`
  const count = Math.ceil(bytes.length / PART_SIZE)
  const parts = Array.from({ length: count }, (_, i) => ({
    fileName: dir + (count > 1 ? `${ORT_WASM}.${String(i).padStart(3, '0')}` : ORT_WASM),
    data: bytes.subarray(i * PART_SIZE, Math.min(bytes.length, (i + 1) * PART_SIZE)),
  }))
  const manifest = { files: parts.map((p) => p.fileName), size: bytes.length, sha256 }

  const virtual: Plugin = {
    name: 'a2r-ort-runtime-manifest',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined
    },
    load(id) {
      return id === RESOLVED_ID ? `export default ${JSON.stringify(manifest)}` : undefined
    },
  }

  const main: Plugin = {
    ...virtual,
    name: 'a2r-ort-runtime',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent(req.url?.split('?')[0] ?? '').replace(/^\//, '')
        const part = parts.find((p) => p.fileName === path)
        if (!part) return next()
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(part.data.length))
        res.end(part.data)
      })
    },
    generateBundle() {
      for (const p of parts) this.emitFile({ type: 'asset', fileName: p.fileName, source: p.data })
    },
  }

  return { main, worker: virtual }
}
