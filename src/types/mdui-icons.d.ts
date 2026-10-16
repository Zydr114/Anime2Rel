import type React from 'react'

type IconProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>

// @mdui/icons 没有提供 JSX 类型声明，这里按标签名前缀统一声明。
declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        [tag: `mdui-icon-${string}`]: IconProps
      }
    }
  }
}
