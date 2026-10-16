# Anime2Rel

在浏览器本地把二次元立绘融入真实背景照片，生成“溶图”（Anime in Real）。

上传一张背景照片和一张带透明通道的立绘，摆放好位置后导出 PNG。所有计算都在本地完成，图片不会上传。项目计划见 [`docs/Plan.md`](docs/Plan.md)。

> 当前处于 **M0 脚手架** 阶段：已实现导入、摆放、视口缩放平移、撤销重做和 PNG 导出。深度、光源分析、立绘融合、景深、调色和后期效果会在后续里程碑中逐步加入。

本项目不提供抠图功能，立绘需要自带透明背景。

## 浏览器要求

- 推荐使用支持 WebGPU 的桌面浏览器（Chrome / Edge 113+）。不支持 WebGPU 时会自动回退到 WebGL2。
- 在地址后加 `?renderer=webgl` 可以强制使用 WebGL2，用于测试回退路径。
- 必须通过 HTTPS 或 `localhost` 访问，否则 WebGPU 不可用。

## 开发

需要 Node.js 22.12 及以上版本和 pnpm。

```sh
pnpm install
pnpm dev          # 开发服务器
pnpm build        # 类型检查 + 生产构建，输出到 dist/
pnpm preview      # 本地预览构建结果（http://localhost:4173）
pnpm lint         # ESLint
pnpm typecheck    # TypeScript 类型检查
pnpm test         # 单元测试（Vitest）
```

### 端到端测试

端到端测试使用 Playwright，分别在 WebGPU 和 WebGL2 两种后端下运行。测试需要一个支持 WebGPU 的 Chromium 系浏览器，通过环境变量 `CHROME_PATH` 指定：

```sh
CHROME_PATH=/usr/bin/chromium pnpm test:e2e
```

不设置 `CHROME_PATH` 时使用 Playwright 自带的浏览器，需要先执行 `pnpm exec playwright install chromium` 下载与当前 Playwright 版本匹配的浏览器。WebGPU 用例需要能访问 GPU 的环境。测试图像都在测试中程序生成，仓库不包含示例图片。

## 部署

`pnpm build` 生成的 `dist/` 是纯静态目录，可以部署到 Cloudflare Pages 或自己的服务器。对服务器的要求见 [`docs/Plan.md` §1.4](docs/Plan.md#14-部署)。

### Cloudflare Pages

| 设置项 | 值 |
| --- | --- |
| 构建命令 | `pnpm build` |
| 输出目录 | `dist` |
| 环境变量 | `NODE_VERSION=24` |

响应头由 [`public/_headers`](public/_headers) 配置，构建时会自动复制到 `dist/`。

### 自有服务器

- Nginx：参考 [`deploy/nginx.conf`](deploy/nginx.conf)
- Caddy：参考 [`deploy/Caddyfile`](deploy/Caddyfile)

把 `dist/` 的内容复制到配置中 `root` 指向的目录，再修改域名和证书路径即可。

## 协议

本项目以 [GNU Affero 通用公共许可证 v3.0 或更新版本](LICENSE)（AGPL-3.0-or-later）发布。

根据 AGPL 第 13 条，通过网络向用户提供本程序（包括修改版）时，必须让用户能获取对应的源代码。页面底部和“关于”对话框中的“源代码”链接默认指向本仓库中构建时所用的提交。**如果你部署的是修改版**，请在构建时设置环境变量 `A2R_SOURCE_URL`，指向你自己的源码仓库：

```sh
A2R_SOURCE_URL=https://example.com/your/fork pnpm build
```

构建时会自动生成 `THIRD_PARTY_NOTICES.txt`（第三方依赖的协议声明）和 `LICENSE.txt`，与站点一起发布。`src/ui/magicui/` 中的组件改编自 [Magic UI](https://github.com/magicuidesign/magicui)（MIT），原协议见该目录下的 `LICENSE`。
