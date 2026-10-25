import { useRef, useState } from 'react'
import type { Dropdown } from 'mdui/components/dropdown.js'
import type { Menu } from 'mdui/components/menu.js'
import { t } from '@/i18n'
import { DEBUG_VIEWS, useDepth, type DebugView } from '@/state/depth'
import { useFusion } from '@/state/fusion'
import { useLighting } from '@/state/lighting'
import { useApp, type StepId } from '@/state/store'
import { isView3dStep, useView3d } from '@/state/view3d'
import { Dock, DockIcon } from '@/ui/magicui/dock'
import { IconButton } from '@/ui/IconButton'
import { useDomEvent } from '@/ui/useDomEvent'
import { goToStep } from './navigation'
import { isGradeStep } from './steps'
import { zoomBy } from './viewActions'

/** 开关类按钮按下时的样式 */
const ACTIVE = 'bg-primary/20 text-primary hover:bg-primary/25'

/** 底部工具栏（Magic UI Dock）。 */
export function Toolbar() {
  const zoom = useApp((s) => s.view.zoom)
  const canUndo = useApp((s) => s.past.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const fitToView = useApp((s) => s.fitToView)
  const hasCharacter = useApp((s) => !!s.doc.character)
  const gradeStep = useApp((s) => isGradeStep(s.step))
  const compare = useFusion((s) => s.compare)
  const view3dStep = useApp((s) => isView3dStep(s.step) && s.doc.background !== null)
  const view3d = useView3d((s) => s.open) && view3dStep

  return (
    <Dock className="glass relative" iconSize={40} iconMagnification={52} iconDistance={110} data-tour="toolbar">
      <DockIcon>
        <IconButton label={t.toolbar.zoomOut} onClick={() => zoomBy(1 / 1.25)}>
          <mdui-icon-zoom-out--outlined />
        </IconButton>
      </DockIcon>
      <div className="w-14 text-center text-sm tabular-nums text-on-surface-variant" data-testid="zoom-label">
        {Math.round(zoom * 100)}%
      </div>
      <DockIcon>
        <IconButton label={t.toolbar.zoomIn} onClick={() => zoomBy(1.25)}>
          <mdui-icon-zoom-in--outlined />
        </IconButton>
      </DockIcon>
      <DockIcon>
        <IconButton label={t.toolbar.fit} onClick={fitToView} testId="fit">
          <mdui-icon-fit-screen--outlined />
        </IconButton>
      </DockIcon>
      <div className="mx-1 h-6 w-px bg-on-surface/15" />
      <DockIcon>
        <IconButton label={t.toolbar.undo} onClick={undo} disabled={!canUndo} testId="undo">
          <mdui-icon-undo--outlined />
        </IconButton>
      </DockIcon>
      <DockIcon>
        <IconButton label={t.toolbar.redo} onClick={redo} disabled={!canRedo} testId="redo">
          <mdui-icon-redo--outlined />
        </IconButton>
      </DockIcon>
      <div className="mx-1 h-6 w-px bg-on-surface/15" />
      <DockIcon>
        <IconButton
          label={gradeStep ? t.toolbar.compareGrade : t.toolbar.compare}
          onClick={() => useFusion.getState().setCompare(!compare)}
          disabled={!hasCharacter && !gradeStep}
          pressed={compare}
          className={compare ? ACTIVE : undefined}
          testId="compare"
        >
          <mdui-icon-compare--outlined />
        </IconButton>
      </DockIcon>
      <DockIcon>
        <IconButton
          label={view3dStep ? t.toolbar.view3d : t.toolbar.view3dUnavailable}
          onClick={() => useView3d.getState().setOpen(!view3d)}
          disabled={!view3dStep}
          pressed={view3d}
          className={view3d ? ACTIVE : undefined}
          testId="view3d-toggle"
        >
          <mdui-icon-3d-rotation--outlined />
        </IconButton>
      </DockIcon>
      <DockIcon>
        <DebugViewMenu />
      </DockIcon>
      <DockIcon>
        <IconButton label={t.toolbar.export} onClick={() => goToStep('export')}>
          <mdui-icon-download--outlined />
        </IconButton>
      </DockIcon>
      <TaskStatus />
    </Dock>
  )
}

type Task = { error: false; text: string; progress?: number } | { error: true; text: string; step: StepId; group: string }

/** 正在进行或出错的后台任务：深度模型的加载、深度估计和光源分析，按先后顺序只显示一项 */
function useTask(): Task | null {
  const model = useDepth((s) => s.model)
  const jobs = useDepth((s) => s.jobs)
  const background = useApp((s) => s.doc.background?.id)
  const character = useApp((s) => s.doc.character?.id)
  const analysis = useLighting((s) => (background ? s.analyses[background] : undefined))
  const depth = [background, character].map((id) => (id ? jobs[id] : undefined))
  if (model.state === 'error') return { error: true, text: t.tasks.modelFailed, step: 'scene', group: 'depth.estimate' }
  if (depth.some((j) => j?.state === 'error')) return { error: true, text: t.tasks.depthFailed, step: 'scene', group: 'depth.estimate' }
  if (analysis?.state === 'error') return { error: true, text: t.tasks.analysisFailed, step: 'fusion', group: 'light.analysis' }
  if (model.state === 'loading') return { error: false, text: t.depth.phase[model.phase], progress: model.total > 0 ? model.loaded / model.total : undefined }
  if (depth.some((j) => j?.state === 'queued' || j?.state === 'running')) return { error: false, text: t.tasks.depth }
  if (analysis?.state === 'running') return { error: false, text: t.tasks.analysis }
  return null
}

/** 后台任务的状态（docs/Plan.md §3.7 M8.7），完成后隐藏；出错时点击进入对应的步骤 */
function TaskStatus() {
  const task = useTask()
  if (!task) return null
  return (
    <>
      <div className="mx-1 h-6 w-px bg-on-surface/15" />
      {task.error ? (
        <mdui-tooltip content={t.tasks.open} placement="top">
          <button
            type="button"
            className="flex h-10 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap text-error transition-colors hover:bg-on-surface/10"
            onClick={() => goToStep(task.step, task.group)}
            data-testid="task-status"
            data-state="error"
          >
            <mdui-icon-error--outlined className="size-5" />
            {task.text}
          </button>
        </mdui-tooltip>
      ) : (
        <div className="flex items-center gap-2 px-2 text-sm whitespace-nowrap text-on-surface-variant" data-testid="task-status" data-state="running">
          <mdui-circular-progress className="size-5" value={task.progress} max={1} />
          <span className="tabular-nums">{task.progress === undefined ? task.text : `${task.text} ${Math.round(task.progress * 100)}%`}</span>
        </div>
      )}
    </>
  )
}

/** 调试视图切换菜单。非合成视图时按钮高亮。 */
function DebugViewMenu() {
  const view = useDepth((s) => s.view)
  const setView = useDepth((s) => s.setView)
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<Dropdown>(null)
  const menuRef = useRef<Menu>(null)
  useDomEvent(menuRef, 'change', (_e, el) => {
    if (typeof el.value === 'string' && el.value) setView(el.value as DebugView)
    else el.value = view
  })
  // 菜单打开期间隐藏按钮的悬浮提示，否则提示会遮住最下面的菜单项。
  // mdui 的事件会冒泡，需排除内部提示框自身的 open/closed 事件
  useDomEvent(dropdownRef, 'open', (e, el) => e.target === el && setOpen(true))
  useDomEvent(dropdownRef, 'closed', (e, el) => e.target === el && setOpen(false))

  return (
    <mdui-dropdown ref={dropdownRef} placement="top">
      <div slot="trigger" className="size-full">
        <IconButton
          label={t.toolbar.debugView}
          onClick={() => {}}
          tooltipDisabled={open}
          className={view === 'composite' ? undefined : ACTIVE}
          testId="debug-view"
        >
          <mdui-icon-preview--outlined />
        </IconButton>
      </div>
      <mdui-menu ref={menuRef} selects="single" value={view} data-testid="debug-view-menu">
        {DEBUG_VIEWS.map((v) => (
          <mdui-menu-item key={v} value={v}>
            {t.depth.views[v]}
          </mdui-menu-item>
        ))}
      </mdui-menu>
    </mdui-dropdown>
  )
}
