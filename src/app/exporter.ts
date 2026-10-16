import { t } from '@/i18n'
import { downloadBlob, encodePng, timestampedName } from '@/io/encode'
import { useEngine } from '@/state/engine'
import { notify } from './notify'

/** 以背景原分辨率导出 PNG 并触发下载。 */
export async function exportPng(): Promise<void> {
  const engine = useEngine.getState().engine
  if (!engine) return
  try {
    const img = await engine.renderFullResolution()
    const blob = await encodePng(img.pixels, img.width, img.height)
    downloadBlob(blob, timestampedName('anime2rel', 'png'))
    notify(t.export.done)
  } catch (e) {
    notify(`${t.export.failed}：${e instanceof Error ? e.message : String(e)}`)
  }
}
