import { useEffect, useRef, type RefObject } from 'react'

/** 给 Web Components（mdui）绑定原生事件；处理函数可以随渲染更新而不重新绑定。 */
export function useDomEvent<T extends HTMLElement>(ref: RefObject<T | null>, type: string, handler: (e: Event, el: T) => void): void {
  const saved = useRef(handler)
  useEffect(() => {
    saved.current = handler
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fn = (e: Event) => saved.current(e, el)
    el.addEventListener(type, fn)
    return () => el.removeEventListener(type, fn)
  }, [ref, type])
}
