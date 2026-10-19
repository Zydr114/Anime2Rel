# 开发与部署

功能介绍见 [README](../README.md)。算法、架构和里程碑等设计内容见 [实施计划](Plan.md)。

## 开发环境

需要 Node.js 22.12 及以上版本和 pnpm。技术栈：

- 构建：Vite、TypeScript
- 界面：React、Tailwind CSS、mdui、Magic UI
- 渲染：three.js（WebGPU / TSL，不支持时回退到 WebGL2）
- 状态管理：zustand
- 深度推理：ONNX Runtime Web
- 测试：Vitest、Playwright

```sh
pnpm install
pnpm dev          # 开发服务器（首次运行会下载模型）
pnpm build        # 下载模型 + 类型检查 + 生产构建，输出到 dist/
pnpm models       # 只下载模型
pnpm preview      # 本地预览构建结果（http://localhost:4173）
pnpm lint         # ESLint
pnpm typecheck    # TypeScript 类型检查
pnpm test         # 单元测试（Vitest）
pnpm test:e2e     # 端到端测试（Playwright），见下文
```

### 目录结构

| 目录 | 内容 |
| --- | --- |
| `src/app` | 页面、各步骤的面板、工具栏、导入导出和工程文件 |
| `src/canvas` | 画布视口和各种 Gizmo（立绘变换、光源、对焦点、接地点、遮挡画笔） |
| `src/engine` | 渲染管线：融合、景深、阴影、调色、后期、分块导出 |
| `src/depth` | 深度模型的来源、下载缓存和推理流程 |
| `src/analysis` | 光源分析的估计器和融合 |
| `src/fusion`、`src/focus`、`src/grade`、`src/lighting` | 立绘融合、景深与遮挡、调色、光照的参数模型和计算 |
| `src/algo` | 通用图像算法（引导滤波、距离变换、色彩转换等） |
| `src/io` | 图像解码、PNG 编码、ZIP、导入文件的字段检查、浏览器存储 |
| `src/state` | 全局状态和撤销记录 |
| `src/workers` | 深度、光源分析、融合统计的 Web Worker |
| `src/ui` | 通用控件和液态玻璃 |
| `tests/e2e` | 端到端测试 |

## 深度模型

深度估计使用 [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small)（Apache-2.0）的 ONNX 版本。浏览器默认从魔搭 ModelScope 下载，站点也自托管一份，作为备用源。

`pnpm dev` 和 `pnpm build` 会先运行 `scripts/fetch-models.mjs`：

1. 把 [`src/depth/models.json`](../src/depth/models.json) 中列出的模型下载到 `public/models/`（已在 `.gitignore` 中忽略）。
2. 校验 SHA-256。
3. 把超过 20 MiB 的文件切成分片。

已下载且完整的文件会跳过。

| 环境变量 | 说明 |
| --- | --- |
| `A2R_MODELS` | 要下载的精度，逗号分隔，默认全部（`q4f16,fp16,q4,int8`，共约 123 MB）；设为 `none` 跳过下载 |
| `A2R_HF_ENDPOINT` | 下载源，默认 `https://huggingface.co`；构建机在国内时可设为 `https://hf-mirror.com` |

不带模型构建（`A2R_MODELS=none`）时，站点仍可运行，只是“本站”这个模型源不可用。端到端测试通过浏览器存储把模型源设为“本站”，不依赖外网。

ONNX Runtime 的 WebAssembly 运行时约 26 MB，构建时同样切成分片，放到 `dist/assets/ort-<哈希>/`。模型和运行时下载后都存入浏览器的 Cache API，可以在“深度”面板中查看占用并清除。

## 调试参数

在页面地址后加上以下参数：

| 参数 | 作用 |
| --- | --- |
| `?renderer=webgl` | 强制使用 WebGL2 渲染，用于测试回退路径 |
| `?textureLimit=<像素>` | 把纹理尺寸上限限制得更小，模拟显卡上限较低的设备 |
| `?exportTile=<像素>` | 导出时总是分块渲染，并指定块的大小 |
| `?glass=liquid\|frosted\|solid` | 强制指定玻璃效果，用于在 Chromium 中查看其他浏览器的效果 |

## 测试

单元测试（`pnpm test`）覆盖算法和数据处理，不需要浏览器。

端到端测试使用 Playwright，分别在 WebGPU 和 WebGL2 两种后端下运行。它需要一个支持 WebGPU 的 Chromium 系浏览器，用环境变量 `CHROME_PATH` 指定：

```sh
CHROME_PATH=/usr/bin/chromium pnpm test:e2e
```

- **浏览器**：不设置 `CHROME_PATH` 时使用 Playwright 自带的浏览器。需要先执行 `pnpm exec playwright install chromium`，下载与当前 Playwright 版本匹配的版本。
- **GPU**：WebGPU 用例需要能访问 GPU 的环境。
- **模型**：`pnpm test:e2e` 会先下载模型。
- **端口**：测试在 4173 端口启动预览服务器。如果这个端口已被其他服务占用，Playwright 会直接复用它，测试就会打开错误的页面，需要先停止该服务。

测试图像都在测试中程序生成，仓库不包含示例图片：

