import { useCallback, useRef } from 'react'
import { useGestureChange } from '../useGestureChange'
import type { Switch } from 'mdui/components/switch.js'
import { cameraCorners, characterMeters } from '@/camera/character'
import { GUIDE_KINDS } from '@/camera/guides'
import { hasGridWarp, hasPerspective, isValidWarp, WARP_GRID_SIZES, type WarpGridSize } from '@/fusion/warp'
import { t } from '@/i18n'
import { useCameraGuide } from '@/state/cameraGuide'
import { CHARACTER_TOOLS, characterInfo, useCharacterInfo, useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { SliderField } from '@/ui/SliderField'
import { NumberField } from '@/ui/NumberField'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { useDomEvent } from '@/ui/useDomEvent'
import { notify } from '../notify'
import { FusionSections, Hint, Section, ToggleRow } from './FusionSections'

const RAD = Math.PI / 180

const formatPercent = (v: number) => `${Math.round(v)}%`
const formatDegrees = (v: number) => `${v.toFixed(1)}°`
const GRID_OPTIONS = WARP_GRID_SIZES.map(String)
/** 立绘步骤用开关控制显示，种类里不含“不显示” */
const GUIDE_OPTIONS = GUIDE_KINDS.filter((k) => k !== 'none').map((value) => ({ value, label: t.camera.guide.kinds[value] }))

export function CharacterPanel() {
  const character = useApp((s) => s.doc.character)
  const tr = useApp((s) => s.doc.charTransform)
  const setCharTransform = useApp((s) => s.setCharTransform)
  const resetCharTransform = useApp((s) => s.resetCharTransform)

  const onScale = useGestureChange(useCallback((v: number) => setCharTransform({ scale: Math.max(0.005, v / 100) }), [setCharTransform]))
  const onRotation = useGestureChange(useCallback((v: number) => setCharTransform({ rotation: v * RAD }), [setCharTransform]))

  if (!character) return <p className="px-1 text-sm text-on-surface-variant">{t.character.noCharacter}</p>

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3">
        <h3 className="text-sm font-medium">{t.character.transform}</h3>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label={t.character.x} value={Math.round(tr.x)} onCommit={(x) => setCharTransform({ x })} testId="char-x" />
          <NumberField label={t.character.y} value={Math.round(tr.y)} onCommit={(y) => setCharTransform({ y })} testId="char-y" />
        </div>
        <SliderField label={t.character.scale} value={tr.scale * 100} min={1} max={300} step={0.5} format={formatPercent} onChange={onScale} testId="char-scale" />
        <SliderField label={t.character.rotation} value={tr.rotation / RAD} min={-180} max={180} step={0.5} format={formatDegrees} onChange={onRotation} testId="char-rotation" />
        <div className="flex items-center justify-between">
          <span className="text-sm">{t.character.flip}</span>
          <FlipSwitch checked={tr.flipX} onChange={(flipX) => setCharTransform({ flipX })} />
        </div>
        <mdui-button variant="outlined" onClick={resetCharTransform}>
          <mdui-icon-restart-alt--outlined slot="icon" />
          {t.character.reset}
        </mdui-button>
        <p className="text-xs leading-5 text-on-surface-variant">{t.character.gizmoHint}</p>
      </section>
      <CameraSection />
      <WarpSection />
      <FusionSections />
    </div>
  )
}

/** 显示参考形状；相机步骤中选了“不显示”时改回地面网格 */
function setShowGuide(on: boolean): void {
  useFusion.getState().setShowGuide(on)
  const guide = useCameraGuide.getState()
  if (on && guide.kind === 'none') guide.setKind('ground')
}

/** 按相机写入四角透视（一次撤销记录） */
function applyCameraPerspective(): void {
  const s = useApp.getState()
  const corners = cameraCorners(s.doc, characterInfo(s.doc)?.bbox)
  const warp = corners && { ...s.doc.charWarp, corners }
  if (warp && isValidWarp(warp)) s.setCharWarp(warp)
  else notify(t.character.camera.applyFailed)
}

function CameraSection() {
  const doc = useApp((s) => s.doc)
  const info = useCharacterInfo(doc)
  const perspectiveMove = useFusion((s) => s.perspectiveMove)
  const kind = useCameraGuide((s) => s.kind)
  const showGuide = useFusion((s) => s.showGuide) && kind !== 'none'
  const c = t.character.camera
  const meters = characterMeters(doc, info?.bbox)
  return (
    <Section title={c.title} testId="char-camera">
      <ToggleRow label={c.perspectiveMove} checked={perspectiveMove} onChange={useFusion.getState().setPerspectiveMove} testId="char-perspective-move" />
      <Hint>{c.perspectiveMoveHint}</Hint>
      <ToggleRow label={c.showGuide} checked={showGuide} onChange={setShowGuide} testId="char-show-guide" />
      {showGuide && (
        <>
          <SelectField label={t.camera.guide.kind} value={kind} options={GUIDE_OPTIONS} onChange={useCameraGuide.getState().setKind} testId="char-guide-kind" />
          <Hint>{c.guideHint}</Hint>
        </>
      )}
      <div className="flex flex-col gap-1">
        {/* 立绘的不透明区域在后台算出之前，读数按整张图估算 */}
        <span className="font-medium tabular-nums" data-testid="char-height" data-state={info ? 'ready' : 'pending'}>
          {meters === null ? c.heightUnknown : c.height(`${meters.toFixed(2)} m`)}
        </span>
        <Hint>{c.heightHint}</Hint>
      </div>
      <mdui-button variant="outlined" onClick={applyCameraPerspective} data-testid="char-camera-perspective">
        {c.apply}
      </mdui-button>
      <Hint>{c.applyHint}</Hint>
    </Section>
  )
}

function WarpSection() {
  const warp = useApp((s) => s.doc.charWarp)
  const tool = useFusion((s) => s.tool)
  const w = t.character.warp
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-white/5 p-3" data-testid="warp-section">
      <h3 className="text-sm font-medium">{w.title}</h3>
      <span className="text-sm">{w.tool}</span>
      <Segmented value={tool} options={CHARACTER_TOOLS} label={(v) => w.tools[v]} onChange={useFusion.getState().setTool} testId="warp-tool" />
      {tool === 'mesh' && (
        <>
          <span className="text-sm">{w.grid}</span>
          <Segmented
            value={String(warp.grid)}
            options={GRID_OPTIONS}
            label={(v) => `${v} × ${v}`}
            onChange={(v) => useApp.getState().setWarpGrid(Number(v) as WarpGridSize)}
            testId="warp-grid"
          />
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <mdui-button variant="outlined" disabled={!hasPerspective(warp) || undefined} onClick={() => useApp.getState().resetCharWarp('perspective')} data-testid="warp-reset-perspective">
          {w.resetPerspective}
        </mdui-button>
        <mdui-button variant="outlined" disabled={!hasGridWarp(warp) || undefined} onClick={() => useApp.getState().resetCharWarp('grid')} data-testid="warp-reset-grid">
          {w.resetGrid}
        </mdui-button>
      </div>
      <p className="text-xs leading-5 text-on-surface-variant">{w.hints[tool]}</p>
      <p className="text-xs leading-5 text-on-surface-variant">{w.limit}</p>
    </section>
  )
}

function FlipSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const ref = useRef<Switch>(null)
  useDomEvent(ref, 'change', (_e, el) => onChange(el.checked))
  return <mdui-switch ref={ref} checked={checked} data-testid="char-flip" />
}
