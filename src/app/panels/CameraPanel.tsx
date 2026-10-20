import { useCallback } from 'react'
import { cameraFocal, heightAbove, linesFromCamera, solveLines } from '@/camera/geometry'
import { GUIDE_KINDS, GUIDE_SCALE_RANGE } from '@/camera/guides'
import { CALIBRATION_METHODS, FOV_RANGE, HEIGHT_RANGE, LINE_AXES, PITCH_LIMIT, ROLL_LIMIT, type CalibrationMethod, type CameraDoc, type LineAxis } from '@/camera/model'
import { t } from '@/i18n'
import { guideRod, useCameraGuide } from '@/state/cameraGuide'
import { useApp } from '@/state/store'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
import { NumberField } from '@/ui/NumberField'
import { notify } from '../notify'
import { useGestureChange } from '../useGestureChange'
import { Hint, Section, ToggleRow } from './FusionSections'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const formatDegrees = (v: number) => `${v.toFixed(1)}°`

/** 相机高度的滑块按对数刻度：0–100 对应 0.1–100 m */
const [H0, H1] = HEIGHT_RANGE
const toHeight = (s: number) => Number((H0 * (H1 / H0) ** (s / 100)).toPrecision(3))
const fromHeight = (h: number) => (100 * Math.log(h / H0)) / Math.log(H1 / H0)
const formatHeight = (s: number) => `${toHeight(s)} m`

export function CameraPanel() {
  const background = useApp((s) => s.doc.background)
  const method = useApp((s) => s.doc.camera.method)
  if (!background) return <p className="px-1 text-sm text-on-surface-variant">{t.camera.noBackground}</p>
  return (
    <div className="flex flex-col gap-4">
      <ConfirmSection />
      <Section title={t.camera.method}>
        <Hint>{t.camera.intro}</Hint>
        <Segmented value={method} options={CALIBRATION_METHODS} label={(v) => t.camera.methods[v]} onChange={setMethod} testId="camera-method" />
        <Hint>{method === 'horizon' ? t.camera.horizonHint : t.camera.linesHint}</Hint>
      </Section>
      {method === 'horizon' ? <HorizonSection /> : <LinesSection />}
      <ResultSection />
      <ScaleSection />
      <GuideSection />
    </div>
  )
}

/** 切换到平行线方式时，没有画过线就按当前的标定生成，并立即按线求解 */
function setMethod(method: CalibrationMethod): void {
  const s = useApp.getState()
  const { camera, background } = s.doc
  if (!background || method === camera.method) return
  if (method === 'horizon') return s.updateCamera({ method })
  const lines = camera.lines ?? linesFromCamera(camera, background)
  const solved = solveLines(lines, background)
  s.updateCamera({ method, lines, ...(solved.ok ? solved.camera : {}) })
}

/** 按当前标定重新放置平行线（第二组取 axis 方向） */
function resetLines(axis: LineAxis): void {
  const s = useApp.getState()
  const { camera, background } = s.doc
  if (!background) return
  const lines = linesFromCamera(camera, background, axis)
  const solved = solveLines(lines, background)
  s.updateCamera({ lines, ...(solved.ok ? solved.camera : {}) })
}

function ConfirmSection() {
  const confirmed = useApp((s) => s.doc.camera.confirmed)
  if (confirmed) {
    return (
      <section className="flex flex-col gap-1 rounded-2xl bg-white/5 p-3 text-sm" data-testid="camera-confirmed">
        <div className="flex items-center gap-2">
          <mdui-icon-check-circle--outlined className="size-5 text-primary" />
          <span className="font-medium">{t.camera.confirmed}</span>
        </div>
        <Hint>{t.camera.confirmedHint}</Hint>
        <ScaleNotice />
      </section>
    )
  }
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-champagne/50 bg-champagne/10 p-3 text-sm" data-testid="camera-locked">
      <div className="flex items-center gap-2">
        <mdui-icon-lock--outlined className="size-5 text-champagne" />
        <span className="font-medium">{t.camera.locked}</span>
      </div>
      <Hint>{t.camera.lockedHint}</Hint>
      <ScaleNotice />
      <mdui-button variant="filled" onClick={() => useApp.getState().confirmCamera()} data-testid="camera-confirm">
        {t.camera.confirm}
      </mdui-button>
    </section>
  )
}