- M1：由天空、透视地面和球体组成的合成场景。
- M2、M3：[`src/analysis/synthetic.ts`](../src/analysis/synthetic.ts) 光线追踪生成的晴天、阴天和夜景。
- M3–M5：[`tests/e2e/figure.ts`](../tests/e2e/figure.ts) 绘制的简笔人物作为立绘。
- M5：LUT 也在测试中生成。
- M8：边缘混入白色底色的立绘也在测试中生成。

## 部署

`pnpm build` 生成的 `dist/` 是纯静态目录，含模型约 146 MB，单个文件都不超过 20 MiB。页面用相对路径引用资源，可以部署在域名根路径，也可以部署在子路径下。

服务器需要满足以下条件（详见 [实施计划 §1.4](Plan.md#14-部署)）：

- **HTTPS**：WebGPU 和 Cache API 只在安全上下文中可用。
- **跨源隔离**：响应头 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: credentialless`，WebAssembly 多线程推理需要它们。
- **MIME 类型**：`.wasm` 以 `application/wasm` 返回。
- **缓存**：`assets/` 和 `models/` 可以永久缓存，`index.html` 不缓存。

### Cloudflare Pages

| 设置项 | 值 |
| --- | --- |
| 构建命令 | `pnpm build` |
| 输出目录 | `dist` |
| 环境变量 | `NODE_VERSION=24` |

构建时会从 Hugging Face 下载模型。响应头由 [`public/_headers`](../public/_headers) 配置，构建时自动复制到 `dist/`。部署到子路径时，需要相应修改其中的路径前缀。

### 自有服务器

参考以下示例配置（都按部署在域名根路径编写）：

- Nginx：[`deploy/nginx.conf`](../deploy/nginx.conf)
- Caddy：[`deploy/Caddyfile`](../deploy/Caddyfile)

在本地构建后，把 `dist/` 的内容复制到配置中 `root` 指向的目录，再修改域名和证书路径。构建机无法访问 Hugging Face 时，设置 `A2R_HF_ENDPOINT=https://hf-mirror.com`。

### 发布脚本

[`scripts/deploy.sh`](../scripts/deploy.sh) 把当前提交构建后发布到一台运行 Caddy 的服务器，挂在已有站点的子路径下。默认发布到 <https://tool.talium.site/Anime2Real/>：

```sh
scripts/deploy.sh
```

对服务器的要求：

- 本机能用 `ssh <主机>` 免密登录，登录用户可以免密 `sudo`。
- 服务器装有 `rsync` 和 `curl`。
- `/etc/caddy/Caddyfile` 中已有目标站点的站点块。

脚本的行为：

1. **检查**：只发布已推送到 `origin/main` 的干净提交，因为页面中的源代码链接指向构建时的提交。检查通过后执行 `pnpm build`。
2. **上传**：用 rsync 上传到 `<发布目录>/releases/<时间>-<提交>/`。与上一版相同的文件（主要是模型）用硬链接复用，不重复上传。
3. **路由**：路由写在单独的 `/etc/caddy/anime2real.caddy` 中，在站点块开头加一行 `import` 引入，不改动站点块的其他内容。新配置先通过 `caddy validate` 才替换，然后重载 Caddy。
4. **切换**：把 `current` 软链接指向新版本，然后在服务器上请求页面，核对 `index.html` 与本地构建是否一致，并检查跨源隔离的响应头。检查失败时，恢复原来的配置和版本。
5. **清理**：只保留最近 3 个版本。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `A2R_DEPLOY_HOST` | `tencent` | ssh 主机名 |
| `A2R_DEPLOY_SITE` | `tool.talium.site` | Caddyfile 中站点块的地址 |
| `A2R_DEPLOY_BASE` | `/Anime2Real` | 子路径，不带结尾的 `/` |
| `A2R_DEPLOY_DIR` | `/var/www/<站点><子路径>` | 服务器上的发布目录 |
| `A2R_DEPLOY_ROUTE` | `/etc/caddy/anime2real.caddy` | 路由文件 |

要回退到上一个版本，在服务器上把 `current` 指回 `releases/` 中的旧目录即可：

```sh
cd /var/www/tool.talium.site/Anime2Real
ln -sfn releases/<旧版本> current
```

## 协议与源代码链接

本项目以 AGPL-3.0-or-later 发布。根据 AGPL 第 13 条，通过网络向用户提供本程序（包括修改版）时，必须让用户能获取对应的源代码。

页面底部和“关于”对话框中的“源代码”链接，默认指向本仓库中构建时所用的提交。**如果你部署的是修改版**，请在构建时设置环境变量 `A2R_SOURCE_URL`，指向你自己的源码仓库：

```sh
A2R_SOURCE_URL=https://example.com/your/fork pnpm build
```

构建时会自动生成以下文件，与站点一起发布：

- `LICENSE.txt`
- `THIRD_PARTY_NOTICES.txt`：第三方依赖的协议声明，包括：
  - ONNX Runtime Web 及其第三方声明；
  - Depth Anything V2 Small 模型权重的 Apache-2.0 协议；
  - 首页标题字体 Instrument Serif 的 OFL-1.1 协议。

`src/ui/magicui/` 中的组件改编自 [Magic UI](https://github.com/magicuidesign/magicui)（MIT），原协议见该目录下的 `LICENSE`。
