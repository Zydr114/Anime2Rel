// 图像资源登记表。ImageBitmap 不可序列化，因此不放进 store；文档只保存资源 id。
// 撤销/重做可能会切回旧资源，所以会话期间不主动释放。
// 每个资源同时保留导入时的原始文件：工程保存时原样写入，导出时按原图分辨率重新解码。

export interface AssetRef {
  id: string
  name: string
  width: number
  height: number
  /** 原图尺寸超过 GPU 纹理上限时会被缩小，这里记录原始尺寸 */
  sourceWidth: number
  sourceHeight: number
  hasTransparency: boolean
}

export interface Asset extends AssetRef {
  bitmap: ImageBitmap
  /** 导入时的原始文件 */
  source: Blob
}

const assets = new Map<string, Asset>()
const hashes = new Map<string, Promise<string>>()
let counter = 0

export function registerAsset(bitmap: ImageBitmap, source: Blob, meta: Omit<AssetRef, 'id' | 'width' | 'height'>): AssetRef {
  const id = `asset-${++counter}`
  assets.set(id, { ...meta, id, width: bitmap.width, height: bitmap.height, bitmap, source })
  return { ...meta, id, width: bitmap.width, height: bitmap.height }
}

export function getAsset(id: string): Asset | undefined {
  return assets.get(id)
}

/** 原始文件内容的哈希（十六进制），用于工程文件和自动保存中去重 */
export function assetHash(id: string): Promise<string> {
  const asset = assets.get(id)
  if (!asset) return Promise.reject(new Error(`未知的资源 ${id}`))
  let hash = hashes.get(id)
  if (!hash) hashes.set(id, (hash = hashBlob(asset.source)))
  return hash
}

/** SHA-256；非安全上下文（例如用局域网 IP 通过 http 访问）没有 crypto.subtle，退回 FNV-1a 加文件长度 */
export async function hashBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193)
  return `fnv-${(h >>> 0).toString(16).padStart(8, '0')}-${bytes.length.toString(16)}`
}
