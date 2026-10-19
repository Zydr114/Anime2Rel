import { useRef } from 'react'
import { DEFAULT_GRADE } from '@/grade/model'
import { DEFAULT_POST } from '@/grade/post'
import { BUILTIN_PRESET_IDS, BUILTIN_PRESETS, matchesPreset, parsePreset, PresetError, serializePreset, type Preset } from '@/grade/preset'
import { t } from '@/i18n'
import { downloadBlob } from '@/io/encode'
import { usePresets } from '@/state/presets'
import { useApp } from '@/state/store'
import { cn } from '@/ui/lib/cn'
import { askText, notify } from '../notify'
import { Hint, Section } from './FusionSections'

/** 文件名中不能使用的字符 */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|]/g

function apply(preset: Pick<Preset, 'grade' | 'post'>) {
  useApp.getState().applyPreset(preset)
}

async function importPreset(file: File) {
  try {
    const preset = parsePreset(await file.text(), file.name.replace(/\.json$/i, ''))
    usePresets.getState().add(preset)
    apply(preset)
    notify(t.presets.applied(preset.name))
  } catch (e) {
    if (!(e instanceof PresetError)) console.error(e)
    notify(t.presets.importError(file.name, e instanceof PresetError ? e.message : t.presets.unreadable))
  }
}

async function exportPreset() {
  const name = (await askText(t.presets.exportName, t.presets.defaultName, t.presets.exportConfirm, t.presets.cancel))?.trim()
  if (!name) return
  const { grade, post } = useApp.getState().doc
  const text = serializePreset({ name, grade, post })
  downloadBlob(new Blob([text], { type: 'application/json' }), `${name.replace(UNSAFE_FILE_CHARS, '_')}.json`)
}

function PresetItem({ name, description, active, onClick, testId }: { name: string; description?: string; active: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      className={cn('flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left transition-colors', active ? 'bg-primary/20' : 'bg-white/5 hover:bg-white/10')}
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
    >
      <span className="flex items-center gap-1 font-medium">
        {name}
        {active && <mdui-icon-check-circle--outlined className="size-4 text-primary" />}
      </span>
      {description && <span className="text-xs leading-5 text-on-surface-variant">{description}</span>}
    </button>
  )
}

/** 预设：内置预设、本次导入的预设，以及预设文件的导入导出 */
export function PresetSections() {
  const grade = useApp((s) => s.doc.grade)
  const post = useApp((s) => s.doc.post)
  const imported = usePresets((s) => s.imported)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Hint>{t.presets.hint}</Hint>
      <Section title={t.presets.builtin} testId="presets-builtin">
        {BUILTIN_PRESET_IDS.map((id) => (
          <PresetItem
            key={id}
            name={t.presets.names[id]}
            description={t.presets.descriptions[id]}
            active={matchesPreset(grade, post, BUILTIN_PRESETS[id])}
            onClick={() => apply(BUILTIN_PRESETS[id])}
            testId={`preset-${id}`}
          />
        ))}
      </Section>
      {imported.length > 0 && (
        <Section title={t.presets.imported} testId="presets-imported">
          {imported.map((p, i) => (
            <PresetItem key={p.name} name={p.name} active={matchesPreset(grade, post, p)} onClick={() => apply(p)} testId={`preset-imported-${i}`} />
          ))}
          <Hint>{t.presets.importedHint}</Hint>
        </Section>
      )}
      <Section title={t.presets.file} testId="presets-file">
        <div className="flex flex-wrap gap-2">
          <mdui-button variant="tonal" onClick={() => inputRef.current?.click()} data-testid="preset-import">
            <mdui-icon-upload--outlined slot="icon" />
            {t.presets.import}
          </mdui-button>
          <mdui-button variant="tonal" onClick={() => void exportPreset()} data-testid="preset-export">
            <mdui-icon-download--outlined slot="icon" />
            {t.presets.export}
          </mdui-button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0]
            e.currentTarget.value = ''
            if (file) void importPreset(file)
          }}
          data-testid="preset-file"
        />
        <Hint>{t.presets.fileHint}</Hint>
      </Section>
      <mdui-button variant="text" onClick={() => apply({ grade: DEFAULT_GRADE, post: DEFAULT_POST })} data-testid="preset-clear">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.presets.clear}
      </mdui-button>
    </>
  )
}
