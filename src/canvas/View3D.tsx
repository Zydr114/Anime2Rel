import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Point } from '@/algo/geometry'
import type { Vec3 } from '@/algo/sh'
import { notify } from '@/app/notify'
import { add, dot, mul } from '@/camera/vec'
import { t } from '@/i18n'
import { ORBIT_PITCH_LIMIT, orbitFrom, type Orbit, type View3d } from '@/scene3d/space'
import { beginDepthStroke, endDepthStroke, extendDepthStroke, useDepthBrush } from '@/state/depthEdit'
import { useFusion } from '@/state/fusion'
import { useApp } from '@/state/store'
import { useLighting } from '@/state/lighting'
import { currentScene, isView3dStep, useView3d } from '@/state/view3d'
import { View3DLights } from './View3DLights'
import { beginGroundMove, brushAt, clickScene, moveOnGround, pickScene, type GroundMove } from './view3dActions'

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

type Drag =
  | { id: number; kind: 'orbit' | 'pan'; x: number; y: number; orbit: Orbit }
  | { id: number; kind: 'move'; move: GroundMove }
  | { id: number; kind: 'paint'; last: Point }

/** 屏幕上移动不到画笔直径的这个比例时不加点 */
const PAINT_SPACING = 1 / 8

/**
 * 3D 视图的交互层：环绕、平移、缩放，回到相机视角。在摆放或融合步骤中打开 3D 视图时显示。
 * 摆放步骤中光源只显示不能拖动；在人物上左键拖动沿地面移动人物，选用深度画笔时在人物上画。
 */
export function View3D() {
  const open = useView3d((s) => s.open)
  const step = useApp((s) => s.step)
  const hasBackground = useApp((s) => s.doc.background !== null)
  if (!open || !isView3dStep(step) || !hasBackground) return null
  return <View3DLayer key={step} characterStep={step === 'place'} />
}

function View3DLayer({ characterStep }: { characterStep: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState<Drag['kind'] | null>(null)
  /** 光标的位置，以及是否在人物上（摆放步骤） */
  const [hover, setHover] = useState<{ at: Point; character: boolean } | null>(null)
  const cameraView = useView3d((s) => s.view?.kind === 'camera')
  const insets = useApp((s) => s.viewInsets)
  const lightTool = useLighting((s) => s.tool)
  // 摆放步骤中不用光源的添加和吸管工具
  const tool = characterStep ? 'select' : lightTool
  const brush = useFusion((s) => s.tool === 'depth') && characterStep
  const brushSize = useDepthBrush((s) => s.size)

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

  const local = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, drag: Drag) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = drag
    setDragging(drag.kind)
  }

  /** 摆放步骤中在人物上左键按下：画深度，或开始沿地面移动；返回是否已处理 */
  const characterDown = (e: ReactPointerEvent<HTMLDivElement>, at: Point): boolean => {
    if (brush) {
      const b = brushAt(at, brushSize)
      if (!b) return false
      if (!beginDepthStroke(b.uv, b.radius)) {
        e.preventDefault()
        notify(t.depthEdit.notReady)
        return true
      }
      startDrag(e, { id: e.pointerId, kind: 'paint', last: at })
      return true
    }
    if (pickScene(at)?.hit?.on !== 'character') return false
    const move = beginGroundMove(at)
    if (!move) return false
    useApp.getState().beginGesture()
    startDrag(e, { id: e.pointerId, kind: 'move', move })
    return true
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    e.stopPropagation()
    const at = local(e)
    if (characterStep && e.button === 0 && !e.shiftKey && characterDown(e, at)) return
    // 添加光源、吸管工具，或按住 Ctrl 点击：在所点的表面上操作，不旋转视角
    if (!characterStep && e.button === 0 && (tool !== 'select' || e.ctrlKey)) {
      e.preventDefault()
      clickScene(at, tool === 'select' ? 'place' : tool)
      return
    }
    const orbit = currentOrbit()
    if (!orbit) return
    // 左键环绕，中键、右键或按住 Shift 平移
    const kind = e.button === 0 && !e.shiftKey ? 'orbit' : e.button <= 2 ? 'pan' : null
    if (kind) startDrag(e, { id: e.pointerId, kind, x: e.clientX, y: e.clientY, orbit })
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (characterStep && (!d || d.kind === 'paint')) {
      const at = local(e)
      setHover({ at, character: !d ? pickScene(at)?.hit?.on === 'character' : true })
    }
    if (!d || d.id !== e.pointerId) return
    if (d.kind === 'move') return moveOnGround(d.move, local(e))
    if (d.kind === 'paint') {
      const at = local(e)
      if (Math.hypot(at.x - d.last.x, at.y - d.last.y) < brushSize * PAINT_SPACING) return
      d.last = at
      const b = brushAt(at, brushSize)
      if (b) extendDepthStroke(b.uv)
      return
    }
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
    const d = dragRef.current
    if (d?.id !== e.pointerId) return
    dragRef.current = null
    setDragging(null)
    if (d.kind === 'paint') endDepthStroke()
    if (d.kind === 'move') useApp.getState().endGesture()
  }

  // 在人物上：画笔显示画笔大小的圆，否则可以拖动；其他地方环绕
  const onCharacter = dragging === 'paint' || dragging === 'move' || (!dragging && !!hover?.character)
  const cursor =
    tool === 'add' ? 'copy' : tool === 'pick' ? 'crosshair' : onCharacter ? (brush ? 'none' : 'move') : dragging ? 'grabbing' : 'grab'

  return (
    <div
      ref={ref}
      className="absolute inset-0 touch-none select-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="view3d"
      data-view={cameraView ? 'camera' : 'orbit'}
      data-hover={hover?.character ? 'character' : undefined}
    >
      <View3DLights editable={!characterStep} />
      {brush && onCharacter && hover && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" data-testid="view3d-brush">
          <circle cx={hover.at.x} cy={hover.at.y} r={brushSize / 2} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
          <circle cx={hover.at.x} cy={hover.at.y} r={brushSize / 2} fill="none" stroke="white" strokeWidth={1.5} />
        </svg>
      )}
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
      </div>
    </div>
  )
}
