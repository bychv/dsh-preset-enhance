# DSH Preset Enhance

为 DeepSeek Harness 加载和编辑 SillyTavern 预设，在请求发送给模型前按顺序表注入消息，并按 DSH 模式或当前会话控制工具。

## 安装

~~~powershell
dsh plugin --profile web add github:bychv/dsh-preset-enhance
~~~

重新启动 `dsh web` 后，左侧栏会出现“预设工作台”，新建对话的模式列表中会出现“预设模式”。

## 预设注入

工作台可以导入、编辑、预览和导出 SillyTavern 预设。导入后会立即保存到全局预设库并成为当前默认；在预设库中切换选择也会立即更新当前默认。最后选择保存在 DSH 状态目录中，重启后继续使用。当前默认预设会用于自动注入；可以在“新会话自动启用预设注入”中选择任意 DSH 模式。保存模式列表只影响之后新建的会话；已有会话保持原状态。专用的“预设模式”始终自动启用。

当前会话可以使用原生命令即时切换，命令由 DSH 本地处理，不会作为聊天消息发给模型：

~~~text
/preset on
/preset off
/preset status
~~~

直接输入 `/preset` 会在开启和关闭之间切换。

“预设模式”从当前安装的 `standard` 模式生成，因此拥有标准模式的工具集。它会移除 DSH 的身份 system prompt 和运行环境快照，使发送给模型的提示词完全由预设和真实聊天记录组成。其他模式保留各自原有提示词，同时可以叠加预设注入。

提示词条目分为两个区域：

- **顺序表内**：条目已经参与当前顺序表；复选框只控制是否启用，未勾选的条目仍属于顺序表。
- **闲置条目**：条目没有加入当前顺序表，不参与注入；点击“加入”后才会移动到使用区。

支持顺序表中 `chatHistory` 前后的 system、user、assistant/model 消息，以及按聊天深度注入。支持常用 SillyTavern 变量宏，包括 `setvar`、`getvar`、global 变量、数值修改、随机选择与骰子。`extensions` 会原样保留在预设 JSON 中，当前版本不执行其中的扩展行为。

当编译后的最后一条预设消息是 assistant 时（包括顶层 `assistant_prefill`，以及梁元类预设在 `chatHistory` 后安排的 assistant/model 条目），工作台会显示预填充续写提醒，消息预览也会标出 `Assistant Prefix`。这类预设必须使用支持 assistant prefix 的接口。

使用 DSH 的 `deepseek-official` 提供方时，可以在“Assistant 预填充接口”面板开启“DeepSeek 官方 Beta 前缀续写”。开启后，插件只对当前请求中匹配到的末条预填充自动执行两项转换：将官方 Chat Completion 地址切到 `https://api.deepseek.com/beta`，并为最后一条 assistant 消息发送 `prefix: true`。普通对话、非预填充请求和其他提供方不受影响。接口要求见 [DeepSeek 对话前缀续写文档](https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion)。

## 工具预设

工具面板支持两层配置：

- **模式默认**：可以为每个可用的 DSH 模式分别开启或关闭工具。没有独立覆盖的会话会继承该策略，保存后从下一次模型请求开始生效。
- **当前会话覆盖**：在同一会话中随时改动工具开关，下一次请求立即使用新策略；“恢复继承”会重新采用当前模式的默认策略。

关闭的工具会从发给模型的工具 schema 中移除，执行守卫也会拒绝该工具，避免已有或手写工具调用绕过开关。工具目录通过 DSH 的模式注册表和 standing scope 实时解析；内置模式和其他插件引入的模式都会自动列出，各模式的每个实际工具都能独立开关。若第三方模式本身无法装载，工作台会显示该模式的解析错误。
