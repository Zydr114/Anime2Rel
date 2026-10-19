// 浏览器本地存储（IndexedDB）：自动保存的工程、工程用到的素材原图、导入的预设、自定义光晕。
// 素材按内容哈希保存，多次自动保存之间不重复写入；不再被引用的素材在下次保存时删除。
import { createStore, delMany, get, keys, set, setMany, type UseStore } from 'idb-keyval'

const AUTOSAVE = 'autosave'
const PRESETS = 'presets'
const FLARES = 'flares'
const ASSET_PREFIX = 'asset:'

export interface AutosaveRecord {
  /** 工程清单（project.json 的文本） */
  manifest: string
  savedAt: number
  /** 背景照片的文件名，首屏上用于提示 */
  name: string
  /** 背景照片的缩略图（JPEG） */
  thumbnail: Blob | null
}

let store: UseStore | null = null
const db = () => (store ??= createStore('anime2real', 'store'))

/** 在本次会话中已确认存在于数据库中的素材 */
let storedAssets: Set<string> | null = null

async function knownAssets(): Promise<Set<string>> {
  if (!storedAssets) {
    const all = await keys<string>(db())
    storedAssets = new Set(all.filter((k) => typeof k === 'string' && k.startsWith(ASSET_PREFIX)).map((k) => k.slice(ASSET_PREFIX.length)))
  }
  return storedAssets
}

/** 写入自动保存：先补上缺少的素材，与清单一起原子写入，再删除不再引用的素材 */
export async function writeAutosave(record: AutosaveRecord, assets: Map<string, Blob>): Promise<void> {
  const known = await knownAssets()
  const missing = [...assets].filter(([key]) => !known.has(key))
  await setMany([...missing.map(([key, blob]): [string, Blob] => [ASSET_PREFIX + key, blob]), [AUTOSAVE, record]], db())
  for (const [key] of missing) known.add(key)
  const unused = [...known].filter((key) => !assets.has(key))
  if (unused.length) {
    await delMany(unused.map((key) => ASSET_PREFIX + key), db())
    for (const key of unused) known.delete(key)
  }
}

export function readAutosave(): Promise<AutosaveRecord | undefined> {
  return get<AutosaveRecord>(AUTOSAVE, db())
}

export function readAsset(key: string): Promise<Blob | undefined> {
  return get<Blob>(ASSET_PREFIX + key, db())
}

/** 导入的预设（预设文件的文本） */
export async function readPresets(): Promise<string[]> {
  const list = await get<unknown>(PRESETS, db())
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
}

export function writePresets(list: string[]): Promise<void> {
  return set(PRESETS, list, db())
}

/** 自定义光晕（未经检查的对象，由调用方逐项检查） */
export async function readFlares(): Promise<unknown[]> {
  const list = await get<unknown>(FLARES, db())
  return Array.isArray(list) ? list : []
}

export function writeFlares(list: unknown[]): Promise<void> {
  return set(FLARES, list, db())
}
