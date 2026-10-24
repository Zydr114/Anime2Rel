import { useCallback, useRef } from 'react'
import type { SegmentedButtonGroup } from 'mdui/components/segmented-button-group.js'
import { depthScaleFor } from '@/camera/depthScale'
import { waterActive } from '@/focus/model'
import { RELIGHT_STYLES, SHADOW_METHODS, type FusionDoc, type FusionSection, type RelightStyle, type ShadowMethod } from '@/fusion/model'
import { characterDepth } from '@/fusion/placement'
import { cutOff } from '@/fusion/shadow'
import { t } from '@/i18n'
import { getDepthResult, useDepth } from '@/state/depth'
import { useCharacterInfo, useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { SliderField } from '@/ui/SliderField'
import { useDomEvent } from '@/ui/useDomEvent'
import { useGestureChange } from '../useGestureChange'
import { Group, Hint, More, ToggleRow } from './Group'

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatFixed = (digits: number) => (v: number) => v.toFixed(digits)
const formatRelative = (v: number) => `${v.toFixed(1)}%`
const formatPx = (v: number) => `${v.toFixed(1)} px`

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

/** 融合步骤中立绘融合的各组；需要立绘 */
export function FusionSections() {
  return (
    <>
      <RelightSection />
      <ShadowSection />
      <GroundingSection />
      <ColorSection />
      <EdgeSection />
      <NormalSection />
      <mdui-button variant="text" onClick={() => useApp.getState().resetFusion()} data-testid="fusion-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.fusion.reset}
      </mdui-button>
    </>
  )
}

/** 立绘的前后位置与接地点（摆放步骤） */
export function DepthSection() {
  const manual = useApp((s) => s.doc.fusion.depth)
  const doc = useApp((s) => s.doc)
  const bbox = useCharacterInfo(doc)?.bbox
  // 深度结果存在模块级缓存里，resultsVersion 变化会让选择器重新读取
  const depth = useDepth(() => getDepthResult(doc.background?.id))
  const value = characterDepth(doc, depth, bbox)
  const onDepth = useGestureChange(useCallback((v: number) => useApp.getState().setCharDepth(v / 100), []))
  const onAuto = (auto: boolean) => useApp.getState().setCharDepth(auto ? null : value)
  const f = t.fusion

  return (
    <Group
      id="fusion.depth"
      title={f.depthSection}
      summary={`${formatPercent(value * 100)} · ${manual === null ? f.auto : f.groundManual}`}
      help={[f.depthHint, f.groundHint]}
      testId="fusion-depth-section"
    >
      <SliderField label={f.depth} value={value * 100} min={0} max={100} step={0.5} format={formatPercent} onChange={onDepth} testId="fusion-depth" />
      <ToggleRow label={f.depthAuto} checked={manual === null} onChange={onAuto} testId="fusion-depth-auto" />
      <div className="flex items-center justify-between">
        <span>
          {f.ground}
          <span className="ml-2 text-on-surface-variant" data-testid="fusion-ground-state">
            {doc.fusion.ground ? f.groundManual : f.groundAuto}
          </span>
        </span>
        {doc.fusion.ground && (
          <mdui-button variant="text" onClick={() => useApp.getState().setCharGround(null)} data-testid="fusion-ground-reset">
            {f.groundReset}
          </mdui-button>
        )}
      </div>
    </Group>
  )
}

/** 深度是否按地面校准：贴合表面与离地遮蔽都要按米重建三维位置 */
function useCalibratedDepth(): boolean {
  const doc = useApp((s) => s.doc)
  const depth = useDepth(() => getDepthResult(doc.background?.id))
  return !!doc.background && !!depth && depthScaleFor(doc.camera, doc.background, depth).state === 'ground'
}

function ShadowSection() {
  const doc = useApp((s) => s.doc)
  const info = useCharacterInfo(doc)
  const { contact, cast, method } = doc.fusion.shadow
  const calibrated = useCalibratedDepth()
  const hasLights = useApp((s) => s.doc.lighting.lights.some((l) => l.enabled))
  const f = t.fusion
  const groupRef = useRef<SegmentedButtonGroup>(null)
  useDomEvent(groupRef, 'change', (e, el) => {
    if (e.target !== el) return
    const v = el.value as ShadowMethod
    // 单选组再次点击会取消选中，恢复原值
    if (v) useApp.getState().updateFusion('shadow', { method: v })
    else el.value = useApp.getState().doc.fusion.shadow.method
  })
  const warning = waterActive(doc.focus) ? f.shadowWater : cutOff(doc, info) ? f.shadowCut : !calibrated ? f.shadowNoDepth : null
  return (
    <Group id="fusion.shadow" title={f.shadow} summary={f.shadowSummary(formatPercent(contact * 100), formatPercent(cast * 100))} help={f.shadowHint} testId="fusion-shadow">
      {warning && <Hint warn>{warning}</Hint>}
      {!hasLights && <Hint warn>{f.shadowNoLights}</Hint>}
      <FusionSlider section="shadow" field="contact" label={f.contact} min={0} max={100} />
      <FusionSlider section="shadow" field="cast" label={f.cast} min={0} max={100} />
      <span className="text-sm">{f.shadowMethod}</span>
      <mdui-segmented-button-group ref={groupRef} selects="single" value={method} full-width data-testid="fusion-shadow-method">
        {SHADOW_METHODS.map((v) => (
          <mdui-segmented-button key={v} value={v} disabled={v === 'surface' && !calibrated}>
            {f.shadowMethods[v]}
          </mdui-segmented-button>
        ))}
      </mdui-segmented-button-group>
      <FusionSlider section="shadow" field="self" label={f.selfShadow} min={0} max={100} />
      <More id="fusion.shadow.more">
        <FusionSlider section="shadow" field="contactSize" label={f.contactSize} min={30} max={300} />
        <FusionSlider section="shadow" field="contactSoftness" label={f.contactSoftness} min={0} max={100} />
        <FusionSlider section="shadow" field="castSoftness" label={f.castSoftness} min={0} max={100} />
      </More>
    </Group>
  )
}

function GroundingSection() {
  const doc = useApp((s) => s.doc)
  const info = useCharacterInfo(doc)
  const grounding = doc.fusion.grounding
  const calibrated = useCalibratedDepth()
  const hasLights = useApp((s) => s.doc.lighting.lights.some((l) => l.enabled))
  // 地面颜色由融合 Worker 取，取样不足时没有反光
  const hasGround = useFusion((s) => !!s.stats?.groundColor)
  const f = t.fusion
  const warning = waterActive(doc.focus) ? f.shadowWater : cutOff(doc, info) ? f.shadowCut : !calibrated ? f.shadowNoDepth : grounding.bounce > 0 && !hasGround ? f.groundingNoGround : null
  return (
    <Group
      id="fusion.grounding"
      title={f.grounding}
      summary={f.groundingSummary(formatPercent(grounding.ao * 100), formatPercent(grounding.bounce * 100))}
      help={f.groundingHint}
      testId="fusion-grounding"
    >
      {warning && <Hint warn>{warning}</Hint>}
      {!hasLights && grounding.bounce > 0 && <Hint warn>{f.shadowNoLights}</Hint>}
      <FusionSlider section="grounding" field="ao" label={f.groundOcclusion} min={0} max={100} />
      <FusionSlider section="grounding" field="aoRange" label={f.groundOcclusionRange} min={5} max={100} />
      <FusionSlider section="grounding" field="bounce" label={f.groundBounce} min={0} max={100} />
      <FusionSlider section="grounding" field="bounceRange" label={f.groundBounceRange} min={5} max={100} />
    </Group>
  )
}

function ColorSection() {
  const color = useApp((s) => s.doc.fusion.colorMatch)
  const ready = useFusion((s) => !!s.stats?.local)
  const f = t.fusion
  return (
    <Group
      id="fusion.color"
      title={f.colorMatch}
      summary={f.colorSummary(formatPercent(color.whiteBalance * 100), formatPercent(color.tone * 100))}
      help={[f.colorHint, f.skinProtectHint]}
      testId="fusion-color"
      state={ready ? 'ready' : 'waiting'}
    >
      {!ready && <Hint>{f.waitingStats}</Hint>}
      <FusionSlider section="colorMatch" field="whiteBalance" label={f.whiteBalance} min={0} max={100} />
      <FusionSlider section="colorMatch" field="tone" label={f.tone} min={0} max={100} />
      <FusionSlider section="colorMatch" field="chroma" label={f.chroma} min={0} max={100} />
      <More id="fusion.color.more">
        <FusionSlider section="colorMatch" field="saturation" label={f.saturation} min={0} max={100} />
        <ToggleRow
          label={f.skinProtect}
          checked={color.skinProtect}
          onChange={(v) => useApp.getState().updateFusion('colorMatch', { skinProtect: v })}
          testId="fusion-skin-protect"
        />
      </More>
    </Group>
  )
}

function RelightSection() {
  const relight = useApp((s) => s.doc.fusion.relight)
  const style = relight.style
  const hasLights = useApp((s) => s.doc.lighting.lights.some((l) => l.enabled))
  const groupRef = useRef<SegmentedButtonGroup>(null)
  useDomEvent(groupRef, 'change', (e, el) => {
    if (e.target !== el) return
    const v = el.value as RelightStyle
    // 单选组再次点击会取消选中，恢复原值
    if (v) useApp.getState().updateFusion('relight', { style: v })
    else el.value = useApp.getState().doc.fusion.relight.style
  })
  const f = t.fusion

  return (
    <Group id="fusion.relight" title={f.relight} summary={`${f.styles[style]} · ${formatPercent(relight.strength * 100)}`} help={f.relightHint} testId="fusion-relight">
      {!hasLights && <Hint warn>{f.noLights}</Hint>}
      <mdui-segmented-button-group ref={groupRef} selects="single" value={style} full-width data-testid="fusion-style">
        {RELIGHT_STYLES.map((v) => (
          <mdui-segmented-button key={v} value={v}>
            {f.styles[v]}
          </mdui-segmented-button>
        ))}
      </mdui-segmented-button-group>
      <FusionSlider section="relight" field="strength" label={f.strength} min={0} max={100} />
      {style === 'cel' && (
        <>
          <FusionSlider section="relight" field="celThreshold" label={f.celThreshold} min={-0.5} max={0.5} step={0.01} scale={1} format={formatFixed(2)} />
          <FusionSlider section="relight" field="celSoftness" label={f.celSoftness} min={0} max={0.3} step={0.01} scale={1} format={formatFixed(2)} />
        </>
      )}
      <FusionSlider section="relight" field="rim" label={f.rim} min={0} max={200} />
      <FusionSlider section="relight" field="specular" label={f.specular} min={0} max={100} />
    </Group>
  )
}

function EdgeSection() {
  const noise = useFusion((s) => s.background?.info.noise)
  const edge = useApp((s) => s.doc.fusion.edge)
  const sigma = noise ? ((noise[0] + noise[1] + noise[2]) / 3) * 255 : null
  const f = t.fusion
  return (
    <Group
      id="fusion.edge"
      title={f.edge}
      summary={f.edgeSummary(formatPercent(edge.lightWrap * 100), formatPx(edge.feather))}
      help={[f.decontaminateHint, f.edgeHint]}
      testId="fusion-edge"
    >
      <ToggleRow
        label={f.decontaminate}
        checked={edge.decontaminate}
        onChange={(v) => useApp.getState().updateFusion('edge', { decontaminate: v })}
        testId="fusion-edge-decontaminate"
      />
      <FusionSlider section="edge" field="lightWrap" label={f.lightWrap} min={0} max={100} />
      <FusionSlider section="edge" field="feather" label={f.feather} min={0} max={3} step={0.1} scale={1} format={formatPx} />
      <More id="fusion.edge.more">
        <FusionSlider section="edge" field="shrink" label={f.shrink} min={0} max={2} step={0.1} scale={1} format={formatPx} />
        <FusionSlider section="edge" field="wrapRadius" label={f.wrapRadius} min={0.1} max={3} step={0.1} format={formatRelative} />
        <FusionSlider section="edge" field="noise" label={f.noise} min={0} max={200} />
        {sigma !== null && <Hint>{f.noiseMeasured(sigma.toFixed(1))}</Hint>}
      </More>
    </Group>
  )
}

function NormalSection() {
  const showNormals = useFusion((s) => s.showNormals)
  const f = t.fusion
  return (
    <Group id="fusion.normals" title={f.normals} help={f.normalsHint} testId="fusion-normals">
      <ToggleRow label={f.showNormals} checked={showNormals} onChange={useFusion.getState().setShowNormals} testId="fusion-show-normals" />
      <FusionSlider section="normals" field="depth" label={f.normalDepth} min={0} max={100} />
      <FusionSlider section="normals" field="inflate" label={f.normalInflate} min={0} max={100} />
      <FusionSlider section="normals" field="detail" label={f.normalDetail} min={0} max={100} />
      <FusionSlider section="normals" field="inflateRadius" label={f.inflateRadius} min={1} max={20} step={0.5} format={formatRelative} />
    </Group>
  )
}
