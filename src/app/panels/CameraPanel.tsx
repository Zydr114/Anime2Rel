import { useCallback } from 'react'
import { linesFromCamera, solveLines } from '@/camera/geometry'
import { BOX_RANGE, GUIDE_KINDS } from '@/camera/guides'
import { CALIBRATION_METHODS, FOV_RANGE, HEIGHT_RANGE, LINE_AXES, PITCH_LIMIT, ROLL_LIMIT, type CalibrationMethod, type CameraDoc, type LineAxis } from '@/camera/model'
import { t } from '@/i18n'
import { useCameraGuide } from '@/state/cameraGuide'
import { useApp } from '@/state/store'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { SliderField } from '@/ui/SliderField'
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
        <Segmented value={method} options={CALIBRATION_METHODS} label={(v) => t.camera.methods[v]} onChange={setMethod} testId="camera-method" />
        <Hint>{method === 'horizon' ? t.camera.horizonHint : t.camera.linesHint}</Hint>
      </Section>
      {method === 'horizon' ? <HorizonSection /> : <LinesSection />}
      <GuideSection />
      <HeightSection />
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
      <mdui-button variant="filled" onClick={() => useApp.getState().confirmCamera()} data-testid="camera-confirm">
        {t.camera.confirm}
      </mdui-button>
    </section>
  )
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
      <div className="flex flex-col gap-1 rounded-xl bg-white/5 px-3 py-2" data-testid="camera-solution">
        <span className="text-on-surface-variant">{t.camera.solved}</span>
        <span className="tabular-nums">
          {t.camera.fov} {formatDegrees(camera.fovDeg)} · {t.camera.pitch} {formatDegrees(camera.pitch * DEG)} · {t.camera.roll} {formatDegrees(camera.roll * DEG)}
        </span>
        {solved && !solved.ok && (
          <span className="text-xs leading-5 text-error" data-testid="camera-solve-error">
            {t.camera.solveErrors[solved.error]}
            {t.camera.keepLast}
          </span>
        )}
      </div>
      <mdui-button variant="outlined" onClick={() => resetLines(axis)} data-testid="camera-reset-lines">
        <mdui-icon-restart-alt--outlined slot="icon" />
        {t.camera.resetLines}
      </mdui-button>
    </Section>
  )
}

const GUIDE_OPTIONS = GUIDE_KINDS.map((value) => ({ value, label: t.camera.guide.kinds[value] }))

function GuideSection() {
  const { kind, boxSize, dim, setKind, setBoxSize, setDim, resetOrigin } = useCameraGuide()
  const g = t.camera.guide
  return (
    <Section title={g.title} testId="camera-guide-section">
      <SelectField label={g.kind} value={kind} options={GUIDE_OPTIONS} onChange={setKind} testId="camera-guide-kind" />
      {kind === 'box' && (
        <SliderField label={g.boxSize} value={boxSize} min={BOX_RANGE[0]} max={BOX_RANGE[1]} step={0.05} format={(v) => `${v.toFixed(2)} m`} onChange={setBoxSize} testId="camera-box-size" />
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

function HeightSection() {
  const height = useApp((s) => s.doc.camera.height)
  const onHeight = useGestureChange(useCallback((v: number) => useApp.getState().updateCamera({ height: toHeight(v) }), []))
  return (
    <Section title={t.camera.height}>
      <SliderField label={t.camera.height} value={fromHeight(height)} min={0} max={100} step={0.1} format={formatHeight} onChange={onHeight} testId="camera-height" />
      <Hint>{t.camera.heightHint}</Hint>
    </Section>
  )
}
