# 0.3.7 开发：适配 DSH 0.2.2

Status: implemented

## 问题与基线

0.3.7 开发阶段新增 DSH 0.2.2 兼容，并保留 0.2.1。包版本号保留至发布时统一调整，本次没有发布。

2026-10-28 沙盒 alpha 运行 npm `0.2.2-alpha.2`，对应官方源码标签 `dsh-v0.2.2-alpha.2`、提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`；源码未在槽位重建。源码差异对照 `dsh-v0.2.1-rc.4`，插件检查基线为 `538f60a`。本机位置及隔离约定见[沙盒环境](../../../SANDBOX.md)。

官方 [Agent 准备顺序](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/agent-loop/src/agent.ts)先调用 tools.resolve 建立本轮准入集合，再 assemble 系统提示词，之后才执行 agent/pre-step。[工具服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/index.ts)的集合只会移除已不可见的工具，不会补回建立准入时已被旧限制排除的工具。因此原来在 assemble waterfall 中更新限制，可能让重新启用的工具赶不上本轮请求。

另一个边界是 systemPrompt.assemble 在进入 waterfall 前已收集 provider 工具，返回时继续使用这些工具。原来的“钩子内重新 assemble”也不能可靠更新最外层收集的 schemas。模型选择旧入口 sessionProjections.stateOf 仍存在，但已弃用。

## 实施决定

[工具限制](../../../../src/lib/tool-restrictions.mts)采用两个窄桥接：在公开 tools.resolve 前更新策略；对没有 toolSet 的 systemPrompt.assemble，在 provider 收集前更新，覆盖 0.2.1 与预览读取。不修改宿主内部 admitted 集合，不重跑动态 when 函数，也不替换宿主工具系统。

目前没有足够早的公开事件。agent/pre-step 和原 waterfall 已太晚，仅在保存面板时更新又不能覆盖工具目录变化与下一次准备，因此采用局部服务方法包装。通过原始方法 descriptor 保留 Cordis 调用方 this，避免把原方法绑定到插件全局 scope；effect 释放时仅恢复自身仍占用的方法，已失活的包装透传，避免覆盖其他包装。

策略刷新按 agent 排队。模式自有工具通过 acquireScope 的定义身份判断能否限制，lease 在成功/异常均释放；agent 本地覆盖继续由执行守卫处理，run_code 不作为端能力禁用。插件关闭或 agent 退出后不补装限制，停用时恢复方法和可见性。

[模型选择](../../../../src/lib/connection.mts)优先读取 live Agent 的 model.current，冷会话读取公开 projection snapshot 中的 next/lastUsed；没有 snapshot 的旧嵌入环境保留原接口兜底，不重复注册宿主 projection。[DSH 模板组装](../../../../src/lib/dsh-system-template.mts)显式传递当前 modelSelection，并清除切回默认推理强度后旧 header 中残留的显式值。

主包、正文包和兼容 bundle 的 engines.dsh 统一为 `>=0.2.1-0 <0.2.2 || >=0.2.2-0 <0.2.3`。分开声明两个 minor，确保正常 semver 预发布规则也包含 0.2.2-alpha，不提前纳入 0.2.3。

## 保留的边界

工具按模式和 MCP 实时枚举，保留多种工具格式的[解析兼容兜底](../../proposed/architecture/2026-10-20-recipe-toolcall-parser.md)。此次没有重写解析器、工作台或正文显示路径。

llm/stream、agentPresets.register/acquireScope、persona 的 complete/includeRuntimeContext、客户端 view/panel/agentPresetSeat、正文节点属性与 ui-chat source 仍可在该标签源码找到。接入点存在不能代替真实浏览器和插件生命周期验收。

## 验证与后续边界

构建和 592 项本地测试通过，新增针对本轮准入、模式 scope、模型选择、默认推理强度、无参数组装和方法释放的覆盖；相关测试见[会话设置](../../../../tests/session-settings.test.mjs)与[系统模板](../../../../tests/dsh-system-template.test.mjs)。

沙盒 npm 0.2.2-alpha.2 已安装主包与本地正文包。真实宿主启动、目录和预填充预览通过；真实 Cordis/工具服务验证关闭与重新开启、调用方 scope 和卸载恢复。实际 DSH 通过本地假接口确认 prefix、reasoning_content、工具关闭/开启、DSML 执行及同轮续请求，以及 PTC run_code 和 SDK 端能力关闭/恢复。试验使用独立预设状态与虚构数据，阻止外部 HTTP。

0.2.1-rc.4 更新备份中的真实 Cordis、工具及系统提示词核心服务也通过 schemas 关闭/恢复和清理验证；没有重新启动旧版完整 Web。浏览器视觉、皮肤/GenUI、插件管理器完整热重载和真实外部模型均未在本次重测。详细范围见[兼容记录](../../../../docs/compatibility/DSH_0.2.2_COMPATIBILITY.md)。
