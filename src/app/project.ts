// 工程的保存、打开与自动保存（docs/Plan.md §6.1 第 8 步）。清单格式与字段检查见 src/state/project.ts。
import { fitWithin } from '@/algo/geometry'
import { t } from '@/i18n'
import { decodeImage } from '@/io/decode'
import { downloadBlob } from '@/io/encode'
import { readAsset, readAutosave, writeAutosave, type AutosaveRecord } from '@/io/storage'
import { readZip, writeZip } from '@/io/zip'
import { assetHash, getAsset, registerAsset, type AssetRef } from '@/state/assets'
import { textureLimit, useEngine } from '@/state/engine'
import { conformProject, manifestAssets, manifestSlots, manifestStep, MANIFEST_NAME, ProjectError, projectManifest, readManifest, type ProjectAsset } from '@/state/project'
import { useApp, type DocState, type StepId } from '@/state/store'
import { ask, notify } from './notify'

export const PROJECT_EXTENSION = '.a2r'
/** 停止编辑多久后自动保存（毫秒） */
const AUTOSAVE_DELAY = 1000
const THUMBNAIL_EDGE = 160

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 素材在工程文件中的路径：内容哈希加原文件的扩展名，解压后可以直接打开 */
function assetPath(asset: ProjectAsset): string {
  const ext = /\.[a-z0-9]{1,5}$/i.exec(asset.name)?.[0].toLowerCase() ?? ''
  return `assets/${asset.key}${ext}`
}

async function projectAsset(ref: AssetRef): Promise<[ProjectAsset, Blob]> {
  const asset = getAsset(ref.id)
  if (!asset) throw new ProjectError(`找不到素材 ${ref.name}`)
  return [{ key: await assetHash(ref.id), name: ref.name, type: asset.source.type }, asset.source]
}

/** 当前文档 → 清单与素材原图（按 key） */
async function snapshot(doc: DocState, step: StepId) {
  if (!doc.background) throw new ProjectError('还没有背景照片')
  const [background, backgroundFile] = await projectAsset(doc.background)
  const character = doc.character ? await projectAsset(doc.character) : null
  const manifest = projectManifest(doc, step, { background, character: character?.[0] ?? null })
  const files = new Map<string, { asset: ProjectAsset; blob: Blob }>([[background.key, { asset: background, blob: backgroundFile }]])
  if (character) files.set(character[0].key, { asset: character[0], blob: character[1] })
  return { manifest, files }
}

function engineReady(): Promise<void> {
  if (useEngine.getState().status !== 'loading') return Promise.resolve()
  return new Promise((resolve) => {
    const off = useEngine.subscribe((s) => {
      if (s.status === 'loading') return
      off()
      resolve()
    })
  })
}

/** 按清单重新登记素材并替换文档。file 按清单中的素材取出原始文件 */
async function restore(manifestText: string, file: (asset: ProjectAsset) => Promise<Blob | undefined>): Promise<void> {
  const manifest = readManifest(manifestText)
  const slots = manifestSlots(manifest)
  if (!slots.background) throw new ProjectError('工程中没有背景照片')
  const assets = new Map(manifestAssets(manifest).map((a) => [a.key, a]))
  await engineReady()
  const load = async (key: string): Promise<AssetRef> => {
    const asset = assets.get(key) ?? { key, name: 'image', type: '' }
    const blob = await file(asset)
    if (!blob) throw new ProjectError(`工程中缺少素材 ${asset.name}`)
    const source = new File([blob], asset.name, { type: asset.type || blob.type })
    const img = await decodeImage(source, textureLimit())
    return registerAsset(img.bitmap, source, { name: asset.name, sourceWidth: img.sourceWidth, sourceHeight: img.sourceHeight, hasTransparency: img.hasTransparency })
  }
  const background = await load(slots.background)
  const character = slots.character ? await load(slots.character) : null
  useApp.getState().loadDoc(conformProject(manifest, { background, character }), manifestStep(manifest))
  // 打开的工程立即成为自动保存的内容
  scheduleAutosave(0)
}

/** 编辑器中已有内容时，打开工程前请用户确认 */
async function confirmReplace(): Promise<boolean> {
  const { started, doc } = useApp.getState()
  if (!started || !doc.background) return true
  return ask(t.project.replaceTitle, t.project.replaceBody, t.project.replaceConfirm, t.project.cancel)
}

// ── 工程文件 ──

