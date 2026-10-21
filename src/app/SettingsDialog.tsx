import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dialog } from 'mdui/components/dialog.js'
import { MODEL_SOURCES, PRECISIONS } from '@/depth/models'
import { clearModelCache, modelCacheSize, reloadDepth } from '@/depth/service'
import { t } from '@/i18n'
import { THEME_CHOICES, useAppearance } from '@/state/appearance'
import { useDepth, type DepthSettings } from '@/state/depth'
import { useSettingsDialog } from '@/state/dialogs'
import { usePrefs } from '@/state/prefs'
import { glassMode } from '@/ui/glass/liquid'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { useDomEvent } from '@/ui/useDomEvent'
import { useDialogEscape } from '@/ui/useDialogEscape'
import { notify } from './notify'
import { Hint, ToggleRow } from './panels/Group'

const formatBytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** 设置（docs/Plan.md §3.7 M8.7）：外观、操作提示、深度模型。都记在浏览器中，不进工程文件 */
export function SettingsDialog() {
  const ref = useRef<Dialog>(null)
  const open = useSettingsDialog((s) => s.open)
  const opHints = usePrefs((s) => s.opHints)
  const close = useCallback(() => useSettingsDialog.getState().setOpen(false), [])
  useDomEvent(ref, 'closed', (e, el) => e.target === el && close())
  useDialogEscape(ref, open, close)

  return (
    <mdui-dialog ref={ref} open={open} close-on-overlay-click close-on-esc headline={t.settings.title} data-testid="settings">
      <div className="flex w-[22rem] max-w-full flex-col gap-5 text-sm leading-6">
        <AppearanceSection />
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">{t.settings.hints}</h3>
          <ToggleRow label={t.settings.opHints} checked={opHints} onChange={(opHints) => usePrefs.getState().setPrefs({ opHints })} testId="settings-op-hints" />
          <Hint>{t.settings.opHintsHint}</Hint>
        </section>
        <DepthModelSection />
      </div>
      <mdui-button slot="action" variant="text" onClick={close}>
        {t.about.close}
      </mdui-button>
    </mdui-dialog>
  )
}

function AppearanceSection() {
  const reduceEffects = useAppearance((s) => s.reduceEffects)
  const theme = useAppearance((s) => s.theme)
  const mode = glassMode()
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-medium">{t.settings.appearance}</h3>
      <div className="mb-2 flex items-center gap-3">
        <span className="shrink-0">{t.settings.theme}</span>
        <Segmented value={theme} options={THEME_CHOICES} label={(v) => t.settings.themes[v]} onChange={useAppearance.getState().setTheme} testId="settings-theme" />
      </div>
      <ToggleRow label={t.settings.reduceEffects} checked={reduceEffects} onChange={useAppearance.getState().setReduceEffects} testId="reduce-effects" />
      <Hint>{t.settings.reduceEffectsHint}</Hint>
      {mode && (
        <Hint>
          <span data-testid="glass-mode" data-mode={mode}>
            {t.settings.glass(t.settings.glassModes[mode])}
          </span>
        </Hint>
      )}
    </section>
  )
}

/** 深度模型：模型源、推理方式、精度，改动后重新加载模型 */
function DepthModelSection() {
  const settings = useDepth((s) => s.settings)
  const modelState = useDepth((s) => s.model.state)
  const [cache, setCache] = useState<number | null>(null)

  // 模型就绪或清除缓存后刷新缓存大小
  useEffect(() => {
    let alive = true
    modelCacheSize().then(
      (n) => alive && setCache(n),
      () => alive && setCache(null),
    )
    return () => {
      alive = false
    }
  }, [modelState])

  const change = (update: Partial<DepthSettings>) => {
    useDepth.getState().setSettings(update)
    reloadDepth()
  }

  const clear = async () => {
    if (await clearModelCache()) notify(t.depth.cacheCleared)
    setCache(0)
  }

  return (
    <section className="flex flex-col gap-3" data-testid="depth-settings">
      <h3 className="font-medium">{t.depth.settings}</h3>
      <SelectField
        label={t.depth.source}
        value={settings.source}
        options={MODEL_SOURCES.map((s) => ({ value: s, label: t.depth.sources[s] }))}
        onChange={(source) => change({ source })}
        testId="depth-source"
      />
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label={t.depth.device}
          value={settings.device}
          options={(['auto', 'webgpu', 'wasm'] as const).map((d) => ({ value: d, label: t.depth.devices[d] }))}
          onChange={(device) => change({ device })}
          testId="depth-device"
        />
        <SelectField
          label={t.depth.precision}
          value={settings.precision}
          options={[{ value: 'auto' as const, label: t.depth.auto }, ...PRECISIONS.map((p) => ({ value: p, label: p }))]}
          onChange={(precision) => change({ precision })}
          testId="depth-precision"
        />
      </div>
      <Hint>{t.depth.settingsHint}</Hint>
      <div className="flex items-center justify-between">
        <span className="text-on-surface-variant" data-testid="depth-cache">
          {cache === null ? '' : t.depth.cache(formatBytes(cache))}
        </span>
        <mdui-button variant="text" onClick={clear} data-testid="depth-clear-cache">
          <mdui-icon-delete-sweep--outlined slot="icon" />
          {t.depth.clearCache}
        </mdui-button>
      </div>
    </section>
  )
}
