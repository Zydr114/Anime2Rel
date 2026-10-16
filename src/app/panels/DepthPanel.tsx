import { useCallback, useEffect, useRef, useState } from 'react'
import type { SegmentedButtonGroup } from 'mdui/components/segmented-button-group.js'
import type { Switch } from 'mdui/components/switch.js'
import { clearModelCache, modelCacheSize, reestimate, reloadDepth } from '@/depth/service'
import { MODEL_SOURCES, PRECISIONS, type Attempt } from '@/depth/models'
import { t } from '@/i18n'
import { DEBUG_VIEWS, useDepth, type DebugView, type DepthSettings, type JobStatus } from '@/state/depth'
import { useApp } from '@/state/store'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { useDomEvent } from '@/ui/useDomEvent'
import { notify } from '../notify'

const DEVICE_LABEL = { webgpu: 'WebGPU', wasm: 'WASM' } as const

function formatBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function attemptLabel(a: Attempt): string {
  return t.depth.ready(DEVICE_LABEL[a.device], a.precision)
}

const formatPercent = (v: number) => `${Math.round(v)}%`

export function DepthPanel() {
  return (
    <div className="flex flex-col gap-4">
      <ModelSection />
      <JobsSection />
      <ViewSection />
      <SettingsSection />
    </div>
  )
}

function ModelSection() {
  const model = useDepth((s) => s.model)
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3 text-sm" data-testid="depth-model">
      <h3 className="font-medium">{t.depth.model}</h3>
      {model.state === 'idle' && <div className="text-on-surface-variant">{t.depth.idle}</div>}
      {model.state === 'loading' && (
        <>
          <div className="text-on-surface-variant" data-testid="depth-model-loading">
            {t.depth.phase[model.phase]}
            {model.attempt && `（${attemptLabel(model.attempt)}）`}
          </div>
          {model.total > 0 ? <mdui-linear-progress value={model.loaded} max={model.total} /> : <mdui-linear-progress />}
          {model.total > 0 && (
            <div className="text-right text-xs text-on-surface-variant tabular-nums">{t.depth.progress(formatBytes(model.loaded), formatBytes(model.total))}</div>
          )}
        </>
      )}
      {model.state === 'ready' && (
        <>
          <div className="flex items-center gap-2" data-testid="depth-model-ready">
            <mdui-icon-check-circle--outlined className="size-5 text-primary" />
            <span className="font-medium">{attemptLabel(model.info)}</span>
          </div>
          <div className="text-xs leading-5 text-on-surface-variant">
            <div>{t.depth.readyDetail(model.info.fromCache, formatMs(model.info.loadMs), formatMs(model.info.initMs))}</div>
            {model.info.device === 'wasm' && <div>{t.depth.threads(model.info.threads)}</div>}
          </div>
          <Failures failures={model.info.failures} title={t.depth.fallback} />
        </>
      )}
      {model.state === 'error' && (
        <>
          <div className="flex items-center gap-2 text-error">
            <mdui-icon-error--outlined className="size-5" />
            <span>{t.depth.failed}</span>
          </div>
          <div className="text-xs leading-5 break-words text-on-surface-variant">{model.message}</div>
          <Failures failures={model.failures} />
          <mdui-button variant="tonal" onClick={reloadDepth} data-testid="depth-retry">
            <mdui-icon-refresh--outlined slot="icon" />
            {t.depth.retry}
          </mdui-button>
        </>
      )}
    </section>
  )
}

function Failures({ failures, title }: { failures: { attempt: Attempt; message: string }[]; title?: string }) {
  if (failures.length === 0) return null
  return (
    <div className="text-xs leading-5 text-on-surface-variant" data-testid="depth-failures">
      {title && <div>{title}</div>}
      <ul className="list-inside list-disc">
        {failures.map((f, i) => (
          <li key={i} className="break-words">
            {attemptLabel(f.attempt)}：{f.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

function jobText(job: JobStatus | undefined): string {
  if (!job) return t.depth.job.none
  if (job.state === 'queued') return t.depth.job.queued
  if (job.state === 'running') return t.depth.job.running
  if (job.state === 'error') return job.message
  return t.depth.timings(formatMs(job.timings.inference), formatMs(job.timings.prepare + job.timings.post))
}

function JobsSection() {
  const background = useApp((s) => s.doc.background)
  const character = useApp((s) => s.doc.character)
  const jobs = useDepth((s) => s.jobs)
  const rows = [
    { key: 'background', label: t.depth.background, asset: background },
    { key: 'character', label: t.depth.character, asset: character },
  ].filter((r) => r.asset)

  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white/5 p-3 text-sm">
      <h3 className="font-medium">{t.depth.jobs}</h3>
      {rows.map((r) => {
        const job = jobs[r.asset!.id]
        return (
          <div key={r.key} className="flex justify-between gap-3" data-testid={`depth-job-${r.key}`} data-state={job?.state ?? 'none'}>
            <span className="shrink-0 text-on-surface-variant">{r.label}</span>
            <span className={job?.state === 'error' ? 'text-right text-error' : 'text-right tabular-nums'}>{jobText(job)}</span>
          </div>
        )
      })}
      <mdui-button variant="text" onClick={reestimate} data-testid="depth-reestimate">
        <mdui-icon-refresh--outlined slot="icon" />
        {t.depth.reestimate}
      </mdui-button>
    </section>
  )
}

function ViewSection() {
  const view = useDepth((s) => s.view)
  const overlay = useDepth((s) => s.overlay)
  const edgeAlign = useDepth((s) => s.edgeAlign)
  const setView = useDepth((s) => s.setView)
  const setOverlay = useDepth((s) => s.setOverlay)
  const setEdgeAlign = useDepth((s) => s.setEdgeAlign)
  const groupRef = useRef<SegmentedButtonGroup>(null)
  const switchRef = useRef<Switch>(null)

  useDomEvent(groupRef, 'change', (_e, el) => {
    const v = el.value as DebugView
    // 单选组再次点击会取消选中，恢复原值
    if (v) setView(v)
    else el.value = view
  })
  useDomEvent(switchRef, 'change', (_e, el) => setEdgeAlign(el.checked))
  const onOverlay = useCallback((v: number) => setOverlay(v / 100), [setOverlay])

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3 text-sm">
      <h3 className="font-medium">{t.depth.view}</h3>
      <mdui-segmented-button-group ref={groupRef} selects="single" value={view} full-width data-testid="depth-view">
        {DEBUG_VIEWS.map((v) => (
          <mdui-segmented-button key={v} value={v}>
            {t.depth.views[v]}
          </mdui-segmented-button>
        ))}
      </mdui-segmented-button-group>
      <SliderField label={t.depth.overlay} value={overlay * 100} min={0} max={100} format={formatPercent} onChange={onOverlay} testId="depth-overlay" />
      <div className="flex items-center justify-between">
        <span>{t.depth.edgeAlign}</span>
        <mdui-switch ref={switchRef} checked={edgeAlign} data-testid="depth-edge-align" />
      </div>
      <p className="text-xs leading-5 text-on-surface-variant">{t.depth.edgeAlignHint}</p>
    </section>
  )
}

function SettingsSection() {
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
    <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3 text-sm">
      <h3 className="font-medium">{t.depth.settings}</h3>
      <SelectField
        label={t.depth.source}
        value={settings.source}
        options={MODEL_SOURCES.map((s) => ({ value: s, label: t.depth.sources[s] }))}
        onChange={(source) => change({ source })}
        testId="depth-source"
      />
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
      <p className="text-xs leading-5 text-on-surface-variant">{t.depth.settingsHint}</p>
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
