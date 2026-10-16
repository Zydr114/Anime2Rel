import { useRef, useState } from 'react'
import type { Dropdown } from 'mdui/components/dropdown.js'
import type { Menu } from 'mdui/components/menu.js'
import { t } from '@/i18n'
import { DEBUG_VIEWS, useDepth, type DebugView } from '@/state/depth'
import { useApp } from '@/state/store'
import { Dock, DockIcon } from '@/ui/magicui/dock'
import { IconButton } from '@/ui/IconButton'
import { useDomEvent } from '@/ui/useDomEvent'
import { zoomBy } from './viewActions'

/** 底部工具栏（Magic UI Dock）。 */
export function Toolbar({ onExport }: { onExport: () => void }) {
  const zoom = useApp((s) => s.view.zoom)
  const canUndo = useApp((s) => s.past.length > 0)
  const canRedo = useApp((s) => s.future.length > 0)
  const undo = useApp((s) => s.undo)
  const redo = useApp((s) => s.redo)
  const fitToView = useApp((s) => s.fitToView)

  return (
    <Dock className="glass" iconSize={40} iconMagnification={52} iconDistance={110}>
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
      <div className="mx-1 h-6 w-px bg-white/15" />
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
      <div className="mx-1 h-6 w-px bg-white/15" />
      <DockIcon>
        <DebugViewMenu />
      </DockIcon>
      <DockIcon>
        <IconButton label={t.toolbar.export} onClick={onExport}>
          <mdui-icon-download--outlined />
        </IconButton>
      </DockIcon>
    </Dock>
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
          className={view === 'composite' ? undefined : 'bg-primary/20 text-primary hover:bg-primary/25'}
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
