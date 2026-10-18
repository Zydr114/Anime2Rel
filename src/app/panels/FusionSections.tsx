import { useCallback, useRef, type ReactNode } from 'react'
import type { SegmentedButtonGroup } from 'mdui/components/segmented-button-group.js'
import type { Switch } from 'mdui/components/switch.js'
import { RELIGHT_STYLES, type FusionDoc, type FusionSection, type RelightStyle } from '@/fusion/model'
import { characterDepth } from '@/fusion/placement'
import { cutOff } from '@/fusion/shadow'
import { t } from '@/i18n'
import { getDepthResult, useDepth } from '@/state/depth'
import { useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { SliderField } from '@/ui/SliderField'
import { useDomEvent } from '@/ui/useDomEvent'
import { useGestureChange } from '../useGestureChange'

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatFixed = (digits: number) => (v: number) => v.toFixed(digits)
const formatRelative = (v: number) => `${v.toFixed(1)}%`
const formatPx = (v: number) => `${v.toFixed(1)} px`

export function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3 text-sm" data-testid={testId}>
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  )
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-on-surface-variant">{children}</p>
}

export function ToggleRow({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  const ref = useRef<Switch>(null)
  useDomEvent(ref, 'change', (e, el) => {
    if (e.target === el) onChange(el.checked)
  })
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <mdui-switch ref={ref} checked={checked} data-testid={testId} />
    </div>
  )
}

/** 融合参数滑块：显示值 = 参数 × scale，拖动期间合并为一次撤销记录。 */
function FusionSlider<K extends FusionSection>(props: {
  section: K
  field: keyof FusionDoc[K] & string
  label: string
  min: number
  max: number
  step?: number
  scale?: number
  format?: (v: number) => string
}) {
  const { section, field, scale = 100 } = props
  const value = useApp((s) => s.doc.fusion[section][field] as number)
  const onChange = useGestureChange(
    useCallback((v: number) => useApp.getState().updateFusion(section, { [field]: v / scale } as Partial<FusionDoc[K]>), [section, field, scale]),
  )
  return (
    <SliderField
      label={props.label}
      value={value * scale}
      min={props.min}
      max={props.max}
      step={props.step}
      format={props.format ?? formatPercent}
      onChange={onChange}
      testId={`fusion-${section}-${field}`}
    />
  )
}

export function FusionSections() {
  return (
    <>
      <DepthSection />
      <ShadowSection />
      <ColorSection />
      <RelightSection />
      <EdgeSection />
      <NormalSection />
      <mdui-button variant="text" onClick={() => useApp.getState().resetFusion()} data-testid="fusion-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.fusion.reset}
      </mdui-button>
    </>
  )
}

/** 立绘的前后位置；children 追加在同一分组中 */
export function DepthSection({ children }: { children?: ReactNode }) {
  const manual = useApp((s) => s.doc.fusion.depth)
  const doc = useApp((s) => s.doc)
  const bbox = useFusion((s) => (s.character?.id === doc.character?.id ? s.character?.info.bbox : undefined))
  // 深度结果存在模块级缓存里，resultsVersion 变化会让选择器重新读取
  const depth = useDepth(() => getDepthResult(doc.background?.id))
  const value = characterDepth(doc, depth, bbox)
  const onDepth = useGestureChange(useCallback((v: number) => useApp.getState().setCharDepth(v / 100), []))
  const onAuto = (auto: boolean) => useApp.getState().setCharDepth(auto ? null : value)

  return (
    <Section title={t.fusion.depthSection}>
      <SliderField label={t.fusion.depth} value={value * 100} min={0} max={100} step={0.5} format={formatPercent} onChange={onDepth} testId="fusion-depth" />
      <ToggleRow label={t.fusion.depthAuto} checked={manual === null} onChange={onAuto} testId="fusion-depth-auto" />
      <Hint>{t.fusion.depthHint}</Hint>
      <div className="flex items-center justify-between">
        <span>
          {t.fusion.ground}
          <span className="ml-2 text-on-surface-variant" data-testid="fusion-ground-state">
            {doc.fusion.ground ? t.fusion.groundManual : t.fusion.groundAuto}
          </span>
        </span>
        {doc.fusion.ground && (
          <mdui-button variant="text" onClick={() => useApp.getState().setCharGround(null)} data-testid="fusion-ground-reset">
            {t.fusion.groundReset}
          </mdui-button>
        )}
      </div>
      <Hint>{t.fusion.groundHint}</Hint>
      {children}
    </Section>
  )
}

function ShadowSection() {
  const doc = useApp((s) => s.doc)
  const info = useFusion((s) => (s.character?.id === doc.character?.id ? s.character?.info : undefined))
  return (
    <Section title={t.fusion.shadow} testId="fusion-shadow">
      <FusionSlider section="shadow" field="contact" label={t.fusion.contact} min={0} max={100} />
      <FusionSlider section="shadow" field="contactSize" label={t.fusion.contactSize} min={30} max={300} />
      <FusionSlider section="shadow" field="contactSoftness" label={t.fusion.contactSoftness} min={0} max={100} />
      <FusionSlider section="shadow" field="cast" label={t.fusion.cast} min={0} max={100} />
      <FusionSlider section="shadow" field="castSoftness" label={t.fusion.castSoftness} min={0} max={100} />
      <Hint>{cutOff(doc, info) ? t.fusion.shadowCut : t.fusion.shadowHint}</Hint>
    </Section>
  )
}

