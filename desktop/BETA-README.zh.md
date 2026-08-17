# DeepSeek Harness 桌面版（内测）

感谢试用！这是一个本地优先的 AI 编程助手桌面应用：界面在本机运行，会话数据保存在你自己的电脑上（`~/.dsh/`），不经过任何第三方服务器。

## 系统要求

- **macOS（Apple Silicon，M1/M2/M3/M4 系列）**——本内测包暂不支持 Intel Mac 和 Windows

## 安装步骤

1. 解压 zip，把 `dsh-desktop.app` 拖到「应用程序」文件夹（或任意位置）
2. **首次打开**：在访达里**右键点击 → 打开 → 再点「打开」**
   （应用未做 Apple 公证，直接双击会被 macOS 拦截；右键打开一次后，以后可正常双击）
3. 首次启动会自动在本机创建数据目录 `~/.dsh/`

## 配置模型（必需）

应用需要一个模型才能对话。二选一：

**方式 A：DeepSeek 官方 API（推荐，开箱即用）**

1. 到 [platform.deepseek.com](https://platform.deepseek.com) 注册并创建 API key
2. 打开应用左下角「设置」→ 模型页面，粘贴 API key
3. 开始使用

**方式 B：本地 Ollama**

如果你本机跑着 [Ollama](https://ollama.com)，编辑 `~/.dsh/settings.yaml`（没有就新建）：

```yaml
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama
      api: openai-completions
      baseURL: http://localhost:11434/v1
      apiKeyEnv: OLLAMA_API_KEY
      models:
        - id: 你的模型名   # 必须与 `ollama list` 显示的名字一致
          name: 本地模型
          contextWindow: 100000
          maxTokens: 8192

agent-default-model:
  provider: ollama
  model: 你的模型名
```

再在 `~/.zshrc`（或启动应用的终端）里 `export OLLAMA_API_KEY=ollama` 提供占位 key。

## 已知限制（内测版）

- 退出应用时后台进程会一并清理；若强制冷重启后 Dock 图标未刷新，重启一次 Finder 即可
- 外部链接会调用系统浏览器打开
- 暂无自动更新——新版需要重新下载覆盖

## 反馈

遇到问题请把复现步骤和「设置 → 关于」里的版本信息发回来。感谢！
