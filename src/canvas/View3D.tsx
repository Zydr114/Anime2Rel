import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Vec3 } from '@/algo/sh'
import { add, dot, mul } from '@/camera/vec'
import { t } from '@/i18n'
import { ORBIT_PITCH_LIMIT, orbitFrom, type Orbit, type View3d } from '@/scene3d/space'
import { useApp } from '@/state/store'
import { currentScene, useView3d } from '@/state/view3d'

/** 拖动一个视口高度旋转的角度 */
const ROTATE = Math.PI
const WHEEL_ZOOM_SPEED = 0.0015
/** 初始的环绕视角：从原相机的位置向右上方转开 */
const INITIAL_YAW = (35 * Math.PI) / 180
const INITIAL_PITCH = (20 * Math.PI) / 180

const clampPitch = (v: number) => Math.max(-ORBIT_PITCH_LIMIT, Math.min(ORBIT_PITCH_LIMIT, v))

/** 当前视角对应的环绕视角。原相机视角下环绕中心取视线上与立绘等远的点，转换时画面不跳 */
function currentOrbit(): Orbit | null {
  const view = useView3d.getState().view
  if (view?.kind === 'orbit') return view.orbit
  const s = currentScene({ kind: 'camera' })
  if (!s) return null
  const { projection: p, layout } = s
  const along = dot(add(layout.target, p.position, -1), mul(p.back, -1))
  return orbitFrom(p, add(p.position, p.back, -(along > 0 ? along : layout.reference)), useApp.getState().viewInsets)
}

function initialView(): View3d | null {
  const s = currentScene({ kind: 'camera' })
  if (!s) return null
  const o = orbitFrom(s.projection, s.layout.target, useApp.getState().viewInsets)
  return { kind: 'orbit', orbit: { ...o, yaw: o.yaw + INITIAL_YAW, pitch: clampPitch(o.pitch + INITIAL_PITCH) } }
}

type Drag = { id: number; kind: 'orbit' | 'pan'; x: number; y: number; orbit: Orbit }

/** 3D 视图的交互层：环绕、平移、缩放，回到相机视角。只在光源步骤中打开 3D 视图时显示 */
export function View3D() {
  const open = useView3d((s) => s.open)
  const step = useApp((s) => s.step)
  const hasBackground = useApp((s) => s.doc.background !== null)
  if (!open || step !== 'light' || !hasBackground) return null
  return <View3DLayer />
}

function View3DLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const cameraView = useView3d((s) => s.view?.kind === 'camera')
  const insets = useApp((s) => s.viewInsets)

  useEffect(() => {
    if (!useView3d.getState().view) {
      const v = initialView()
      if (v) useView3d.getState().setView(v)
    }
  }, [])

  // 滚轮缩放到环绕中心的距离；需要非被动监听才能阻止二维视图的缩放
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const o = currentOrbit()
      if (!o) return
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const s = currentScene()
      const reference = s?.layout.reference ?? 1
      const distance = Math.max(0.02 * reference, Math.min(50 * reference, o.distance * Math.exp(e.deltaY * unit * WHEEL_ZOOM_SPEED)))
      useView3d.getState().setView({ kind: 'orbit', orbit: { ...o, distance } })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    e.stopPropagation()
    const orbit = currentOrbit()
    if (!orbit) return
    // 左键环绕，中键、右键或按住 Shift 平移
    const kind = e.button === 0 && !e.shiftKey ? 'orbit' : e.button <= 2 ? 'pan' : null
    if (!kind) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { id: e.pointerId, kind, x: e.clientX, y: e.clientY, orbit }
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    const height = ref.current?.clientHeight || 1
    const o = d.orbit
    if (d.kind === 'orbit') {
      useView3d.getState().setView({ kind: 'orbit', orbit: { ...o, yaw: o.yaw - (dx / height) * ROTATE, pitch: clampPitch(o.pitch + (dy / height) * ROTATE) } })
      return
    }
    const p = currentScene({ kind: 'orbit', orbit: o })?.projection
    if (!p) return
    const k = o.distance / p.focal
    const target: Vec3 = add(add(o.target, p.right, -dx * k), p.up, dy * k)
    useView3d.getState().setView({ kind: 'orbit', orbit: { ...o, target } })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div
      ref={ref}
      className="absolute inset-0 touch-none select-none"
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="view3d"
      data-view={cameraView ? 'camera' : 'orbit'}
    >
      <div className="pointer-events-none absolute flex flex-col items-center gap-2" style={{ left: insets.left, right: insets.right, top: insets.top }}>
        <mdui-button
          variant="tonal"
          className="pointer-events-auto"
          disabled={cameraView || undefined}
          onClick={() => useView3d.getState().setView({ kind: 'camera' })}
          data-testid="view3d-camera"
        >
          <mdui-icon-photo-camera--outlined slot="icon" />
          {t.view3d.toCamera}
        </mdui-button>
        <p className="rounded-xl bg-black/45 px-3 py-1 text-center text-xs leading-5 text-white/80" data-testid="view3d-notice">
          {t.view3d.notice}
        </p>
      </div>
    </div>
  )
}
