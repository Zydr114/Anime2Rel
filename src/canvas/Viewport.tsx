import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Engine } from '@/engine/Engine'
import { zoomAt } from '@/algo/geometry'
import { importFiles } from '@/app/importer'
import { isGradeStep } from '@/app/steps'
import { currentFocusParams, currentRegionMask } from '@/focus/service'
import { currentFusionParams, currentNormals, currentShadowParams } from '@/fusion/service'
import { gradeParams } from '@/grade/params'
import { t } from '@/i18n'
import { computeBallPreview } from '@/lighting/preview'
import { getDepthResult, useDepth } from '@/state/depth'
import { useEngine } from '@/state/engine'
import { characterBBox, useFusion } from '@/state/fusion'
import { getAnalysis, useLighting } from '@/state/lighting'
import { useApp } from '@/state/store'
import { FocusGizmo } from './FocusGizmo'
import { GroundGizmo } from './GroundGizmo'
import { LightGizmo } from './LightGizmo'
import { RegionBrush } from './RegionBrush'
import { TransformGizmo } from './TransformGizmo'
import { useSpaceHeld } from './useSpaceHeld'

const WHEEL_ZOOM_SPEED = 0.0015

function forcedWebGL(): boolean {
  return new URLSearchParams(location.search).get('renderer') === 'webgl'
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
      .then(({ Engine }) => Engine.create(canvas, { forceWebGL: forcedWebGL() }))
      .then((e) => {
        if (cancelled) {
          e.dispose()
          return
        }
        engine = e
        const s = useApp.getState()
        e.setView(s.view, s.viewport)
        e.setDocument(s.doc)
        const syncDepth = () => {
          const { doc } = useApp.getState()
          const d = useDepth.getState()
          e.setDepth('background', getDepthResult(doc.background?.id))
          e.setDepth('character', getDepthResult(doc.character?.id))
          e.setDebug({ view: d.view, overlay: d.overlay, edgeAlign: d.edgeAlign })
        }
        // 灰球只在光源步骤显示
        const syncBall = () => {
          const { doc, step } = useApp.getState()
          const show = step === 'light' && useLighting.getState().showBall
          e.setBallPreview(show ? computeBallPreview(doc, getAnalysis(doc.background?.id), getDepthResult(doc.background?.id), characterBBox(doc.character?.id)) : null)
        }
        // 遮罩只在景深步骤显示
        const syncFusion = () => {
          const { doc, step } = useApp.getState()
          const f = useFusion.getState()
          e.setCharacterNormals(currentNormals(doc))
          e.setFusion(currentFusionParams(doc))
          e.setOcclusionRegions(currentRegionMask(doc))
          e.setFocus(currentFocusParams(doc))
          e.setShadow(currentShadowParams(doc))
          e.setGrade(gradeParams(doc.grade))
          // 调色、后期步骤中的前后对比显示调色前的结果，其他步骤显示直接贴上去的结果
          const compare = !f.compare ? 'off' : isGradeStep(step) ? 'grade' : 'raw'
          e.setDisplay({ compare, showNormals: f.showNormals, showMask: f.showMask && step === 'focus' })
        }
        syncDepth()
        syncBall()
        syncFusion()
        const offApp = useApp.subscribe((next, prev) => {
          if (next.doc !== prev.doc) {
            e.setDocument(next.doc)
            syncDepth()
          }
          if (next.doc !== prev.doc || next.step !== prev.step) {
            syncBall()
            syncFusion()
          }
          if (next.view !== prev.view || next.viewport !== prev.viewport) e.setView(next.view, next.viewport)
        })
        const offDepth = useDepth.subscribe((next, prev) => {
          if (next.resultsVersion !== prev.resultsVersion || next.view !== prev.view || next.overlay !== prev.overlay || next.edgeAlign !== prev.edgeAlign) syncDepth()
          if (next.resultsVersion !== prev.resultsVersion) {
            syncBall()
            syncFusion()
          }
        })
        const offLighting = useLighting.subscribe((next, prev) => {
          if (next.analyses !== prev.analyses || next.showBall !== prev.showBall) syncBall()
          if (next.analyses !== prev.analyses) syncFusion()
        })
        const offFusion = useFusion.subscribe((next, prev) => {
          if (next.character !== prev.character) syncBall()
          syncFusion()
        })
        unsubscribe = () => {
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
        <TransformGizmo passThrough={spaceHeld || panning} />
        <LightGizmo passThrough={spaceHeld || panning} />
        <FocusGizmo passThrough={spaceHeld || panning} />
        <RegionBrush passThrough={spaceHeld || panning} />
        <GroundGizmo passThrough={spaceHeld || panning} />
      </div>
      {dragOver && (
        <div className="pointer-events-none absolute inset-4 flex items-center justify-center rounded-3xl border-2 border-dashed border-primary/70 bg-primary/10 text-lg">
          {t.assets.dropHint}
        </div>
      )}
    </div>
  )
}
