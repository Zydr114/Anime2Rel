import { Fragment } from 'react'
import { t } from '@/i18n'
import { useFusion } from '@/state/fusion'
import { useLighting } from '@/state/lighting'
import { usePrefs } from '@/state/prefs'
import { useRegionTool } from '@/state/regions'
import { useApp } from '@/state/store'
import { useView3dShown } from '@/state/view3d'

type Rows = readonly (readonly string[])[]

const h = t.opHints

/** 当前可用的鼠标和键盘操作，随步骤、工具和二维 / 3D 视图变化；notice 为 3D 视图的说明 */
function useHints(): { rows: Rows; notice?: string } {
  const step = useApp((s) => s.step)
  const hasBackground = useApp((s) => s.doc.background !== null)
  const hasCharacter = useApp((s) => s.doc.character !== null)
  const method = useApp((s) => s.doc.camera.method)
  const tool = useFusion((s) => s.tool)
  const lightTool = useLighting((s) => s.tool)
  const region = useRegionTool((s) => s.active !== null)
  const view3d = useView3dShown()

  if (!hasBackground) return { rows: [] }
  if (view3d) {
    const own = step === 'place' ? (tool === 'depth' ? h.view3d.paint : h.view3d.move) : h.view3d.lights
    return { rows: [...own, ...h.view3d.orbit], notice: t.view3d.notice }
  }
  const rows = ((): Rows => {
    if (step === 'assets') return hasCharacter ? h.transform : []
    if (step === 'scene') return [...(method === 'horizon' ? h.horizon : h.lines), ...h.guide]
    if (step === 'place') {
      if (tool === 'transform') return [...h.transform, ...h.ground]
      if (tool === 'region') return region ? h.region : h.regionNone
      return h[tool]
    }
    if (step === 'fusion') return lightTool === 'add' ? h.addLight : lightTool === 'pick' ? h.pick : h.lights
    if (step === 'lens') return h.focus
    return []
  })()
  return { rows: [...rows, ...h.canvas] }
}

/** 视图左下角的操作提示（docs/Plan.md §3.7 M8.7），可以收起成一个按钮，在设置中关闭 */
export function OperationHints() {
  const enabled = usePrefs((s) => s.opHints)
  const collapsed = usePrefs((s) => s.opHintsCollapsed)
  const { rows, notice } = useHints()
  if (!enabled || !rows.length) return null

  if (collapsed) {
    return (
      <mdui-tooltip content={h.expand} placement="right">
        <button
          type="button"
          aria-label={h.expand}
          className="glass-popup flex size-10 cursor-pointer items-center justify-center rounded-full text-on-surface-variant transition-colors hover:text-on-surface"
          onClick={() => usePrefs.getState().setPrefs({ opHintsCollapsed: false })}
          data-testid="op-hints-expand"
        >
          <mdui-icon-mouse--outlined className="size-5" />
        </button>
      </mdui-tooltip>
    )
  }

  return (
    <div className="glass-popup flex w-max max-w-80 flex-col gap-1.5 rounded-2xl py-2 pr-1.5 pl-3 text-xs leading-5" data-testid="op-hints">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-on-surface-variant">{h.title}</span>
        <button
          type="button"
          aria-label={h.collapse}
          className="flex size-6 cursor-pointer items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-on-surface/10 hover:text-on-surface"
          onClick={() => usePrefs.getState().setPrefs({ opHintsCollapsed: true })}
          data-testid="op-hints-collapse"
        >
          <mdui-icon-expand-more--outlined className="size-[18px]" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pr-1.5">
        {rows.map(([input, action]) => (
          <Fragment key={input + action}>
            <dt className="font-medium whitespace-nowrap text-on-surface">{input}</dt>
            <dd className="text-on-surface-variant">{action}</dd>
          </Fragment>
        ))}
      </dl>
      {notice && (
        <p className="max-w-72 pr-1.5 text-champagne" data-testid="view3d-notice">
          {notice}
        </p>
      )}
    </div>
  )
}
