# 文档导航

本索引对应 next-ver：已包含外部提示词模板注册、编辑器选用、动态正文和酒馆 marker 关联，以及实际请求/Raw 预览和历史折叠。alpha 的提示词处理链与独立显示包尚未合入本分支。

| 需要查阅 | 文档 |
| --- | --- |
| 安装与工作台使用 | [项目说明](../README.md) |
| 预设导入、导出和分享字段 | [单文件格式](../PRESET_FORMAT.md) |
| 外部插件注册模板、固定版本、marker 关联 | [模板接口](api/TEMPLATE_API.md) |
| DSH 0.2.1-alpha.1 适配与验证边界 | [兼容记录](compatibility/DSH_0.2.1_COMPATIBILITY.md) |
| 开发任务与本分支实现范围 | [实施索引](plans/PACKAGE_IMPLEMENTATION_TASKS.md) |
| 显示侧正则、组件与独立状态设计 | [显示分包方案](plans/DISPLAY_REGEX_PACKAGE_PLAN.md) |
| 模板、序列处理及脚本接口设计 | [接口设计方案](plans/PLUGIN_TEMPLATE_CONTRACT_PLAN.md) |
| 发送时动态模板、实际请求预览与历史折叠 | [动态模板与预览方案](plans/DYNAMIC_TEMPLATE_PREVIEW_PLAN.md) |
| 工具分组实现约定 | [工具分组](plans/TOOL_GROUPS_IMPLEMENTATION.md) |

api 保存当前可调用接口；compatibility 保存有版本和范围的验证记录；plans 保存开发设计与交接资料。方案中的规划能力不代表当前分支已经实现。

- [预设只读 API v1](api/PRESET_READ_API.md)：内部 agent 工具、HTTP 读取与外部授权边界。

- [2026-10-04 alpha 接入验证](testing/2026-10-04-ALPHA_INTEGRATION.md)：实际宿主、HTTP 路由、工具及插件生命周期验证。
