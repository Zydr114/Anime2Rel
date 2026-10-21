import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Engine, EngineOptions } from '@/engine/Engine'
import { zoomAt } from '@/algo/geometry'
import { importFiles } from '@/app/importer'
import { isGradeStep } from '@/app/steps'
import { currentFocusParams, currentRegionMask } from '@/focus/service'
import { currentFusionParams, currentMatte, currentNormals, currentShadowParams } from '@/fusion/service'
import { gradeParams } from '@/grade/params'
import { postParams } from '@/grade/post'
import { t } from '@/i18n'
import { computeBallPreview } from '@/lighting/preview'
import { resolveTheme, useAppearance } from '@/state/appearance'
import { getDepthResult, useDepth } from '@/state/depth'
import { useEngine } from '@/state/engine'
import { isExporting, useExport } from '@/state/export'
import { characterInfo, useFusion } from '@/state/fusion'
import { getAnalysis, useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import { currentDepthEdit } from '@/state/depthEdit'
import { currentScene, isView3dStep, useView3d } from '@/state/view3d'
import { CameraGizmo, CharacterGuide } from './CameraGizmo'
import { DepthBrush } from './DepthBrush'
import { FocusGizmo } from './FocusGizmo'
import { GroundGizmo } from './GroundGizmo'
import { LightGizmo } from './LightGizmo'
import { RegionBrush } from './RegionBrush'
import { TransformGizmo } from './TransformGizmo'
import { View3D } from './View3D'
import { WarpGizmo } from './WarpGizmo'
import { useSpaceHeld } from './useSpaceHeld'

const WHEEL_ZOOM_SPEED = 0.0015

/** 测试用的地址参数：renderer=webgl 强制使用 WebGL2，textureLimit 限制纹理尺寸，exportTile 总是分块导出并指定块的边长 */
function engineOptions(): EngineOptions {
  const q = new URLSearchParams(location.search)
  const size = (key: string) => {
    const v = Number(q.get(key))
    return Number.isInteger(v) && v > 0 ? v : undefined
  }
  return { forceWebGL: q.get('renderer') === 'webgl', textureLimit: size('textureLimit'), exportTile: size('exportTile') }
}

/** 画布视口：持有引擎画布，处理平移、缩放、拖放导入，并在上层叠加变换控件。 */
export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [panning, setPanning] = useState(false)
  const spaceHeld = useSpaceHeld()
  const hasDoc = useApp((s) => s.doc.background !== null)

  // 引擎：每次挂载创建独立的 canvas，避免 StrictMode 重复挂载时两个渲染器争用同一个上下文。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = document.createElement('canvas')
    canvas.className = 'absolute inset-0 block h-full w-full'
    host.appendChild(canvas)
    let engine: Engine | null = null
    let cancelled = false
    let unsubscribe = () => {}

    // three.js 体积较大，单独分包异步加载，首屏不必等待
    import('@/engine/Engine')
      .then(({ Engine }) => Engine.create(canvas, engineOptions()))
      .then((e) => {
        if (cancelled) {
          e.dispose()
          return
        }
        engine = e
        const s = useApp.getState()
        e.setView(s.view, s.viewport)
        e.setBackdrop(resolveTheme(useAppearance.getState()))
        const offTheme = useAppearance.subscribe((a) => e.setBackdrop(resolveTheme(a)))
        const syncDepth = () => {
          const { doc } = useApp.getState()
          const d = useDepth.getState()
          e.setDepth('background', getDepthResult(doc.background?.id))
          e.setDepth('character', getDepthResult(doc.character?.id))
          e.setDepthEdit(currentDepthEdit(doc))
          e.setDebug({ view: d.view, overlay: d.overlay, edgeAlign: d.edgeAlign })
        }
        // 灰球只在融合步骤显示
        const syncBall = () => {
          const { doc, step } = useApp.getState()
          const show = step === 'fusion' && useLighting.getState().showBall
          e.setBallPreview(show ? computeBallPreview(doc, getAnalysis(doc.background?.id), getDepthResult(doc.background?.id), characterInfo(doc)?.bbox) : null)
        }
        // 遮罩只在摆放步骤显示
        const syncFusion = () => {
          const { doc, step } = useApp.getState()
          const f = useFusion.getState()
          e.setCharacterNormals(currentNormals(doc))
          e.setCharacterMatte(currentMatte(doc))
          e.setFusion(currentFusionParams(doc))
          e.setOcclusionRegions(currentRegionMask(doc))
          e.setFocus(currentFocusParams(doc))
          e.setShadow(currentShadowParams(doc))
          e.setGrade(gradeParams(doc.grade))
          e.setPost(postParams(doc.post, doc.lighting, doc.background, doc.camera.fovDeg, doc.focus.dof))
          // 调色、镜头步骤中的前后对比显示调色前的结果，其他步骤显示直接贴上去的结果；场景步骤中只看背景原图，调试视图除外
          const compare = !f.compare ? 'off' : isGradeStep(step) ? 'grade' : 'raw'
          // 二维摆放步骤中使用深度画笔时，立绘叠加深度伪彩色
          const relief = step === 'place' && f.tool === 'depth' && !useView3d.getState().open
          e.setDisplay({ compare, showNormals: f.showNormals, showMask: f.showMask && step === 'place', original: step === 'scene' && useDepth.getState().view === 'composite', relief })
        }
        // 3D 视图在摆放和融合步骤中显示；灰球和选中的光源只在融合步骤中显示
        const sync3d = () => {
          const { doc, step } = useApp.getState()
          const { open, view } = useView3d.getState()
          const bg = doc.background
          const s = open && view && isView3dStep(step) ? currentScene(view) : null
          if (!s || !view || !bg) return e.setScene3d(null)
          const depth = getDepthResult(bg.id)
          const light = step === 'fusion'
          const ball = light && useLighting.getState().showBall ? computeBallPreview(doc, getAnalysis(bg.id), depth, characterInfo(doc)?.bbox) : null
          const selected = light ? useLighting.getState().selected : null
          e.setScene3d({ ...s, cameraView: view.kind === 'camera', camera: doc.camera, size: bg, depth, ball, insets: useApp.getState().viewInsets, selected })
        }
        const syncAll = () => {
          e.setDocument(useApp.getState().doc)
          syncDepth()
          syncBall()
          syncFusion()
          sync3d()
        }
        syncAll()
        // 导出期间引擎逐块渲染，文档的变化等导出结束后再一起同步
        const offExport = useExport.subscribe((next, prev) => {
          if (next.progress === null && prev.progress !== null) syncAll()
        })
        const offView3d = useView3d.subscribe((next, prev) => {
          if (isExporting()) return
          sync3d()
          if (next.open !== prev.open) syncFusion()
        })
        const offApp = useApp.subscribe((next, prev) => {
          if (next.view !== prev.view || next.viewport !== prev.viewport) e.setView(next.view, next.viewport)
          if (isExporting()) return
          if (next.doc !== prev.doc || next.step !== prev.step || next.view !== prev.view || next.viewport !== prev.viewport) sync3d()
          if (next.doc !== prev.doc) {
            e.setDocument(next.doc)
            syncDepth()
          }
          if (next.doc !== prev.doc || next.step !== prev.step) {
            syncBall()
            syncFusion()
          }
        })
        const offDepth = useDepth.subscribe((next, prev) => {
          if (isExporting()) return
          if (next.resultsVersion !== prev.resultsVersion || next.view !== prev.view || next.overlay !== prev.overlay || next.edgeAlign !== prev.edgeAlign) syncDepth()
          if (next.resultsVersion !== prev.resultsVersion) {
            syncBall()
            sync3d()
          }
          if (next.resultsVersion !== prev.resultsVersion || next.view !== prev.view) syncFusion()
        })
        const offLighting = useLighting.subscribe((next, prev) => {
          if (isExporting()) return
          if (next.analyses !== prev.analyses || next.showBall !== prev.showBall) syncBall()
          if (next.analyses !== prev.analyses || next.showBall !== prev.showBall || next.selected !== prev.selected) sync3d()
          if (next.analyses !== prev.analyses) syncFusion()
        })
        const offFusion = useFusion.subscribe((next, prev) => {
          if (isExporting()) return
          if (next.character !== prev.character || next.warped !== prev.warped) {
            syncBall()
            sync3d()
          }
          syncFusion()
        })
        unsubscribe = () => {
          offTheme()
          offView3d()
          offExport()
          offApp()
          offDepth()
          offLighting()
          offFusion()
        }
        useEngine.getState().setEngine(e)
      })
      .catch((err: unknown) => {
        if (!cancelled) useEngine.getState().setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      unsubscribe()
      if (engine) {
        useEngine.getState().setEngine(null)
        engine.dispose()
      }
      canvas.remove()
    }
  }, [])

  // 视口尺寸：首次获得文档或尺寸变化时自动适应窗口
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      const s = useApp.getState()
      const prev = s.viewport
      s.setViewport({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) })
      if (s.doc.background && (prev.width <= 1 || prev.height <= 1)) s.fitToView()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 滚轮缩放（以光标为中心）。需要非被动监听才能阻止页面滚动。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!useApp.getState().doc.background) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      const factor = Math.exp(-e.deltaY * unit * WHEEL_ZOOM_SPEED * (e.ctrlKey ? 4 : 1))
      const s = useApp.getState()
      s.setView(zoomAt(s.view, factor, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 中键、空格 + 左键、或在空白处左键拖动都用于平移；立绘、光源上的拖动由各自的控件处理。
    const isPanButton = e.button === 1 || (e.button === 0 && (spaceHeld || e.target === e.currentTarget))
    if (!isPanButton || !hasDoc) return
    e.preventDefault()
    const { view } = useApp.getState()
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY }
    e.currentTarget.setPointerCapture(e.pointerId)
    setPanning(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current
    if (!p || p.id !== e.pointerId) return
    const s = useApp.getState()
    s.setView({ ...s.view, panX: p.panX + e.clientX - p.x, panY: p.panY + e.clientY - p.y })
  }

  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.id !== e.pointerId) return
    panRef.current = null
    setPanning(false)
  }

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="viewport">
      <div ref={hostRef} className="absolute inset-0" />
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none select-none"
        style={{ cursor: panning ? 'grabbing' : spaceHeld && hasDoc ? 'grab' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files, 'auto')
        }}
      >
        <CameraGizmo passThrough={spaceHeld || panning} />
        <CharacterGuide />
        <TransformGizmo passThrough={spaceHeld || panning} />
        <LightGizmo passThrough={spaceHeld || panning} />
        <FocusGizmo passThrough={spaceHeld || panning} />
        <RegionBrush passThrough={spaceHeld || panning} />
        <GroundGizmo passThrough={spaceHeld || panning} />
        <WarpGizmo passThrough={spaceHeld || panning} />
        <DepthBrush passThrough={spaceHeld || panning} />
        <View3D />
      </div>
      {dragOver && (
        <div className="pointer-events-none absolute inset-4 flex items-center justify-center rounded-3xl border-2 border-dashed border-primary/70 bg-primary/10 text-lg">
          {t.assets.dropHint}
        </div>
      )}
    </div>
  )
}