/** 场景尺寸尚未标定时的提示 */
function ScaleNotice() {
  const unset = useApp((s) => s.doc.camera.heightSource === 'default')
  return unset ? (
    <p className="text-xs leading-5 text-champagne" data-testid="camera-scale-unset">
      {t.camera.scale.unset}
    </p>
  ) : null
}

function useCameraSlider(key: 'fovDeg' | 'pitch' | 'roll' | 'yaw', k = 1) {
  return useGestureChange(useCallback((v: number) => useApp.getState().updateCamera({ [key]: v * k } as Partial<CameraDoc>), [key, k]))
}

function HorizonSection() {
  const camera = useApp((s) => s.doc.camera)
  const onFov = useCameraSlider('fovDeg')
  const onPitch = useCameraSlider('pitch', RAD)
  const onRoll = useCameraSlider('roll', RAD)
  const onYaw = useCameraSlider('yaw', RAD)
  return (
    <Section title={t.camera.methods.horizon} testId="camera-horizon">
      <SliderField label={t.camera.fov} value={camera.fovDeg} min={FOV_RANGE[0]} max={FOV_RANGE[1]} step={0.5} format={formatDegrees} onChange={onFov} testId="camera-fov" />
      <Hint>{t.camera.fovHint}</Hint>
      <SliderField label={t.camera.pitch} value={camera.pitch * DEG} min={-PITCH_LIMIT * DEG} max={PITCH_LIMIT * DEG} step={0.1} format={formatDegrees} onChange={onPitch} testId="camera-pitch" />
      <Hint>{t.camera.pitchHint}</Hint>
      <SliderField label={t.camera.roll} value={camera.roll * DEG} min={-ROLL_LIMIT * DEG} max={ROLL_LIMIT * DEG} step={0.1} format={formatDegrees} onChange={onRoll} testId="camera-roll" />
      <SliderField label={t.camera.yaw} value={camera.yaw * DEG} min={-180} max={180} step={0.5} format={formatDegrees} onChange={onYaw} testId="camera-yaw" />
      <Hint>{t.camera.yawHint}</Hint>
    </Section>
  )
}

function LinesSection() {
  const camera = useApp((s) => s.doc.camera)
  const background = useApp((s) => s.doc.background)
  const axis = camera.lines?.secondAxis ?? 'horizontal'
  const solved = camera.lines && background ? solveLines(camera.lines, background) : null
  return (
    <Section title={t.camera.methods.lines} testId="camera-lines">
      <span>{t.camera.axis}</span>
      <Segmented value={axis} options={LINE_AXES} label={(v) => t.camera.axes[v]} onChange={resetLines} testId="camera-axis" />
      <Hint>{t.camera.axisHint}</Hint>
      {solved && !solved.ok && (
        <span className="text-xs leading-5 text-error" data-testid="camera-solve-error">
          {t.camera.solveErrors[solved.error]}
          {t.camera.keepLast}
        </span>
      )}
      <mdui-button variant="outlined" onClick={() => resetLines(axis)} data-testid="camera-reset-lines">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.camera.resetLines}
      </mdui-button>
    </Section>
  )
}

const GUIDE_OPTIONS = GUIDE_KINDS.map((value) => ({ value, label: t.camera.guide.kinds[value] }))

function GuideSection() {
  const { kind, scale, dim, setKind, setScale, setDim, resetOrigin } = useCameraGuide()
  const g = t.camera.guide
  return (
    <Section title={g.title} testId="camera-guide-section">
      <SelectField label={g.kind} value={kind} options={GUIDE_OPTIONS} onChange={setKind} testId="camera-guide-kind" />
      {kind !== 'none' && (
        <SliderField label={g.scale} value={scale} min={GUIDE_SCALE_RANGE[0]} max={GUIDE_SCALE_RANGE[1]} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={setScale} testId="camera-guide-scale" />
      )}
      <Hint>{g.hint}</Hint>
      <ToggleRow label={g.dim} checked={dim} onChange={setDim} testId="camera-dim-toggle" />
      <mdui-button variant="outlined" onClick={resetOrigin} data-testid="camera-guide-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {g.resetOrigin}
      </mdui-button>
    </Section>
  )
}

