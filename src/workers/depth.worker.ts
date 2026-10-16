/**
 * 深度估计 Worker（docs/Plan.md §3.1）：加载 ONNX Runtime 与 Depth Anything V2 Small，
 * 按降级链选择推理后端，完成推理和全部后处理。
 */
import * as Comlink from 'comlink'
import * as ort from 'onnxruntime-web/webgpu'
import ortGlueUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import runtime from 'virtual:ort-runtime'
import { toHalf } from '@/algo/half'
import { cachedBytes, clearBlobCache, loadBlob } from '@/depth/blobStore'
import { MODEL, modelUrls, planAttempts, type Attempt, type DeviceCaps } from '@/depth/models'
import { guideSize, modelInputSize, postprocess, toGuide, toModelInput, type DepthKind, type Size } from '@/depth/pipeline'
import type { AttemptFailure, DepthResult, DepthWorkerApi, LoadProgress, LoadRequest, LoadResult } from '@/depth/protocol'

let session: ort.InferenceSession | null = null
let active: Attempt | null = null
let runtimeReady: Promise<void> | null = null
let threads = 1

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function deviceCaps(): Promise<DeviceCaps> {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
    return { webgpu: !!adapter, shaderF16: !!adapter?.features.has('shader-f16') }
  } catch {
    return { webgpu: false, shaderF16: false }
  }
}

/** 下载并配置 WebAssembly 运行时；只需一次，失败后允许重试。 */
function initRuntime(siteBase: string, onProgress: (p: LoadProgress) => void): Promise<void> {
  runtimeReady ??= (async () => {
    const urls = runtime.files.map((f) => new URL(f, siteBase).href)
    const { bytes } = await loadBlob({ urls, size: runtime.size, sha256: runtime.sha256 }, (loaded, total) => onProgress({ phase: 'runtime', loaded, total }))
    ort.env.wasm.wasmBinary = bytes
    ort.env.wasm.wasmPaths = { mjs: new URL(ortGlueUrl, self.location.href).href }
    // 多线程需要跨源隔离（COOP/COEP）；留一半核心给页面
    threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 4) / 2))) : 1
    ort.env.wasm.numThreads = threads
    ort.env.logLevel = 'error'
  })().catch((e) => {
    runtimeReady = null
    throw e
  })
  return runtimeReady
}

async function release(): Promise<void> {
  const s = session
  session = null
  active = null
  await s?.release().catch(() => {})
}

/** 用一张小尺寸渐变图试跑，确认算子受支持且输出有限（fp16 在部分设备上会溢出）。 */
async function selfTest(s: ort.InferenceSession): Promise<void> {
  const size = 112
  const data = new Float32Array(3 * size * size)
  for (let i = 0; i < size * size; i++) {
    const v = ((i % size) / size - 0.45) / 0.226
    data[i] = v
    data[size * size + i] = v * 0.8
    data[2 * size * size + i] = -v
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, size, size]) })
  const t = out[s.outputNames[0]]
  const values = (await t.getData()) as Float32Array
  t.dispose()
  if (!values.length || !values.every(Number.isFinite)) throw new Error('自检输出包含无效数值')
}

function draw(bitmap: ImageBitmap, size: Size): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 2D 画布')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, size.width, size.height)
  return ctx.getImageData(0, 0, size.width, size.height).data
}

function halves(src: Float32Array, out: Uint16Array, stride: number, offset: number): void {
  for (let i = 0; i < src.length; i++) out[i * stride + offset] = toHalf(src[i])
}

