# Anime2Rel

在浏览器本地把二次元立绘融入真实背景照片，生成“溶图”（Anime in Real）。

上传一张背景照片和一张带透明通道的立绘，摆放好位置后导出 PNG。所有计算都在本地完成，图片不会上传。项目计划见 [`docs/Plan.md`](docs/Plan.md)。

> 当前处于 **M5 调色与后期** 阶段：已实现导入、摆放、视口缩放平移、撤销重做、PNG 导出，基于 Depth Anything V2 Small 的深度估计（法线、天空遮罩和调试视图），光源分析（候选方向光 / 点光源、阴天识别，可在画布和光照方向球上编辑，灰球预览），立绘融合（白平衡与影调、色调、饱和度匹配，三种风格的增量重光照与轮廓光，Light Wrap、边缘羽化和噪声匹配，移动立绘时自动更新），分层景深（点击对焦、可调光圈与散景形状，立绘边缘无光晕），可拖动的接地点与站立阴影，前景遮挡（深度遮挡、透明介质、水体和画笔划定的多区域遮挡），以及调色与后期：全局、背景、立绘三级基础调整（曝光、对比度、高光阴影、白色黑色、色温色调、HSL、饱和度、曲线、清晰度、锐化），色轮、分离色调、`.cube` LUT 和混色层，Bloom、胶片红晕、丁达尔光束、色差、暗角、颗粒和可选的色调映射，四个内置预设与可分享的预设文件。前后对比在调色和后期步骤中显示调色前的结果，其他步骤显示直接贴上去的效果。

本项目不提供抠图功能，立绘需要自带透明背景。

## 浏览器要求

- 推荐使用支持 WebGPU 的桌面浏览器（Chrome / Edge 113+）。不支持 WebGPU 时会自动回退到 WebGL2。
- 在地址后加 `?renderer=webgl` 可以强制使用 WebGL2，用于测试回退路径。
- 必须通过 HTTPS 或 `localhost` 访问，否则 WebGPU 不可用。
- 深度估计优先使用 WebGPU 推理，不可用时回退到 WebAssembly（CPU）。WebAssembly 多线程需要跨源隔离响应头（COOP/COEP），本仓库的部署配置均已包含。

## 开发

需要 Node.js 22.12 及以上版本和 pnpm。

```sh
pnpm install
pnpm dev          # 开发服务器（首次运行会下载模型）
pnpm build        # 下载模型 + 类型检查 + 生产构建，输出到 dist/
pnpm models       # 只下载模型
pnpm preview      # 本地预览构建结果（http://localhost:4173）
pnpm lint         # ESLint
pnpm typecheck    # TypeScript 类型检查
pnpm test         # 单元测试（Vitest）
```

### 深度模型

深度估计使用 [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small)（Apache-2.0）的 ONNX 版本，默认随站点自托管。`pnpm dev` 和 `pnpm build` 会先运行 `scripts/fetch-models.mjs`，把 [`src/depth/models.json`](src/depth/models.json) 中列出的模型下载到 `public/models/`（已在 `.gitignore` 中忽略），校验 SHA-256，并把超过 20 MiB 的文件切成分片。已下载且完整的文件会跳过。

| 环境变量 | 说明 |
| --- | --- |
| `A2R_MODELS` | 要下载的精度，逗号分隔，默认全部（`q4f16,fp16,q4,int8`，共约 123 MB）；设为 `none` 跳过下载 |
| `A2R_HF_ENDPOINT` | 下载源，默认 `https://huggingface.co`；构建机在国内时可设为 `https://hf-mirror.com` |

不带模型构建（`A2R_MODELS=none`）时，站点仍可运行，但只能在设置中改用 Hugging Face 或魔搭 ModelScope 远程下载模型。

ONNX Runtime 的 WebAssembly 运行时约 26 MB，构建时同样会被切成分片放到 `dist/assets/ort-<哈希>/`。模型和运行时下载后都会存入浏览器的 Cache API，可在“深度”面板中查看占用并清除。

### 端到端测试

端到端测试使用 Playwright，分别在 WebGPU 和 WebGL2 两种后端下运行。测试需要一个支持 WebGPU 的 Chromium 系浏览器，通过环境变量 `CHROME_PATH` 指定：

```sh
CHROME_PATH=/usr/bin/chromium pnpm test:e2e
```

不设置 `CHROME_PATH` 时使用 Playwright 自带的浏览器，需要先执行 `pnpm exec playwright install chromium` 下载与当前 Playwright 版本匹配的浏览器。WebGPU 用例需要能访问 GPU 的环境。`pnpm test:e2e` 会先下载模型。测试图像都在测试中程序生成（M1 用例是天空、透视地面和球体组成的合成场景；M2、M3 用例由 [`src/analysis/synthetic.ts`](src/analysis/synthetic.ts) 光线追踪生成晴天、阴天和夜景，M3–M5 的立绘是 [`tests/e2e/figure.ts`](tests/e2e/figure.ts) 绘制的简笔人物，M5 的 LUT 也在测试中生成），仓库不包含示例图片。

测试会在 4173 端口启动预览服务器；如果本地已有其他服务占用这个端口，Playwright 会直接复用它，导致测试打开错误的页面，需要先停止该服务。

## 部署

`pnpm build` 生成的 `dist/` 是纯静态目录（含模型约 146 MB，单个文件均不超过 20 MiB），可以部署到 Cloudflare Pages 或自己的服务器。对服务器的要求见 [`docs/Plan.md` §1.4](docs/Plan.md#14-部署)。

### Cloudflare Pages

| 设置项 | 值 |
| --- | --- |
| 构建命令 | `pnpm build` |
| 输出目录 | `dist` |
| 环境变量 | `NODE_VERSION=24` |

构建时会从 Hugging Face 下载模型。响应头由 [`public/_headers`](public/_headers) 配置，构建时会自动复制到 `dist/`。

### 自有服务器

- Nginx：参考 [`deploy/nginx.conf`](deploy/nginx.conf)
- Caddy：参考 [`deploy/Caddyfile`](deploy/Caddyfile)

在本地构建后，把 `dist/` 的内容复制到配置中 `root` 指向的目录，再修改域名和证书路径即可。构建机无法访问 Hugging Face 时，设置 `A2R_HF_ENDPOINT=https://hf-mirror.com`。

## 协议

本项目以 [GNU Affero 通用公共许可证 v3.0 或更新版本](LICENSE)（AGPL-3.0-or-later）发布。

根据 AGPL 第 13 条，通过网络向用户提供本程序（包括修改版）时，必须让用户能获取对应的源代码。页面底部和“关于”对话框中的“源代码”链接默认指向本仓库中构建时所用的提交。**如果你部署的是修改版**，请在构建时设置环境变量 `A2R_SOURCE_URL`，指向你自己的源码仓库：

```sh
A2R_SOURCE_URL=https://example.com/your/fork pnpm build
```

构建时会自动生成 `THIRD_PARTY_NOTICES.txt`（第三方依赖的协议声明，包括 ONNX Runtime Web 及其第三方声明、Depth Anything V2 Small 模型权重的 Apache-2.0 协议）和 `LICENSE.txt`，与站点一起发布。`src/ui/magicui/` 中的组件改编自 [Magic UI](https://github.com/magicuidesign/magicui)（MIT），原协议见该目录下的 `LICENSE`。