function ColorSection() {
  const skinProtect = useApp((s) => s.doc.fusion.colorMatch.skinProtect)
  const ready = useFusion((s) => !!s.stats?.local)
  return (
    <Section title={t.fusion.colorMatch} testId="fusion-color">
      <FusionSlider section="colorMatch" field="whiteBalance" label={t.fusion.whiteBalance} min={0} max={100} />
      <FusionSlider section="colorMatch" field="tone" label={t.fusion.tone} min={0} max={100} />
      <FusionSlider section="colorMatch" field="chroma" label={t.fusion.chroma} min={0} max={100} />
      <FusionSlider section="colorMatch" field="saturation" label={t.fusion.saturation} min={0} max={100} />
      <ToggleRow
        label={t.fusion.skinProtect}
        checked={skinProtect}
        onChange={(v) => useApp.getState().updateFusion('colorMatch', { skinProtect: v })}
        testId="fusion-skin-protect"
      />
      <Hint>{ready ? t.fusion.colorHint : t.fusion.waitingStats}</Hint>
    </Section>
  )
}

function RelightSection() {
  const style = useApp((s) => s.doc.fusion.relight.style)
  const hasLights = useApp((s) => s.doc.lighting.lights.some((l) => l.enabled))
  const groupRef = useRef<SegmentedButtonGroup>(null)
  useDomEvent(groupRef, 'change', (e, el) => {
    if (e.target !== el) return
    const v = el.value as RelightStyle
    // 单选组再次点击会取消选中，恢复原值
    if (v) useApp.getState().updateFusion('relight', { style: v })
    else el.value = useApp.getState().doc.fusion.relight.style
  })

  return (
    <Section title={t.fusion.relight} testId="fusion-relight">
      <mdui-segmented-button-group ref={groupRef} selects="single" value={style} full-width data-testid="fusion-style">
        {RELIGHT_STYLES.map((v) => (
          <mdui-segmented-button key={v} value={v}>
            {t.fusion.styles[v]}
          </mdui-segmented-button>
        ))}
      </mdui-segmented-button-group>
      <FusionSlider section="relight" field="strength" label={t.fusion.strength} min={0} max={100} />
      {style === 'cel' && (
        <>
          <FusionSlider section="relight" field="celThreshold" label={t.fusion.celThreshold} min={-0.5} max={0.5} step={0.01} scale={1} format={formatFixed(2)} />
          <FusionSlider section="relight" field="celSoftness" label={t.fusion.celSoftness} min={0} max={0.3} step={0.01} scale={1} format={formatFixed(2)} />
        </>
      )}
      <FusionSlider section="relight" field="rim" label={t.fusion.rim} min={0} max={200} />
      <FusionSlider section="relight" field="specular" label={t.fusion.specular} min={0} max={100} />
      <Hint>{hasLights ? t.fusion.relightHint : t.fusion.noLights}</Hint>
    </Section>
  )
}

function EdgeSection() {
  const noise = useFusion((s) => s.background?.info.noise)
  const sigma = noise ? ((noise[0] + noise[1] + noise[2]) / 3) * 255 : null
  return (
    <Section title={t.fusion.edge} testId="fusion-edge">
      <FusionSlider section="edge" field="lightWrap" label={t.fusion.lightWrap} min={0} max={100} />
      <FusionSlider section="edge" field="wrapRadius" label={t.fusion.wrapRadius} min={0.1} max={3} step={0.1} format={formatRelative} />
      <FusionSlider section="edge" field="feather" label={t.fusion.feather} min={0} max={3} step={0.1} scale={1} format={formatPx} />
      <FusionSlider section="edge" field="noise" label={t.fusion.noise} min={0} max={200} />
      {sigma !== null && <Hint>{t.fusion.noiseMeasured(sigma.toFixed(1))}</Hint>}
    </Section>
  )
}

function NormalSection() {
  const showNormals = useFusion((s) => s.showNormals)
  return (
    <details className="group rounded-2xl bg-white/5 p-3 text-sm" data-testid="fusion-normals">
      <summary className="cursor-pointer font-medium">{t.fusion.normals}</summary>
      <div className="mt-3 flex flex-col gap-3">
        <ToggleRow label={t.fusion.showNormals} checked={showNormals} onChange={useFusion.getState().setShowNormals} testId="fusion-show-normals" />
        <FusionSlider section="normals" field="depth" label={t.fusion.normalDepth} min={0} max={100} />
        <FusionSlider section="normals" field="inflate" label={t.fusion.normalInflate} min={0} max={100} />
        <FusionSlider section="normals" field="detail" label={t.fusion.normalDetail} min={0} max={100} />
        <FusionSlider section="normals" field="inflateRadius" label={t.fusion.inflateRadius} min={1} max={20} step={0.5} format={formatRelative} />
        <Hint>{t.fusion.normalsHint}</Hint>
      </div>
    </details>
  )
}
