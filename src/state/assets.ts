// 图像资源登记表。ImageBitmap 不可序列化，因此不放进 store；文档只保存资源 id。
// 撤销/重做可能会切回旧资源，所以会话期间不主动释放。

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
}

const assets = new Map<string, Asset>()
let counter = 0

export function registerAsset(bitmap: ImageBitmap, meta: Omit<AssetRef, 'id' | 'width' | 'height'>): AssetRef {
  const id = `asset-${++counter}`
  const asset: Asset = { ...meta, id, width: bitmap.width, height: bitmap.height, bitmap }
  assets.set(id, asset)
  const { bitmap: _bitmap, ...ref } = asset
  void _bitmap
  return ref
}

export function getAsset(id: string): Asset | undefined {
  return assets.get(id)
}
