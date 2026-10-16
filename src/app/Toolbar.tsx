import { t } from '@/i18n'
import { useApp } from '@/state/store'
import { Dock, DockIcon } from '@/ui/magicui/dock'
import { IconButton } from '@/ui/IconButton'
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
        <IconButton label={t.toolbar.export} onClick={onExport}>
          <mdui-icon-download--outlined />
        </IconButton>
      </DockIcon>
    </Dock>
  )
}
