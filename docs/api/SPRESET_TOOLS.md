# 实验性 SPreset 工具

在预设工作台的「工具预设」面板开启「当前预设的 SPreset 工具（实验性）」，随后保存或等待自动保存。开关按预设存储，默认关闭；分享文件导入后也关闭，需要接收者自行开启。关闭后，下次工具准入会移除该预设注册的工具。

## 支持范围

读取 extensions.SPreset.ToolBindings，以关联条目在当前顺序表中的启用状态及绑定开关为条件，运行 code 取得工具名称、说明、JSON Schema 和 action。code 为权威定义，form 仅是编辑镜像。工具名称冲突会报错，不覆盖宿主或其他插件工具。

工具通过 DSH 官方工具注册和执行管线工作，支持调用、返回值、原生工具历史及续轮。已有工具开关仍生效，不另建执行循环。

支持 OutputPreprocessing 的纯函数 script，以及 consumeToolCalls 和 toolCallFormatter。输出预处理开启且消费开启时，所有工具调用均转交 formatter，成功后成为 assistant 正文，跳过 action 和工具续轮；formatter 未开启时使用默认参数转文本。失败时恢复原工具调用，交回 DSH 处理。此行为沿用 SPreset，不自动推断哪些工具属于正文。

原有正文继续流式输出，工具参数等待调用完整后再格式化。state/hold 按本次请求独立保存，结束时刷新暂存文本。错误、取消、长度截断和未完成调用不会转成成功正文。生成的正文由宿主保存，不依赖正文显示分包。

## 脚本环境

脚本在 QuickJS 中执行，只传 JSON 数据；支持同步函数和可在引擎内完成的 Promise。不提供 Node、SillyTavern、DOM、文件、网络、计时器或远程模块。每次执行限制约 150ms、16MiB 引擎内存、256KiB 源码及 2MiB 输入/输出；额外限制工具数量和调用分片。输出脚本用显式 state 传递状态，不能依赖跨调用全局变量或闭包持久化。console 是空实现，避免打印预设正文或参数。

工具 code 返回对象需含 name、description、parameters、action；action(args) 返回可序列化值，原始字符串保持字符串。formatter 接收 calls（arguments 已解析）、defaultText、provider、stream、final、channel；返回文本或 { output/text/content }。输出脚本接收 buffer/chunk/hold/output/raw/state/final/stream/channel；返回文本或包含 output/emit/text/content、hold、state 的对象。

## 当前限制与调试

stealth、条目条件脚本和 PTC 的调用消费暂不支持，触发时明确报错。formatMessage 自定义通知尚未接入，宿主使用默认工具卡片。FinalRequestProcessing、ChatSquash 后处理及其他酒馆脚本阶段不在本实验范围，配置仍保留；工作台提示已开启的最终请求脚本暂不执行。

请求预览的 Raw 仍显示真实出站请求。普通工具执行可以通过 DSH 工具记录核对；消费成功后历史保存正文，不产生虚假的工具执行记录。失败诊断写宿主日志，不自动记录源码或参数。首轮请求准备失败也会进入已有请求预览错误状态。

实现见 [工具注册与消费](../../src/lib/spreset-tools.mts)、[隔离执行](../../src/lib/spreset-script.mts)及[调研笔记](../../.agents/notes/proposed/architecture/2026-10-28-spreset-custom-tools.md)。

验证范围见[2026-10-28 记录](../testing/2026-10-28-SPRESET_TOOLS.md)。
