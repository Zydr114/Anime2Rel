import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import license from 'rollup-plugin-license'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
  repository: { url: string }
}

// 跨域隔离响应头：只有 WASM 多线程回退路径需要，开发和预览服务器与线上配置保持一致。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

const commit = git('rev-parse HEAD')
const dirty = commit && git('status --porcelain') ? '-dirty' : ''
const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
// AGPL §13：部署修改版时，请通过 A2R_SOURCE_URL 指向你自己的源码仓库。
const sourceUrl = process.env.A2R_SOURCE_URL || (commit ? `${repoUrl}/tree/${commit}` : repoUrl)

// 复制进仓库的第三方源码不在 node_modules 中，需要手动写入声明。
const vendoredNotices = [
  {
    name: 'Magic UI（src/ui/magicui/，已修改）',
    url: 'https://github.com/magicuidesign/magicui',
    license: 'MIT',
    text: readFileSync(new URL('./src/ui/magicui/LICENSE', import.meta.url), 'utf8'),
  },
]

/** 发布 AGPL 全文；开发服务器下提供法律文件的占位内容。 */
function legalFiles(): Plugin {
  const licenseText = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8')
  return {
    name: 'anime2rel-legal-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (path !== '/LICENSE.txt' && path !== '/THIRD_PARTY_NOTICES.txt') return next()
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(path === '/LICENSE.txt' ? licenseText : '开发模式下不生成第三方声明，请运行 pnpm build 后在构建产物中查看。\n')
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: licenseText })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), legalFiles()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit ? commit.slice(0, 7) + dirty : 'dev'),
    __SOURCE_URL__: JSON.stringify(sourceUrl),
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      plugins: [
        license({
          thirdParty: {
            includePrivate: false,
            output: {
              file: fileURLToPath(new URL('./dist/THIRD_PARTY_NOTICES.txt', import.meta.url)),
              template(dependencies) {
                const header =
                  'Anime2Rel 使用了以下第三方组件。每个组件按其各自的许可证分发。\n' +
                  'Anime2Rel uses the following third-party components, each distributed under its own license.\n'
                const npm = dependencies.map((d) =>
                  [
                    `== ${d.name}@${d.version}`,
                    `License: ${d.license ?? 'UNKNOWN'}`,
                    d.repository && typeof d.repository === 'object' ? `Repository: ${d.repository.url}` : '',
                    '',
                    (d.licenseText ?? '').trim(),
                  ]
                    .filter((l, i) => l !== '' || i === 3)
                    .join('\n'),
                )
                const vendored = vendoredNotices.map((v) => [`== ${v.name}`, `License: ${v.license}`, `Repository: ${v.url}`, '', v.text.trim()].join('\n'))
                return [header, ...vendored, ...npm].join('\n\n\n') + '\n'
              },
            },
          },
        }),
      ],
    },
  },
})
