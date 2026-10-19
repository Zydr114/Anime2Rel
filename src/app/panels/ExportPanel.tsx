import { t } from '@/i18n'
import { IMAGE_FORMATS } from '@/io/encode'
import { useExport } from '@/state/export'
import { useApp } from '@/state/store'
import { ShimmerButton } from '@/ui/magicui/shimmer-button'
import { Segmented } from '@/ui/Segmented'
import { SliderField } from '@/ui/SliderField'
import { cancelExport, exportImage } from '../exporter'
import { pickProjectFile, saveProjectFile } from '../project'

const percent = (v: number) => `${Math.round(v)}%`

export function ExportPanel() {
  const background = useApp((s) => s.doc.background)
  const { format, quality, progress, setFormat, setQuality } = useExport()
  if (!background) return null
  const busy = progress !== null
  const downscaled = background.sourceWidth !== background.width || background.sourceHeight !== background.height

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3">
        <Segmented value={format} options={IMAGE_FORMATS} label={(f) => t.export.formats[f]} onChange={setFormat} testId="export-format" />
        <p className="text-xs leading-5 text-on-surface-variant">{t.export.formatHints[format]}</p>
        {format !== 'png' && (
          <SliderField label={t.export.quality} value={quality * 100} min={50} max={100} format={percent} onChange={(v) => setQuality(v / 100)} testId="export-quality" />
        )}
        <div className="text-sm leading-6" data-testid="export-resolution">
          {t.export.resolution(background.sourceWidth, background.sourceHeight)}
        </div>
        {downscaled && <p className="text-xs leading-5 text-on-surface-variant">{t.export.downscaled(background.width, background.height)}</p>}
      </section>
      <ShimmerButton
        className="w-full text-sm font-medium"
        background="rgb(var(--mdui-color-primary-container))"
        shimmerColor="rgb(var(--mdui-color-primary))"
        onClick={() => void exportImage()}
        disabled={busy}
        data-testid="export-image"
      >
        {busy ? t.export.working(Math.round(progress * 100)) : t.export.action(t.export.formats[format])}
      </ShimmerButton>
      {busy && (
        <div className="flex items-center gap-3">
          <mdui-linear-progress value={progress} className="flex-1" data-testid="export-progress" />
          <mdui-button variant="text" onClick={cancelExport} data-testid="export-cancel">
            {t.export.cancel}
          </mdui-button>
        </div>
      )}

      <section className="mt-1 flex flex-col gap-3 rounded-2xl bg-white/5 p-3">
        <h3 className="text-sm font-medium">{t.project.title}</h3>
        <p className="text-xs leading-5 text-on-surface-variant">{t.project.hint}</p>
        <mdui-button variant="tonal" onClick={() => void saveProjectFile()} data-testid="save-project">
          <mdui-icon-save--outlined slot="icon" />
          {t.project.save}
        </mdui-button>
        <mdui-button variant="outlined" onClick={() => pickProjectFile()} data-testid="open-project-editor">
          <mdui-icon-folder-open--outlined slot="icon" />
          {t.project.open}
        </mdui-button>
      </section>
    </div>
  )
}
