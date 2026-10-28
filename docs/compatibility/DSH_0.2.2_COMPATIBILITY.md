# DSH 0.2.2 兼容

当前源码进入 0.3.7 开发阶段，新增 DSH 0.2.2 支持，保留 0.2.1。包版本号在正式准备发版时统一调整；本次没有发布 npm 或 GitHub Release。

三份 manifest 的 `engines.dsh` 为 `>=0.2.1-0 <0.2.2 || >=0.2.2-0 <0.2.3`，分别纳入两个 minor 的预发布版本。实际验证基线是沙盒 npm `0.2.2-alpha.2`；源码对应官方标签 `dsh-v0.2.2-alpha.2`、提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。不能把这个基线解释成已逐个测试未来版本。

## 修复内容

- 在宿主 `tools.resolve` 建立本轮工具准入之前更新限制，修复工具关闭后重新开启仍未进入本轮集合的问题。
- 在不带本轮 toolSet 的 `systemPrompt.assemble` 收集 schemas 和 PTC SDK 前更新限制，兼容 0.2.1 以及预览读取；不再依赖进入 waterfall 后重新 assemble。
- 枚举可限制工具时使用对应模式的 scope lease，覆盖模式自有工具；保留 agent 本地覆盖和运行时执行守卫。
- 优先使用 live Agent 的 `model.current()` 或公开 projection snapshot 的 modelSelection.next/lastUsed，避免在 0.2.2 调用弃用的 stateOf。旧嵌入环境没有 snapshot 时保留原读取兜底。
- 读取 DSH 系统模板时传入当前 modelSelection，并在切回适配器默认推理强度时清除旧请求留下的显式值。

宿主未提供准入前的事件钩子，所以使用局部、可释放的服务方法桥接。它保留调用方的 Cordis scope，按 agent 串行更新限制；停用/卸载时恢复方法和工具可见性。没有修改宿主源码或工具准入集合。实现依据见[Agent Note](../../.agents/notes/implemented/architecture/2026-10-28-dsh-022-compatibility.md)。

## 验证（2026-10-28）

使用同一沙盒 alpha 的 npm 运行时和真实 Cordis/工具服务；请求试验通过临时覆盖使用虚构预设、独立预设状态文件和本地假接口，拦截外部 HTTP，不调用真实模型。

| 范围 | 结果 |
| --- | --- |
| 安装和启动 | 主包及本地正文包安装；认证启动、预设模式、动态工具目录、Chat 适配器、编辑器资源和预填充预览通过 |
| 真实工具服务 | 原生 schemas 关闭/重新开启、Cordis 调用方保留、卸载恢复通过 |
| 实际 DSH 请求 | 确认出站末条 assistant 的 prefix 与 reasoning_content；工具重新开启在下一轮生效 |
| 工具续轮 | V4.1 Flash DSML 被恢复并由 DSH 执行，工具结果带入同一轮后续请求 |
| PTC | 原生 run_code 传输工具保留，SDK 中端能力关闭与重新开启生效 |
| 旧版核心服务 | 从沙盒更新备份加载 0.2.1-rc.4 的真实 Cordis/工具/系统提示词服务，schemas 和卸载恢复通过；不是旧版完整 Web 重测 |

构建和 592 项本地回归通过，针对性覆盖包括模型选择、无参数组装、旧接口兜底、按模式工具作用域及服务方法恢复。真实浏览器、皮肤/GenUI 视觉、完整插件管理器热重载和外部真实模型没有在本次重测。正文渲染路径未改动，原有验证见[正文正则](../api/DISPLAY_REGEX.md)。

本机沙盒路径和调用边界见[沙盒环境](../../.agents/SANDBOX.md)。
