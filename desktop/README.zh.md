# dsh desktop（中文）

[English](README.md) | 中文

DeepSeek Harness 的桌面壳：在现有 web 界面之上加一层 Tauri v2 窗口，拥有一个私有宿主进程的生命周期。壳把 web 宿主作为 sidecar 启动，在其 stdout URL 行上握手，然后针对该 loopback URL 打开一个窗口——浏览器信任围栏、SPA 与 client 插件名册原样复用。

本壳实现的契约见 `openspec/changes/add-desktop-app/`（spec `desktop-app`）。

## 目录结构

```
desktop/
  bin/            build output: dsh-desktop-host (SEA executable)
  build/          SEA staging (sea-config, blob, launcher)
  e2e/            keyless sidecar handshake test
  runtime/        the runtime dependency manifest (deploy root, like python/sdk-runtime)
  runtime-dist/   `pnpm run desktop:runtime` output: the production node_modules the .app bundles
  src-tauri/      the Tauri v2 crate (Rust shell)
  ui/             stub frontendDist required by tauri bundling
```

## 前置条件

- Node ^22.19 || >=24 与 pnpm（仓库标准）
- Rust 工具链（cargo/rustc；Homebrew `brew install rust` 即可）
- `@tauri-apps/cli` 与 `postject` 是根 devDependencies（`pnpm install` 安装）

## 构建与运行

```sh
pnpm run desktop:runtime   # deploy the production node_modules → desktop/runtime-dist/
pnpm run desktop:sidecar   # build:lib + bake the SEA sidecar into desktop/bin/
pnpm run desktop:dev       # sidecar + cargo run (debug shell)
pnpm run desktop:build     # sidecar + tauri build + ditto-inject the runtime → self-contained .app
pnpm run desktop:dist      # the full chain + zip → desktop/dist/dsh-desktop_<version>_<arch>.zip
```

只迭代壳代码时：`node scripts/build-desktop-sidecar.mjs --no-build` 复用已有的 `apps/cli/lib/bin.js`。

## 工作原理

1. 壳以 `dsh-desktop-host web --port 3199` 启动 sidecar（专用固定端口；绑定冲突时回退到 OS 分配端口）。
2. 宿主在 stdout 打出 `dsh web: http://127.0.0.1:<端口>`；壳在 30 秒窗口内解析该行并把窗口导航过去。
3. 退出时向 sidecar 发 SIGTERM（宿主在 SIGTERM 时排空遥测），最多等 5 秒后 SIGKILL。

**捆绑的 .app 是自包含的。** `desktop/runtime/` 是一份纯依赖清单（`python/sdk-runtime` 模式），其部署闭包——全部运行时插件及生产依赖——经 ditto 注入 `Contents/Resources/runtime`。sidecar 的启动器通过 `DSH_DESKTOP_BUNDLE` 环境变量 import `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`；因为 bundle 位于该 node_modules 树内部，它的裸说明符解析与 Loader 的运行时插件 import 全部在 bundle 内闭环。.app 因此可以在没有仓库检出的机器上运行（仍需要一个模型：DeepSeek API key 或本地 Ollama，配置在 `~/.dsh/settings.yaml`）。

## 分发

`pnpm run desktop:dist` 跑完整条链——workspace 构建、runtime 部署、.app 组装——再用 `ditto -c -k --keepParent` 把重签名后的 `.app` 打成 `desktop/dist/dsh-desktop_<version>_<arch>.zip`（保真 runtime 的 pnpm 符号链接布局；tauri 自身的打包发生在 runtime 注入之前）。`tauri.conf.json` 与 `src-tauri/Cargo.toml` 版本不一致、或宿主不是 x64 时直接失败；`--skip-build` 复用已有的 `lib/` 产物。

构建产物未签名。发布（在真 Intel Mac 上执行）：

```sh
shasum -a 256 desktop/dist/dsh-desktop_*.zip   # dist prints this; paste it into the release notes
gh release create desktop-v<version> desktop/dist/dsh-desktop_<version>_x64.zip
```

Release tag 带 `desktop-v` 前缀，与 npm release tag 序列区分。接收方验证下载并通过未签名构建的 Gatekeeper 拦截：

```sh
shasum -a 256 dsh-desktop_<version>_x64.zip    # compare against the release notes
xattr -dr com.apple.quarantine /Applications/dsh-desktop.app   # or right-click → Open in Finder
```

## 已知限制与延后工作

- **仅 macOS**（MVP）；Windows/Linux 壳与平台矩阵延后。Linux 移植必须在可执行文件旁附带原生 addon（SEA 无法内嵌）。
- **未签名 zip 分发**：`desktop:dist` 打包 ad-hoc 签名的 `.app`（见「分发」一节）；代码签名、公证与自动更新仍缺，接收方需手动绕过 Gatekeeper。
- **固定端口不可用时客户端持久化状态会重置**：localStorage 按 origin 隔离，回退到 OS 分配端口的那次启动草稿与视图状态为空（spec 将其标记为可观测）。
- **无页面缩放**（Cmd+=/-），窗口标题可能不跟随 `document.title`；两者均为 MVP 接受项。
- **`target="_blank"` 链接**：外部 http(s) 经壳的导航处理器委托给系统浏览器；WKWebView 在导航前吞掉的新窗口路径是已知缺口，等待上游 wry 支持。
- **壳崩溃可能遗留孤儿 sidecar**：暂无清理机制；新启动不会与孤儿冲突（回退端口由 OS 分配）。
