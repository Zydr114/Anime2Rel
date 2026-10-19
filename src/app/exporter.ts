import { t } from '@/i18n'
import { canEncode, createImageWriter, downloadBlob, FORMAT_EXTENSION, timestampedName } from '@/io/encode'
import { useEngine } from '@/state/engine'
import { isExporting, useExport } from '@/state/export'
import { notify } from './notify'

let controller: AbortController | null = null

/** 以背景原图的分辨率导出为选定的格式并触发下载；进度写入 useExport。 */
export async function exportImage(): Promise<void> {
  const engine = useEngine.getState().engine
  const size = engine?.exportSize()
  if (!engine || !size || isExporting()) return
  const { format, quality, setProgress } = useExport.getState()
  if (!canEncode(format, size.width, size.height)) {
    notify(t.export.tooLarge(t.export.formats[format], size.width, size.height))
    return
  }
  controller = new AbortController()
  setProgress(0)
  try {
    const writer = createImageWriter(format, size.width, size.height, quality)
    await engine.renderExport({
      onBand: (band) => writer.write(band.pixels, band.y, band.height),
      onProgress: (done, total) => setProgress(done / total),
      signal: controller.signal,
    })
    const blob = await writer.finish()
    downloadBlob(blob, timestampedName('anime2real', FORMAT_EXTENSION[format]))
    notify(t.export.done)
  } catch (e) {
    if (controller.signal.aborted) notify(t.export.cancelled)
    else notify(`${t.export.failed}：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    controller = null
    setProgress(null)
  }
}

export function cancelExport(): void {
  controller?.abort()
}
