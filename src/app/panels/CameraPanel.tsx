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
import { Group, Hint, More, ToggleRow } from './Group'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const formatDegrees = (v: number) => `${v.toFixed(1)}°`

/** 相机高度的滑块按对数刻度：0–100 对应 0.1–100 m */
const [H0, H1] = HEIGHT_RANGE
const toHeight = (s: number) => Number((H0 * (H1 / H0) ** (s / 100)).toPrecision(3))
const fromHeight = (h: number) => (100 * Math.log(h / H0)) / Math.log(H1 / H0)
const formatHeight = (s: number) => `${toHeight(s)} m`

/** 场景步骤中相机标定的各组；需要背景 */
export function CameraSections() {
  const method = useApp((s) => s.doc.camera.method)
  const c = t.camera
  return (
    <>
      <ConfirmSection />
      <Group
        id="camera.calibration"
        title={c.method}
        summary={c.methods[method]}
        help={method === 'horizon' ? [c.intro, c.horizonHint, c.fovHint, c.pitchHint, c.yawHint] : [c.linesHint, c.axisHint]}
        defaultOpen
        testId="camera-calibration"
      >
        <Segmented value={method} options={CALIBRATION_METHODS} label={(v) => c.methods[v]} onChange={setMethod} testId="camera-method" />
        {method === 'horizon' ? <HorizonFields /> : <LinesFields />}
      </Group>
      <ResultSection />
      <ScaleSection />
      <GuideSection />
    </>
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
      <section className="flex flex-col gap-1 rounded-2xl bg-on-surface/5 p-3 text-sm" data-testid="camera-confirmed">
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

function HorizonFields() {
  const camera = useApp((s) => s.doc.camera)
  const onFov = useCameraSlider('fovDeg')
  const onPitch = useCameraSlider('pitch', RAD)
  const onRoll = useCameraSlider('roll', RAD)
  const onYaw = useCameraSlider('yaw', RAD)
  return (
    <div className="flex flex-col gap-3" data-testid="camera-horizon">
      <SliderField label={t.camera.fov} value={camera.fovDeg} min={FOV_RANGE[0]} max={FOV_RANGE[1]} step={0.5} format={formatDegrees} onChange={onFov} testId="camera-fov" />
      <SliderField label={t.camera.pitch} value={camera.pitch * DEG} min={-PITCH_LIMIT * DEG} max={PITCH_LIMIT * DEG} step={0.1} format={formatDegrees} onChange={onPitch} testId="camera-pitch" />
      <SliderField label={t.camera.roll} value={camera.roll * DEG} min={-ROLL_LIMIT * DEG} max={ROLL_LIMIT * DEG} step={0.1} format={formatDegrees} onChange={onRoll} testId="camera-roll" />
      <SliderField label={t.camera.yaw} value={camera.yaw * DEG} min={-180} max={180} step={0.5} format={formatDegrees} onChange={onYaw} testId="camera-yaw" />
    </div>
  )
}

function LinesFields() {
  const camera = useApp((s) => s.doc.camera)
  const background = useApp((s) => s.doc.background)
  const axis = camera.lines?.secondAxis ?? 'horizontal'
  const solved = camera.lines && background ? solveLines(camera.lines, background) : null
  return (
    <div className="flex flex-col gap-3" data-testid="camera-lines">
      <span>{t.camera.axis}</span>
      <Segmented value={axis} options={LINE_AXES} label={(v) => t.camera.axes[v]} onChange={resetLines} testId="camera-axis" />
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
    </div>
  )
}

const GUIDE_OPTIONS = GUIDE_KINDS.map((value) => ({ value, label: t.camera.guide.kinds[value] }))

function GuideSection() {
  const { kind, scale, dim, setKind, setScale, setDim, resetOrigin } = useCameraGuide()
  const g = t.camera.guide
  return (
    <Group id="camera.guide" title={g.title} summary={g.kinds[kind]} help={g.hint} testId="camera-guide-section">
      <SelectField label={g.kind} value={kind} options={GUIDE_OPTIONS} onChange={setKind} testId="camera-guide-kind" />
      {kind !== 'none' && (
        <SliderField label={g.scale} value={scale} min={GUIDE_SCALE_RANGE[0]} max={GUIDE_SCALE_RANGE[1]} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={setScale} testId="camera-guide-scale" />
      )}
      <ToggleRow label={g.dim} checked={dim} onChange={setDim} testId="camera-dim-toggle" />
      <mdui-button variant="outlined" onClick={resetOrigin} data-testid="camera-guide-reset">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {g.resetOrigin}
      </mdui-button>
    </Group>
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
    <Group id="camera.result" title={r.title} summary={r.summary(fov(background.width), formatDegrees(camera.pitch * DEG))} testId="camera-solution">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-on-surface-variant">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Group>
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
    <Group id="camera.scale" title={sc.title} summary={sc.short[camera.heightSource]} help={[sc.why, sc.use, sc.rodHint]} testId="camera-scale">
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
      <More id="camera.scale.more">
        <SliderField label={sc.height} value={fromHeight(camera.height)} min={0} max={100} step={0.1} format={formatHeight} onChange={onHeight} testId="camera-height" />
        <Hint>{sc.heightHint}</Hint>
      </More>
    </Group>
  )
}
