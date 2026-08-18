# Agent Note: 桌面分发是重签名后的 ditto zip，不是 tauri bundle

Status: implemented

[English](2026-08-18-desktop-dist-packaging.md) | 中文

## 问题

`desktop:build` 组装出自包含的 `.app`，但两个显而易见的打包做法都会静默产出损坏的产物。Tauri 自身的打包（`bundle.targets` 里加 `dmg`）发生在 `tauri build` 内部，早于 `build-desktop-app.mjs` 注入 `Contents/Resources/runtime` 并重签名——tauri 产出的 dmg 里是一个没有 runtime 的 app。裸用 `zip -r` 默认跟随符号链接（只有 `-y` 保留），会把刻意保持符号化的 `.pnpm` 自引用链接解引用，归档膨胀且 store 布局被破坏。第三个陷阱：`pnpm deploy --prod --legacy` 运行工作区级生产安装，从根 `node_modules/` 修剪 devDependencies 然后运行生命周期脚本——根 postinstall 硬导入 `lefthook/package.json`（devDependency）导致崩溃。修复三分：deploy 加 `--config.ignore-scripts=true` 抑制生命周期执行、之后 `CI=true pnpm install` 恢复完整工作区、`install-lefthook.mjs` 用动态导入守卫捕获 `ERR_MODULE_NOT_FOUND` 并跳过（无 devDeps → 无 lefthook → 无钩子需配置）。此外，桌面版本在 `tauri.conf.json` 与 `src-tauri/Cargo.toml` 各存一份，而 arm64 宿主会愉快地产出一个无人验证过、外观合法的 `_arm64.zip`。

## 决策

**`scripts/build-desktop-dist.mjs`（`pnpm run desktop:dist`）先设门、再链式、再打包、再验证。** 入口门先于一切：版本一致——`tauri.conf.json` 走严格 `JSON.parse`，`Cargo.toml` 的 `[package]` `version` 走窄扫描，不一致即携双值 fail loud，绝无默认值——以及宿主架构（`process.arch` 必须是 `x64`，唯一验证过的目标；Rosetta 宿主报告 `x64`，这是自洽的：跑起来的工具链就是构建的工具链）。构建链通过 `pnpm run` spawn 既有 package scripts（`build` → `desktop:runtime` → `desktop:build`），让每个脚本的 env 前缀留在其 owner 处——`desktop:build` 自带 `npm_config_verify_deps_before_run=false`。zip 用 `ditto -c -k --keepParent` 从重签名后的 `.app` 切出，落到 `desktop/dist/dsh-desktop_<version>_<arch>.zip`，随后用 `ditto -x -k` 展开验证：恰好一个顶层 `dsh-desktop.app`、runtime 入口存在、runtime 入口存在、展开后 `.pnpm` store 内至少有一个符号链接仍是符号链接（pnpm 的 `deploy --prod --legacy` 布局把包直接存为 `@scope/name` 目录而非符号链接；自引用链接住在 `.pnpm/<hash>/node_modules/` 内，因此断言走进了 `.pnpm` 子目录），以及 `codesign --verify` 通过、`codesign --verify` 通过——这是 `injectRuntime` 物化断言在归档层的孪生。摘要打印 SHA-256，由 release notes 承载；release tag 用 `desktop-v` 前缀，与 npm tag 空间隔离。

**对 `tauri.conf.json` 用严格 JSON 是有意的。** 该文件今天没有注释；Tauri 2 通常允许 JSONC。未来带注释的编辑会在此处以解析失败暴露——这正是正确的失败——届时改用容错解析，绝不静默默认。

## 备选方案

- **tauri `dmg` target** — 产出早于 runtime 注入与重签名；内容残缺且签名损坏。
- **`zip -r`** — 默认解引用 pnpm 符号链接布局。
- **`hdiutil` dmg** — 重签名后可行，但未签名构建下接收方预期的是 zip，维护者也选了 zip。
- **单一版本源生成** — 一致性门更小且 fail loud；仅当两份版本实际漂移时再引入生成。
- **npm-script 链式** — 门、打包、验证都是逻辑，且 `desktop:build` 的 env 前缀将不得不在每个调用方复现。

## 后果

分发保持未签名：接收方手动绕过 Gatekeeper（Finder 确认对话框或 `xattr -dr com.apple.quarantine`），release notes 里的 SHA-256 是唯一的完整性锚点。发布依赖单一 Intel 宿主；CI 后续受制于 Intel runner 的可用性，而非这条流水线。`desktop/dist/` 入口即清空，每次运行替换上一次的产物——多版本归档放在 GitHub Release，不放构建目录。

## 测试

脚本在每次运行时自验产物（展开、顶层布局、runtime 入口、符号链接存活、codesign）；change 的任务 3（`openspec/changes/add-desktop-dist/tasks.md`）覆盖端到端路径：干净态构建、版本不一致失败、重跑幂等、无仓库启动、架构门负向测试。
