import { useEffect, useState } from 'react'
import { Viewport } from '@/canvas/Viewport'
import { t } from '@/i18n'
import { useEngine } from '@/state/engine'
import { useApp } from '@/state/store'
import { Editor } from './Editor'
import { importFiles } from './importer'
import { Landing } from './Landing'

const EDITOR_INSETS = { left: 112, right: 352, top: 16, bottom: 88 }

export function App() {
  const [started, setStarted] = useState(false)
  const status = useEngine((s) => s.status)
  const error = useEngine((s) => s.error)

  // 全局粘贴：带透明区域的图片作为立绘，否则作为背景
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      void importFiles(files, 'auto')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const start = () => {
    setStarted(true)
    // 编辑器的浮动面板：左侧导航、右侧检查器、底部工具栏
    useApp.getState().setViewInsets(EDITOR_INSETS)
    useApp.getState().fitToView()
  }

  if (status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-8" data-testid="gpu-error">
        <div className="glass relative max-w-lg rounded-3xl p-8">
          <h1 className="mb-3 text-xl font-semibold">{t.errors.gpuTitle}</h1>
          <p className="text-sm leading-6 text-on-surface-variant">{t.errors.gpuBody}</p>
          {error && <pre className="mt-4 overflow-auto text-xs whitespace-pre-wrap text-on-surface-variant">{error}</pre>}
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <div className={started ? 'absolute inset-0' : 'invisible absolute inset-0'}>
        <Viewport />
      </div>
      {started ? <Editor /> : <Landing onStart={start} />}
      {status === 'loading' && started && (
        <div className="absolute inset-0 flex items-center justify-center">
          <mdui-circular-progress />
        </div>
      )}
    </div>
  )
}