export async function saveProjectFile(): Promise<void> {
  const { doc, step } = useApp.getState()
  try {
    const { manifest, files } = await snapshot(doc, step)
    const entries = [
      { name: MANIFEST_NAME, data: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) },
      ...[...files.values()].map(({ asset, blob }) => ({ name: assetPath(asset), data: blob })),
    ]
    const zip = await writeZip(entries, 'application/x-anime2real-project')
    const stem = doc.background!.name.replace(/\.[^.]*$/, '') || 'anime2real'
    downloadBlob(zip, stem + PROJECT_EXTENSION)
    notify(t.project.saved)
  } catch (e) {
    notify(`${t.project.saveFailed}：${message(e)}`)
  }
}

export const isProjectFile = (file: File) => file.name.toLowerCase().endsWith(PROJECT_EXTENSION)

/** 打开 .a2r 工程文件；成功时返回 true */
export async function openProjectFile(file: Blob): Promise<boolean> {
  if (!(await confirmReplace())) return false
  try {
    const zip = await readZip(file)
    const manifest = zip.get(MANIFEST_NAME)
    if (!manifest) throw new ProjectError('工程文件中没有 project.json')
    await restore(await (await manifest()).text(), async (asset) => zip.get(assetPath(asset))?.())
    return true
  } catch (e) {
    notify(`${t.project.openFailed}：${message(e)}`)
    return false
  }
}

export function pickProjectFile(onOpened?: () => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = PROJECT_EXTENSION
  input.onchange = async () => {
    const file = input.files?.[0]
    if (file && (await openProjectFile(file))) onOpened?.()
  }
  input.click()
}

// ── 自动保存 ──

export interface AutosaveInfo {
  name: string
  savedAt: Date
  thumbnail: Blob | null
}

export async function lastAutosave(): Promise<AutosaveInfo | null> {
  try {
    const record = await readAutosave()
    return record ? { name: record.name, savedAt: new Date(record.savedAt), thumbnail: record.thumbnail } : null
  } catch {
    return null
  }
}

/** 恢复自动保存的工程；成功时返回 true */
export async function restoreAutosave(): Promise<boolean> {
  try {
    const record = await readAutosave()
    if (!record) throw new ProjectError('没有自动保存的工程')
    await restore(record.manifest, (asset) => readAsset(asset.key))
    return true
  } catch (e) {
    notify(`${t.project.openFailed}：${message(e)}`)
    return false
  }
}

let thumbnail: { id: string; blob: Promise<Blob | null> } | null = null

function backgroundThumbnail(ref: AssetRef): Promise<Blob | null> {
  if (thumbnail?.id !== ref.id) {
    const bitmap = getAsset(ref.id)?.bitmap
    const size = fitWithin(ref, THUMBNAIL_EDGE)
    let blob: Promise<Blob | null> = Promise.resolve(null)
    if (bitmap) {
      const canvas = new OffscreenCanvas(size.width, size.height)
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height)
      blob = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }).catch(() => null)
    }
    thumbnail = { id: ref.id, blob }
  }
  return thumbnail.blob
}

let timer: ReturnType<typeof setTimeout> | null = null
/** 正在写入时又有修改，写完后再保存一次 */
let writing = false
let pending = false
let failed = false

async function autosave(): Promise<void> {
  if (writing) {
    pending = true
    return
  }
  const { doc, step, started, gestureBase } = useApp.getState()
  if (!started || !doc.background) return
  if (gestureBase) return scheduleAutosave()
  writing = true
  try {
    const { manifest, files } = await snapshot(doc, step)
    const record: AutosaveRecord = { manifest: JSON.stringify(manifest), savedAt: Date.now(), name: doc.background.name, thumbnail: await backgroundThumbnail(doc.background) }
    await writeAutosave(record, new Map([...files].map(([key, f]) => [key, f.blob])))
    failed = false
  } catch (e) {
    // 只提示一次，避免每次修改都弹出
    if (!failed) notify(`${t.project.autosaveFailed}：${message(e)}`)
    failed = true
  } finally {
    writing = false
    if (pending) {
      pending = false
      scheduleAutosave()
    }
  }
}

function scheduleAutosave(delay = AUTOSAVE_DELAY): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void autosave()
  }, delay)
}

/** 编辑器打开期间，文档或当前步骤变化后自动保存；返回取消订阅函数 */
export function startAutosave(): () => void {
  scheduleAutosave(0)
  const off = useApp.subscribe((s, prev) => {
    if (s.doc !== prev.doc || s.step !== prev.step || (prev.gestureBase && !s.gestureBase)) scheduleAutosave()
  })
  // 切到后台或关闭页面前尽量写入最新的修改
  const flush = () => {
    if (document.visibilityState === 'hidden' && timer) scheduleAutosave(0)
  }
  document.addEventListener('visibilitychange', flush)
  return () => {
    off()
    document.removeEventListener('visibilitychange', flush)
  }
}