/** 两种方式统一的标定结果 */
function ResultSection() {
  const camera = useApp((s) => s.doc.camera)
  const background = useApp((s) => s.doc.background)
  if (!background) return null
  const f = cameraFocal(camera, background)
  const fov = (side: number) => formatDegrees(2 * Math.atan(side / 2 / f) * DEG)
  const r = t.camera.result
  const rows: [string, string][] = [
    [r.hfov, fov(background.width)],
    [r.vfov, fov(background.height)],
    [t.camera.pitch, formatDegrees(camera.pitch * DEG)],
    [t.camera.roll, formatDegrees(camera.roll * DEG)],
    [t.camera.yaw, formatDegrees(camera.yaw * DEG)],
    [r.height, `${formatMeters(camera.height)}（${r.sources[camera.heightSource]}）`],
  ]
  return (
    <Section title={r.title} testId="camera-solution">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-on-surface-variant">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

const formatMeters = (m: number) => `${Number(m.toPrecision(3))} m`

/** 按测量杆的读数与实际高度之比换算相机高度 */
function applyRod(): void {
  const s = useApp.getState()
  const { camera, background } = s.doc
  const g = useCameraGuide.getState()
  const rod = guideRod(s.doc, g.rod)
  const measured = rod && background ? heightAbove(camera, background, rod.foot, rod.top) : null
  if (!measured || measured <= 0 || g.rodReal <= 0) return notify(t.camera.scale.applyFailed)
  const height = Math.min(H1, Math.max(H0, (camera.height * g.rodReal) / measured))
  s.updateCamera({ height, heightSource: 'measured' })
}

function ScaleSection() {
  const doc = useApp((s) => s.doc)
  const { rod, rodReal, setRodReal } = useCameraGuide()
  const { camera, background } = doc
  const current = guideRod(doc, rod)
  const measured = current && background ? heightAbove(camera, background, current.foot, current.top) : null
  const onHeight = useGestureChange(
    useCallback((v: number) => {
      const c = useApp.getState().doc.camera
      // 程序赋值（撤销、按测量杆设定）后滑块也会发出 change，与当前值相差不到半步时不当作手动填写
      if (Math.abs(fromHeight(c.height) - v) < 0.05) return
      useApp.getState().updateCamera({ height: toHeight(v), heightSource: 'manual' })
    }, []),
  )
  const sc = t.camera.scale
  return (
    <Section title={sc.title} testId="camera-scale">
      <Hint>{sc.why}</Hint>
      <Hint>{sc.use}</Hint>
      <p className={camera.heightSource === 'default' ? 'font-medium text-champagne' : 'font-medium'} data-testid="camera-scale-status">
        {sc.sources[camera.heightSource]}
      </p>
      <div className="flex items-baseline justify-between px-1">
        <span className="text-on-surface-variant">{sc.rod}</span>
        <span className="font-medium tabular-nums" data-testid="camera-rod-reading">
          {measured === null ? sc.rodUnknown : `${measured.toFixed(2)} m`}
        </span>
      </div>
      <NumberField label={sc.real} value={rodReal} onCommit={(v) => v > 0 && setRodReal(v)} testId="camera-rod-real" />
      <mdui-button variant="tonal" onClick={applyRod} data-testid="camera-rod-apply">
        {sc.apply}
      </mdui-button>
      <Hint>{sc.rodHint}</Hint>
      <SliderField label={sc.height} value={fromHeight(camera.height)} min={0} max={100} step={0.1} format={formatHeight} onChange={onHeight} testId="camera-height" />
      <Hint>{sc.heightHint}</Hint>
    </Section>
  )
}