async function loadModel(request: LoadRequest, onProgress: (p: LoadProgress) => void): Promise<LoadResult> {
  await release()
  try {
    await initRuntime(request.siteBase, onProgress)
  } catch (e) {
    return { ok: false, failures: [], message: `推理运行时加载失败：${message(e)}` }
  }
  const caps = await deviceCaps()
  const attempts = planAttempts(request.device, request.precision, caps)
  if (attempts.length === 0) {
    const reason = request.device === 'webgpu' ? '当前浏览器不支持 WebGPU' : '所选精度需要 WebGPU 的 shader-f16 特性'
    return { ok: false, failures: [], message: reason }
  }
  const failures: AttemptFailure[] = []
  for (const attempt of attempts) {
    const variant = MODEL.variants[attempt.precision]
    let created: ort.InferenceSession | null = null
    try {
      const t0 = performance.now()
      const { bytes, fromCache } = await loadBlob(
        { urls: modelUrls(attempt.precision, request.source, request.siteBase), size: variant.size, sha256: variant.sha256 },
        (loaded, total) => onProgress({ phase: 'model', attempt, loaded, total }),
      )
      const t1 = performance.now()
      onProgress({ phase: 'init', attempt, loaded: 0, total: 0 })
      created = await ort.InferenceSession.create(bytes, {
        executionProviders: [attempt.device],
        graphOptimizationLevel: 'all',
        // 只输出错误：形状相关算子被分配到 CPU 的警告属于正常现象
        logSeverityLevel: 3,
      })
      await selfTest(created)
      session = created
      active = attempt
      return {
        ok: true,
        info: { ...attempt, fromCache, loadMs: t1 - t0, initMs: performance.now() - t1, threads, failures },
      }
    } catch (e) {
      failures.push({ attempt, message: message(e) })
      await created?.release().catch(() => {})
    }
  }
  return { ok: false, failures, message: '所有推理方式均失败' }
}

const api: DepthWorkerApi = {
  async load(request: LoadRequest, onProgress): Promise<LoadResult> {
    try {
      return await loadModel(request, onProgress)
    } finally {
      // 主线程传来的回调是 Comlink 代理，用完释放其消息端口
      ;(onProgress as unknown as Comlink.Remote<unknown>)[Comlink.releaseProxy]?.()
    }
  },

  async estimate(bitmap: ImageBitmap, kind: DepthKind): Promise<DepthResult> {
    if (!session || !active) {
      bitmap.close()
      throw new Error('模型尚未加载')
    }
    const t0 = performance.now()
    const model = modelInputSize(bitmap.width, bitmap.height)
    const modelPx = toGuide(draw(bitmap, model), kind)
    const input = toModelInput(modelPx.guide, model)
    const gSize = guideSize(bitmap.width, bitmap.height)
    const guidePx = toGuide(draw(bitmap, gSize), kind)
    bitmap.close()

    const t1 = performance.now()
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, model.height, model.width]) })
    const tensor = out[session.outputNames[0]]
    const raw = Float32Array.from((await tensor.getData()) as Float32Array)
    tensor.dispose()
    if (raw.length !== model.width * model.height) throw new Error(`模型输出尺寸异常：${tensor.dims.join('×')}`)

    const t2 = performance.now()
    const maps = postprocess(kind, raw, model, kind === 'character' ? modelPx.alpha : undefined, { size: gSize, ...guidePx })
    const n = gSize.width * gSize.height
    const coefHalf = new Uint16Array(n * 4)
    for (let i = 0; i < coefHalf.length; i++) coefHalf[i] = toHalf(maps.coef[i])
    const auxHalf = new Uint16Array(n * 4)
    halves(maps.rawUp, auxHalf, 4, 0)
    if (maps.sky) halves(maps.sky, auxHalf, 4, 1)
    const t3 = performance.now()

    const result: DepthResult = {
      kind,
      device: active.device,
      precision: active.precision,
      model,
      guideSize: gSize,
      depth: maps.depth,
      normal: maps.normal,
      sky: maps.sky,
      coefHalf,
      auxHalf,
      timings: { prepare: t1 - t0, inference: t2 - t1, post: t3 - t2 },
    }
    const buffers = [maps.depth.buffer, maps.normal.buffer, coefHalf.buffer, auxHalf.buffer]
    if (maps.sky) buffers.push(maps.sky.buffer)
    return Comlink.transfer(result, buffers as ArrayBuffer[])
  },

  async unload() {
    await release()
  },

  clearCache: clearBlobCache,
  cacheSize: cachedBytes,
}

Comlink.expose(api)
