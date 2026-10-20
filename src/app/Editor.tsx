import { createElement, useEffect, useRef, useState } from 'react'
import type { NavigationRail } from 'mdui/components/navigation-rail.js'
import { startAutoAnalysis } from '@/analysis/service'
import { startAutoDepth } from '@/depth/service'
import { startAutoFusion } from '@/fusion/service'
import { t } from '@/i18n'
import { cameraPending, needsCamera, stepLocked, useApp, type StepId } from '@/state/store'
import { cn } from '@/ui/lib/cn'
import { useDomEvent } from '@/ui/useDomEvent'
import { AboutDialog } from './AboutDialog'
import { LegalLinks } from './LegalLinks'
import { AdjustPanel } from './panels/AdjustPanel'
import { notify } from './notify'
import { AssetsPanel } from './panels/AssetsPanel'
import { CameraPanel } from './panels/CameraPanel'
import { CharacterPanel } from './panels/CharacterPanel'
import { DepthPanel } from './panels/DepthPanel'
import { EffectsPanel } from './panels/EffectsPanel'
import { ExportPanel } from './panels/ExportPanel'
import { FocusPanel } from './panels/FocusPanel'
import { LightPanel } from './panels/LightPanel'
import { startAutosave } from './project'
import { steps } from './steps'
import { Toolbar } from './Toolbar'
import { useShortcuts } from './useShortcuts'

function StepPanel({ step }: { step: StepId }) {
  if (step === 'assets') return <AssetsPanel />
  if (step === 'camera') return <CameraPanel />
  if (step === 'depth') return <DepthPanel />
  if (step === 'light') return <LightPanel />
  if (step === 'character') return <CharacterPanel />
  if (step === 'focus') return <FocusPanel />
  if (step === 'adjust') return <AdjustPanel />
  if (step === 'effects') return <EffectsPanel />
  return <ExportPanel />
}

/** 切换步骤；相机标定还没有确认时提示并留在原处 */
function goToStep(step: StepId): boolean {
  const s = useApp.getState()
  if (stepLocked(s.doc, step)) {
    notify(t.camera.lockedNotice)
    return false
  }
  s.setStep(step)
  return true
}

/** 编辑器外框：左侧步骤导航、右侧检查器、底部工具栏。画布由 App 常驻渲染。 */
export function Editor() {
  const step = useApp((s) => s.step)
  const pending = useApp((s) => cameraPending(s.doc))
  const [aboutOpen, setAboutOpen] = useState(false)
  const railRef = useRef<NavigationRail>(null)
  useShortcuts()
  // 编辑器打开后自动加载模型并估计深度，深度就绪后分析光源
  useEffect(() => startAutoDepth(), [])
  useEffect(() => startAutoAnalysis(), [])
  useEffect(() => startAutoFusion(), [])
  // 编辑内容自动保存在浏览器中，下次打开页面时可以在首屏继续
  useEffect(() => startAutosave(), [])

  useDomEvent(railRef, 'change', (_e, el) => {
    if (!el.value || goToStep(el.value as StepId)) return
    // 导航栏的选中项由组件自己切换；不能进入时等它更新完再改回当前步骤（同一次更新中改回会被当作没有变化）
    void el.updateComplete.then(() => {
      el.value = useApp.getState().step
    })
  })

  const current = steps.find((s) => s.id === step)

  return (
    <>
      <nav className="glass absolute top-4 bottom-4 left-4 w-20 overflow-hidden rounded-3xl">
        <mdui-navigation-rail ref={railRef} contained value={step} alignment="center" style={{ background: 'transparent' }} data-testid="steps">
          <div slot="top" className="flex flex-col items-center gap-1 pt-2 pb-3">
            <img src="./favicon.svg" alt="" className="size-9" />
          </div>
          {steps.map((s) => (
            <mdui-navigation-rail-item
              key={s.id}
              value={s.id}
              className={cn(pending && needsCamera(s.id) && 'opacity-40')}
              data-testid={`step-${s.id}`}
            >
              {s.label}
              {createElement(`mdui-icon-${s.icon}`, { slot: 'icon' })}
            </mdui-navigation-rail-item>
          ))}
          <div slot="bottom" className="pb-2">
            <mdui-button-icon onClick={() => setAboutOpen(true)} data-testid="about-button">
              <mdui-icon-info--outlined />
            </mdui-button-icon>
          </div>
        </mdui-navigation-rail>
      </nav>

      <aside className="glass absolute top-4 right-4 bottom-4 flex w-80 flex-col rounded-3xl" data-testid="inspector">
        <header className="px-5 pt-5 pb-3">
          <h2 className="text-lg font-semibold">{current?.label}</h2>
        </header>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <StepPanel step={step} />
        </div>
        <footer className="border-t border-white/10 px-4 py-3">
          <LegalLinks />
        </footer>
      </aside>

      <div className="absolute bottom-4 left-28 right-88 flex justify-center">
        <Toolbar onExport={() => goToStep('export')} />
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <span className="sr-only">{t.app.name}</span>
    </>
  )
}
