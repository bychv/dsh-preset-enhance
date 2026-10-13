# 文档导航

本文档对应 next-ver 当前源码，版本字段为 **0.3.5-alpha.1**。近期的正文分包、正则编辑、分享包接口配置恢复与 Raw 改进尚未发布，npm `alpha` 包不等同于当前源码。当前组合版本面向 DSH `0.2.1` 全系列。

## 使用与接入

| 目的 | 文档 |
| --- | --- |
| 安装、工作台、预填充与工具管理 | [使用指南](guides/WORKBENCH.md) |
| 请求处理流程、模块分工与生命周期 | [插件架构](ARCHITECTURE.md) |
| 构建、测试与打包命令 | [开发验证](DEVELOPMENT.md) |
| 查看消息、折叠历史、结构化 Raw 与工具续轮 | [请求预览](guides/REQUEST_PREVIEW.md) |
| SPreset 正则编辑、可选正文显示包与配置接口 | [正文正则](api/DISPLAY_REGEX.md) |
| 按模式编辑 DSH 正文、动态宏、输出上限与流式开关 | [系统模板与请求参数](api/DSH_SYSTEM_TEMPLATE.md) |
| 导入、导出和分享字段 | [单文件格式](../PRESET_FORMAT.md) |
| 外部模板注册、动态解析、marker 自动关联与 chatHistory 修改 | [模板 API](api/TEMPLATE_API.md) |
| 内部 agent 查询预设、HTTP 凭证与权限边界 | [预设只读 API](api/PRESET_READ_API.md) |

## 当前实现范围

已实现外部静态/动态模板、marker 自动关联与冲突选择、chatHistory 深度修改、提供者启停和热重载跟踪、实际请求预览、紧凑结构化 Raw 与工具字段摘要、分享包预填充配置恢复、预设只读查询，以及可编辑的模式系统模板和请求参数。

已加入 SPreset 附加功能正则编辑器及可选正文正则显示包（开发中，尚未发布）。alpha 的通用提示词序列处理链尚未合入本分支。组件、选项栏、MVU 及脚本运行时相关设计不代表本分支已有可调用接口。接口调用以 `api/` 为准，规划及交接见 `plans/`。

## 兼容与验证记录

| 文档 | 范围 |
| --- | --- |
| [DSH 0.2.1 兼容记录](compatibility/DSH_0.2.1_COMPATIBILITY.md) | 初始适配基线与后续验证入口 |
| [2026-10-04 接入验证](testing/2026-10-04-ALPHA_INTEGRATION.md) | 真实宿主、HTTP、工具及插件生命周期 |
| [2026-10-04 系统模板验证](testing/2026-10-04-SYSTEM_TEMPLATE.md) | 524 项回归、真实提示词服务及输入后切换模式的页面验证 |
| [2026-10-13 包与启停验证](testing/2026-10-13-PACKAGE_LIFECYCLE.md) | TypeScript 文件整理、原主包入口升级、同页分包与正文开关联动 |
| [2026-10-12 正则验证](testing/2026-10-12-DISPLAY_REGEX.md) | 编辑、Worker、流式正文与配置生命周期 |
| [2026-10-12 alpha.2 编辑器验证](testing/2026-10-12-SPRESET_ACTIONS.md) | 真实安装、快捷操作、保存与宿主重启持久化 |

测试数量与结论属于各次记录的代码快照，不应理解为每次文档更新都重新运行。

## 设计与任务

- [分包任务索引](plans/PACKAGE_IMPLEMENTATION_TASKS.md)：本分支交付范围与后续任务。
- [动态模板与请求预览方案](plans/DYNAMIC_TEMPLATE_PREVIEW_PLAN.md)：已实现功能的设计依据及边界。
- [模板、序列处理及脚本接口方案](plans/PLUGIN_TEMPLATE_CONTRACT_PLAN.md)：插件解耦与后续扩展。
- [显示分包方案](plans/DISPLAY_REGEX_PACKAGE_PLAN.md)：显示侧正则、组件和独立状态。
- [工具分组约定](plans/TOOL_GROUPS_IMPLEMENTATION.md)：工具配置分组及保存规则。

## Agent 协作

[工作指引](../AGENTS.md)提供代码入口与验证约定；[Agent Notes](../.agents/notes/README.md)记录跨任务需要保留的决策依据。使用手册与接口契约仍以本目录为准。

压缩兼容的后续扩展已按用户决定[废弃](../.agents/notes/rejected/architecture/2026-10-06-compaction-compatibility.md)，保留已有检查点保护，不再作为待实施任务。
