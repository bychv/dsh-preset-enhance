# 0.3.7 开发：适配 DSH 0.2.2

Status: proposed

## 目标与基线

0.3.7 开发阶段需要修复 DSH 0.2.2 兼容性。本文是待实施任务与源码检查依据，不代表插件已经支持该版本，也不提前修改发布版本号或兼容声明。

2026-10-28 使用沙盒启动器确认：alpha 运行 npm `0.2.2-alpha.2`，端口 3182；对应官方源码为 `dsh-v0.2.2-alpha.2`，提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。源码尚未在槽位重新构建，不能把源码构建与 npm 运行实例混为一谈。本机路径和启动约定见[沙盒环境](../../../SANDBOX.md)。源码差异主要对照 `dsh-v0.2.1-rc.4`，插件检查基线为 `538f60a`；工作树另有生成文件修改，未纳入本次分析或提交。

官方参考入口：[Agent 本轮准备](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/agent-loop/src/agent.ts)、[工具服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/index.ts)、[工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/contracts.ts)、[投影服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-projection/src/index.ts)。

## 重点修复：工具限制与本轮工具准入时机

宿主现在先调用 `tools.resolve({ agent, modelSelection, signal })`，取得本轮 `ResolvedToolSet`，再将它传给 `systemPrompt.assemble`；工具定义和执行都使用本轮准入集合。注册还支持动态 `when` 条件，不能用静态目录代替实际准入结果。

插件当前在 [installToolRestrictions](../../../../src/lib/tool-restrictions.mts) 的 `system-prompt/assemble` 阶段释放旧限制、安装新限制，并重新 assemble。源码可确认这一时机晚于准入集合建立，存在以下风险，需用真实宿主复现：

- 关闭工具：`toolSet.view()` 会再次检查当前可见性，因此不能笼统认定关闭完全失效；已有执行守卫也应保留。
- 重新开启工具：上一轮限制尚在时工具可能未进入 admitted 集合。到 assemble 时才解除限制，不能让工具补进已经建立的本轮集合，可能出现界面已启用、当前请求仍没有该工具的现象。
- 冷预览与实际请求：无 `toolSet` 的模式目录读取仍可用于编辑器，但不等于本轮动态条件已通过；预览、原生 schemas、PTC 描述和执行准入需一致。

实施时优先将策略更新放在宿主本轮工具准入之前的合适公开边界；先核对调用顺序，不假定 `agent/pre-step` 足够早（本标签该事件也在 resolve/assemble 之后）。避免直接修改 admitted 内部状态、替换整个宿主工具服务或重新执行带副作用的条件函数。继续按模式和 MCP 实时枚举，不硬编码工具名单。若当前公开边界不足，再记录局部桥接或上游接口需求。

宿主工具实现还将 executor 与 PTC presentation 分离。`schemas/get/restrict/guard` 仍存在，不能仅因文件拆分就判断接口全部删除；需要同时检查原生与 PTC 模式的端能力限制，保留[执行守卫](../../../../src/index.mts)作为最后校验。

## 迁移项：会话与模型选择读取

[连接选择](../../../../src/lib/connection.mts)和[DSH 系统模板](../../../../src/lib/dsh-system-template.mts)仍调用 `sessionProjections.stateOf(session, 'modelSelection')`。0.2.2 保留这个入口，但明确弃用并首次记录警告，建议使用所属领域服务或已等待注册完成的 projection handle。属于迁移债务，不能记成当前必然崩溃。

查明模型选择领域的公开读取入口后统一替换，保持 pending、lastUsed、默认选择及实际请求选项的优先级。不要为了获取 handle 重复注册宿主 projection，也不要仅移除旧读取而退回过期 requestHeader。核对会话模式、空白会话与 retainedBy.mainView 的实际数据来源，确保首条发送、切换模式后系统模板/宏和预览仍与当前会话一致。

## 仍需核实的接入面

- 请求与适配器：`llm/stream` 瀑布仍存在，未见仅因 0.2.2 而需要重写请求链的证据。验证 DeepSeek-预设增强模型目录、协议选择同步、Request 请求捕获，以及思考/正文 prefix、工具续轮、空 reasoning_content 和结束原因的保留；继续保留[多种工具格式兼容兜底](2026-10-20-recipe-toolcall-parser.md)。
- 模式与系统提示词：`agentPresets.register/readDocument/acquireScope` 仍存在，persona 的 `complete/includeRuntimeContext` 配置仍存在。验证从 standard 动态组合预设模式、新增模式/MCP、默认注入、模式独立系统模板和历史默认提示词清理；不能仅验证模式名称出现在列表。
- 工作台：会话 view、侧栏 panel 与 agentPresetSeat 接入仍可找到。验证会话顶栏/侧栏进入、主会话与子会话隔离、新会话模式切换、缓存 iframe 活动通知、滚动保留和布局手柄屏蔽，防止影响宿主输入框及连接池。
- 正文包：宿主仍生成 `data-chat-node-key`、`data-chat-flow-kind`，且 ui-chat 注入仍提供 keyedHooks.chatNode；这只是接入点存在的证据。对照[正文运行时](../../../../packages/display-regex/src/client/runtime.mts)检查消息容器、文本块、MarkdownText 与 source 生命周期；实际验证历史/流式正文、启停恢复、皮肤背景及 GenUI 共存。
- 插件生命周期：检查 Cordis 与客户端 loader 的启动、停用/启用和热重载，尤其外部模板提供者自动关联、事件订阅、缓存页和正文 Worker 的释放与重建。
- 兼容声明：主包、正文包及兼容 bundle 的 package.json 当前声明只覆盖 `>=0.2.1-0 <0.2.2`。实现并验证后同步声明、安装文档及兼容记录；若保留 0.2.1，验证一份旧宿主基线。0.2.2 alpha 的实际支持范围须显式校验 semver，不直接声称已验证整个未来版本系列。

## 实施与验收

先完成一组最小修复：复现工具关闭后重新开启的准入时机问题，选定公开读取接口迁移模型选择，再安装同一构建验证两包。实现使用 TypeScript，修改源码后构建发布产物，保留现有两包布局。不要把本次适配扩展成解析器、工作台或宿主工具系统重写。

在 alpha 做有针对性的真实 DSH 验证：安装启动、普通预设请求、预填充实际出站 prefix、工具关闭与重新启用的下一次请求、工具续轮、模式/模型同步、工作台切换和正文包启停。优先用虚构预设与假端点查看实际请求，不需要为写 Note 调用真实模型。回归相关边界即可，不重复无关全套测试；确需收费模型调用时按当次授权执行。

验收时区分源码检查、单元测试、真实宿主假端点和真实模型，记录宿主/插件提交及是否重启安装。所有实际请求预览须如实显示出站 tools、prefix 与 reasoning 字段；不得用适配器输入代替出站证据。预设和会话数据应保留，两包仍在同一插件页分别启停。

## 本次检查范围

已读取 alpha 状态及匹配标签源码，并对照上述接入模块；未安装插件、启动/重启服务、调用模型或进行浏览器验证。本次仅新增 Note，所有修复和运行验收仍待实施。
