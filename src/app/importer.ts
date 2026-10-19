import { t } from '@/i18n'
import { DecodeError, decodeImage, type DecodedImage } from '@/io/decode'
import { registerAsset } from '@/state/assets'
import { textureLimit, whenEngineReady } from '@/state/engine'
import { useApp } from '@/state/store'
import { ask, notify } from './notify'
import { isProjectFile, openProjectFile } from './project'

export type ImportRole = 'background' | 'character' | 'auto'

function reportError(e: unknown): void {
  if (e instanceof DecodeError) {
    if (e.kind === 'heic') notify(t.import.heic(e.fileName))
    else if (e.kind === 'not-image') notify(t.import.notImage(e.fileName))
    else notify(t.import.decodeFailed(e.fileName))
  } else {
    notify(String(e))
  }
}

async function apply(img: DecodedImage, file: File, role: 'background' | 'character'): Promise<void> {
  if (role === 'character' && !img.hasTransparency) {
    const ok = await ask(t.import.noTransparencyTitle, t.import.noTransparencyBody, t.import.useAnyway, t.import.cancel)
    if (!ok) {
      img.bitmap.close()
      return
    }
  }
  if (img.downscaled) notify(t.import.downscaled(img.sourceWidth, img.sourceHeight, textureLimit()))
  const ref = registerAsset(img.bitmap, file, {
    name: img.name,
    sourceWidth: img.sourceWidth,
    sourceHeight: img.sourceHeight,
    hasTransparency: img.hasTransparency,
  })
  if (role === 'background') useApp.getState().setBackground(ref)
  else useApp.getState().setCharacter(ref)
}

/**
 * 导入图片。role 为 auto 时：带透明区域的图片作为立绘，否则作为背景。
 * 一次导入多张时，每种角色只取第一张。其中有工程文件（.a2r）时改为打开工程。
 */
export async function importFiles(files: Iterable<File>, role: ImportRole): Promise<void> {
  // 拖入或粘贴的工程文件直接打开
  const project = Array.from(files).find(isProjectFile)
  if (project) {
    if (await openProjectFile(project)) useApp.getState().start()
    return
  }
  const list = Array.from(files).filter((f) => !f.type || f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))
  if (list.length === 0) {
    const first = Array.from(files)[0]
    if (first) notify(t.import.notImage(first.name))
    return
  }
  await whenEngineReady()
  const used = new Set<string>()
  for (const file of list) {
    let img: DecodedImage
    try {
      img = await decodeImage(file, textureLimit())
    } catch (e) {
      reportError(e)
      continue
    }
    const target = role === 'auto' ? (img.hasTransparency ? 'character' : 'background') : role
    if (used.has(target)) {
      img.bitmap.close()
      continue
    }
    used.add(target)
    await apply(img, file, target)
    if (role !== 'auto') break
  }
}

export function pickFiles(role: ImportRole): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,.heic,.heif'
  input.onchange = () => {
    if (input.files?.length) void importFiles(input.files, role)
  }
  input.click()
}
