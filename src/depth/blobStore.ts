/**
 * 大文件（模型、推理运行时）的下载与持久缓存。
 *
 * - 文件可能被切成多个分片（Cloudflare Pages 单文件上限 25 MiB），按顺序下载后拼接；
 * - 下载完成后校验 SHA-256，因此第三方源返回的内容也能保证与清单一致；
 * - 校验通过后以 SHA-256 为键存入 Cache API，换下载源也能命中缓存。
 */

export interface BlobSpec {
  /** 分片地址，按顺序拼接 */
  urls: string[]
  size: number
  sha256: string
}

export type ProgressFn = (loaded: number, total: number) => void

const CACHE_NAME = 'a2r-blobs-v1'
const SIZE_HEADER = 'X-A2R-Size'

function cacheKey(sha256: string): string {
  return new URL(`/__a2r_blob__/${sha256}`, self.location.origin).href
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class BlobError extends Error {}

/** 读取文件：优先使用缓存，否则下载、校验并写入缓存。 */
export async function loadBlob(spec: BlobSpec, onProgress?: ProgressFn): Promise<{ bytes: Uint8Array; fromCache: boolean }> {
  const cache = await openCache()
  const key = cacheKey(spec.sha256)
  const hit = await cache?.match(key).catch(() => undefined)
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer())
    if (bytes.length === spec.size) {
      onProgress?.(spec.size, spec.size)
      return { bytes, fromCache: true }
    }
    await cache?.delete(key)
  }

  const bytes = new Uint8Array(spec.size)
  let offset = 0
  let lastReport = 0
  onProgress?.(0, spec.size)
  for (const url of spec.urls) {
    let res: Response
    try {
      // 已有 Cache API，不再让 HTTP 缓存额外存一份
      res = await fetch(url, { cache: 'no-store', mode: 'cors' })
    } catch (e) {
      throw new BlobError(`无法连接 ${new URL(url).host}：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok || !res.body) throw new BlobError(`下载失败（HTTP ${res.status}）：${url}`)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > bytes.length) throw new BlobError(`文件大小超出预期：${url}`)
      bytes.set(value, offset)
      offset += value.length
      const now = performance.now()
      if (now - lastReport > 100) {
        lastReport = now
        onProgress?.(offset, spec.size)
      }
    }
  }
  if (offset !== spec.size) throw new BlobError(`文件不完整：期望 ${spec.size} 字节，实际 ${offset} 字节`)
  onProgress?.(offset, spec.size)
  if ((await sha256Hex(bytes)) !== spec.sha256) throw new BlobError('文件校验失败（SHA-256 不匹配），下载源返回的内容与清单不一致')

  try {
    await cache?.put(key, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream', [SIZE_HEADER]: String(bytes.length) } }))
  } catch {
    // 存储配额不足等情况下仍可继续使用，只是下次需要重新下载
  }
  return { bytes, fromCache: false }
}

/** 删除所有缓存的模型和运行时。 */
export async function clearBlobCache(): Promise<boolean> {
  try {
    return typeof caches !== 'undefined' && (await caches.delete(CACHE_NAME))
  } catch {
    return false
  }
}

/** 已缓存文件的总字节数。 */
export async function cachedBytes(): Promise<number> {
  const cache = await openCache()
  if (!cache) return 0
  let total = 0
  for (const req of await cache.keys()) {
    const res = await cache.match(req)
    total += Number(res?.headers.get(SIZE_HEADER) ?? 0) || 0
  }
  return total
}
