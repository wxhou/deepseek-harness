# Agent Note: 桌面壳是现有 web 界面之上的 Tauri 窗口，宿主以 SEA sidecar 运行

Status: implemented

[English](2026-08-16-desktop-shell-tauri-window-over-web-surface.md) | 中文

## 问题

harness 提供三种操作界面——headless CLI、浏览器 web-app、面向编辑器的 ACP 服务器——但没有独立的桌面应用。Codex 式体验（点图标、获得持久原生窗口）目前需要把浏览器标签页一直指向 `dsh web`。web-app bundle 已经在 loopback HTTP 服务器上交付了完整的窗口内体验，所以缺口是一个薄的原生壳，而不是新 UI。

## 决策

**顶层 `desktop/` 的 Tauri v2 壳拥有现有 web 宿主的生命周期，宿主以 sidecar 方式启动。** 壳运行 `dsh-desktop-host web --port 3199`（专用固定端口，绑定冲突时回退到 OS 分配端口），在 30 秒窗口内解析宿主现有的 `dsh web: <url>` stdout 行，并打开一个指向该 loopback URL 的窗口。浏览器信任围栏、SPA 和 client 插件名册原样复用；在某个组合行真正为桌面分化之前，不新增 cordis bundle 层。

**sidecar 是 Node 单可执行应用，其内嵌 CJS 启动器就地 import CLI 的 ESM bundle。** 在支持的引擎范围（`node ^22.19 || >=24`）内，Node 的 SEA 把内嵌主脚本当作 CommonJS 运行，因此 ESM bundle 不能直接内嵌——启动器从构建位置 `import()` `apps/cli/lib/bin.js`，因为 bundle 的运行时插件 import（Loader 的裸说明符解析）锚定在自身目录的 node_modules 向上遍历。因此 sidecar 在运行时需要仓库检出；「单可执行文件」指的是 Node 运行时，而非整个应用。

**壳侧 webview 交互契约修复了三个会静默破坏 SPA 交互的 WKWebView/Tauri 默认行为**（每一条都由前端评审追溯到 SPA 代码）：`dragDropEnabled: false`（Tauri 的原生拖放否则会吞掉 `dragover`/`drop`，杀死拖文件进输入框和工作区行重排）、把外部 http(s) 委托到系统浏览器的新窗口/导航处理（没有委托时 `target="_blank"` 链接在 WKWebView 里是静默 no-op）、以及带标准 Edit 项的默认应用菜单（macOS 通过菜单栏分发 Cmd+C/V/A）。

**固定端口是数据行为决策，不是便利性。** localStorage 中的客户端状态按 origin 隔离（`dsh.conversation.chat` 草稿、`dsh.sessions.current`、`dsh.workspace.view.v5`、`dsh.trajectory.duration`），所以每次启动都用 OS 分配端口会静默清空草稿和视图状态。固定端口在常规情况下保持 origin 稳定；回退只在罕见的冲突情况下丢失该状态，spec 将其标记为可观测而非静默。

## 备选方案

- **Electron**——单一运行时（Node 本来就是宿主），但产物 ~150MB+ 且分发故事更重；壳足够薄，Rust 没有实际成本，且仓库已有非 pnpm 构建区域先例（`python/`、`native/`、`website/`）。
- **PWA / 「添加到程序坞」**——零代码，但没有托盘、通知或原生对话框，窗口仍是伪装的浏览器标签页。
- **`bin.js` 旁捆绑 Node 运行时**——design 的 D1 回退；选择 SEA + CJS 启动器是因为它在支持的引擎范围内可用且保持运行时内嵌。
- **MVP 就建 `desktop-app` bundle 层**——目前没有组合行分化；壳原样消费 `web` profile。当某行真正需要桌面值时该层才出现。
- **始终用端口 0**——孤儿进程不撞端口的理由，因每次启动都静默清空 localStorage 状态而被否决；回退路径保留了防碰撞收益。

## 后果

macOS-only MVP：Windows/Linux 壳、签名、公证和自动更新均延后。Linux 移植必须在可执行文件旁附带原生 addon（SEA 无法内嵌）。sidecar 运行时需要仓库检出，这限制了分发故事，直到 Loader 的插件解析被捆绑。壳崩溃可能遗留孤儿 sidecar；新启动不会与它冲突，因为回退端口是 OS 分配的。WKWebView 在导航前吞掉的 `target="_blank"` 链接是已知缺口，等待上游 wry 支持。

## 测试

`desktop/e2e/sidecar-handshake.mjs` 是无 key 的 CI 可用通道：直接以 web 模式运行 SEA 可执行文件，断言恰好一行 stdout 握手，通过 HTTP 探测公布的界面（首页 + 一个 RPC），SIGTERM 并断言干净退出。构建脚本（`scripts/build-desktop-sidecar.mjs`）在无 `node` 于 PATH 时冒烟验证 `--help`，并断言 ad-hoc 签名——它在 macOS 上是承重的（未签名副本在 exec 时被杀）。交互契约（拖放、粘贴、Cmd+C/V/A、暗色模式、标题、草稿持久化、外链）是变更任务 3.4 中的手动清单，因为无 GUI e2e 看不到它。
