# DSH Preset Enhance

在 DeepSeek Harness 中使用 SillyTavern 预设，管理提示词、预填充与工具开关。

- **预设工作台**：导入、编辑、自动保存和单文件分享，支持顺序、深度注入与变量宏。
- **请求调试**：消息预览、可折叠 Raw JSON，以及按模式编辑的 DSH 系统模板。
- **预填充兼容**：Assistant 前缀续写、DSML 工具调用转换与实验性正文提取。
- **工具管理**：模式默认、会话覆盖、工具预设、用户分组与 MCP 分组。
- **插件接入**：外部动态模板、酒馆 marker 关联、历史消息处理与预设只读查询。

> 本文对应 **0.3.5-alpha.1**，通过 npm `alpha` 通道提供。当前分支已验证 DSH `0.2.1-alpha.1`，详见 [兼容记录](docs/compatibility/DSH_0.2.1_COMPATIBILITY.md)。

## 安装与上手

安装本版本的 alpha 预览版：

```powershell
dsh plugin --profile web add dsh-preset-enhance@alpha
```

重新启动 `dsh web`，在侧边栏打开「预设工作台」：

1. 导入 SillyTavern JSON 或 `.dsh-preset.json` 文件。
2. 新建「预设模式」对话，自动启用当前预设；已有会话使用 `/preset on` 开启、`/preset off` 关闭。
3. 按需调整提示词与工具开关，保存后从下一次请求生效。

预填充需使用支持 Chat Completions 的连接，例如插件自带的 **DeepSeek-预设增强**。Messages 仅有限支持预设注入，不支持预填充。

开发分支的本地安装、旧版 DSH 安装及详细操作见 [工作台使用指南](docs/guides/WORKBENCH.md)。

## 文档

| 内容 | 入口 |
| --- | --- |
| 工作台、协议、预填充与工具管理 | [使用指南](docs/guides/WORKBENCH.md) |
| 消息预览与原始请求 | [请求预览](docs/guides/REQUEST_PREVIEW.md) |
| 模式系统模板、动态宏与请求参数 | [系统模板](docs/api/DSH_SYSTEM_TEMPLATE.md) |
| 预设导入导出 | [分享格式](PRESET_FORMAT.md) |
| 外部插件与内部 agent 接入 | [模板 API](docs/api/TEMPLATE_API.md) · [只读 API](docs/api/PRESET_READ_API.md) |
| 架构与开发 | [插件架构](docs/ARCHITECTURE.md) · [开发验证](docs/DEVELOPMENT.md) |

全部接口、兼容记录与后续方案见 [文档导航](docs/README.md)。

## 许可证

[MIT](LICENSE)
