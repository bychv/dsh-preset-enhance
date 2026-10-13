# DSH Preset Enhance

在 DeepSeek Harness 中使用 SillyTavern 预设，管理提示词、预填充、正则与工具开关。

- **预设编辑**：工作台与 SPreset 编辑器，支持顺序、深度注入、变量宏、自动保存和单文件分享。
- **正则处理**：同一面板配置提示词与正文规则；正文分包只替换显示，不改写聊天记录。
- **请求调试**：消息预览、紧凑 Raw JSON、完整工具字段，以及按模式编辑的 DSH 系统模板。
- **预填充与工具**：Assistant 前缀续写、DSML 转换、实验性正文提取、逐工具开关与分组。
- **插件接入**：动态模板、酒馆 marker 关联、历史消息处理与预设只读 API。

> 本文对应 `next-ver` 当前源码，面向 DSH **0.2.1 全系列**。版本字段仍为 `0.3.5-alpha.1`，近期的分包、正则编辑、导入修复与 Raw 改进尚未发布；不能据此认定 npm 同版本包含这些改动。

## 安装与升级

安装已发布的 alpha 通道版本：

```powershell
dsh plugin --profile web add dsh-preset-enhance@alpha
```

重新启动 `dsh web`，在侧边栏打开「预设工作台」。导入预设后，新建「预设模式」对话即可使用；已有会话用 `/preset on` 或 `/preset off` 控制注入。

当前开发版沿用 **dsh-preset-enhance** 安装入口，由主包携带正文分包，同一插件页可分别启停。原有预设和配置保留，正文替换默认关闭，无需换装 bundle。未发布分包的本地安装见[开发验证](docs/DEVELOPMENT.md)。

当前源码导入分享文件时会恢复其中的**全局预填充设置**，工具配置仍需单独导入。预填充使用支持 Chat Completions 的连接，如 **DeepSeek-预设增强**；Messages 不支持预填充。

## 文档

| 内容 | 入口 |
| --- | --- |
| 工作台、协议、预填充与工具管理 | [使用指南](docs/guides/WORKBENCH.md) |
| 正则配置、正文分包与升级 | [正文正则](docs/api/DISPLAY_REGEX.md) |
| 消息预览与原始请求 | [请求预览](docs/guides/REQUEST_PREVIEW.md) |
| 模式系统模板、宏与请求参数 | [系统模板](docs/api/DSH_SYSTEM_TEMPLATE.md) |
| 预设导入导出 | [分享格式](PRESET_FORMAT.md) |
| 外部插件与内部 agent 接入 | [模板 API](docs/api/TEMPLATE_API.md) · [只读 API](docs/api/PRESET_READ_API.md) |
| 架构与开发 | [插件架构](docs/ARCHITECTURE.md) · [开发验证](docs/DEVELOPMENT.md) |

完整索引及兼容记录见[文档导航](docs/README.md)。

[MIT 许可证](LICENSE)
