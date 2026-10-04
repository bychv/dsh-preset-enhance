# DSH 系统模板与请求参数

工作台置顶的「DSH 系统提示词 · 模式名」可以编辑正文、开关注入和恢复默认。它保持固定位置与 system 角色，不进入酒馆顺序表。

## 按模式保存

修改保存在**当前预设**的 `dsh_system_prompt_templates` 中，以 DSH 模式 ID 为键。不同会话使用同一预设、同一模式时共享该模式的修改；不同预设或模式互不覆盖。

- 切换到已编辑的模式：使用该模式保存的正文。
- 切换到未编辑的模式：从 DSH 当前模式的提示词服务读取默认内容。
- 恢复默认：只删除当前模式的修改，下次请求继续使用该模式的最新默认内容。
- 空字符串是有意保存的空模板，和未配置有区别。

输入文字后 DSH 可能已经创建空白会话；工作台从 `retainedBy.mainView` 获取输入框所属会话，并订阅它的模式状态与宿主确认事件，不继续读取无会话的模式状态。旧版宿主仍兼容 `current` 字段。

新会话尚未绑定时，工作台读取输入框模式选择器的同一份状态，使用所选模式的默认/已编辑模板；没有选择状态时使用 DSH 默认模式。此时尚未确定的会话变量保留为宏。切换输入模式只更新模板，不重载工作台或丢弃草稿。首条消息发送时从真实会话及本次调用配置重新解析，不依赖历史请求。

模式切换通过 DSH 的 `agent-preset/selected` 事件通知工作台，更新条目正文，不丢弃其他模式的草稿。全局自动保存开启时沿用现有预设保存流程；关闭时需点击「保存预设」。分享文件与普通 ST JSON 都保留这些字段。

专用「预设模式」仍完全按酒馆预设注入，不额外加入 DSH 模式提示。其他模式关闭置顶开关时，也会从请求副本中移除旧的系统提示与运行环境快照；原始会话不变。

## 动态宏

插件读取 DSH 的公共 `systemPrompt.assemble({ agent, scope, signal })`，保留当前模式的作用域及段落顺序，读取尚未插值的正文与变量。既不复制一份固定官方提示词，也不通过替换当前模型名、目录等实际字符串来猜测变量位置。

| 宏 | 来源 |
| --- | --- |
| `{{dsh::var::model}}` | 当前 DSH agent 的模型 |
| `{{dsh::var::provider}}` | 当前适配器 |
| `{{dsh::var::cwd}}` | 会话工作目录 |
| `{{dsh::var::变量名}}` | 其他模式或插件注册到 DSH 的变量 |
| `{{dsh::section::段落标识}}` | 当前模式中的一个完整段落，标识由面板提供，直接保留可读名称，例如 `tools:sdk` |
| `{{dsh::prompt}}` | 当前模式完整的默认系统提示词 |

源码中直接注册的通用变量是 `provider`、`model`、`cwd`。模式人格正文里的 `{{model}}`、`{{cwd}}` 等会变成对应的 `dsh` 宏。工具说明、SDK、MCP 服务说明、计划状态、文件引用规则、源码位置与 Web 地址等由函数或运行环境生成，因此使用完整段落宏，避免在保存修改后把这些动态内容冻结。暂时为空的动态段落也保留宏，例如未进入计划模式时的计划规则。

「动态宏与段落」可查看当前解析结果，也可将某个段落展开为可编辑正文。展开后，DSH 注册变量的宏继续更新；直接写入正文的其他文字会保持用户的编辑。第三方新增的动态段落也可通过面板中的段落宏引用。

旧版本保存的 URI 编码段落宏继续兼容，新生成的宏名称直接使用 `tools:sdk`、`plan:policy` 等可读标识。

宏值作为原样文本插入，不再执行其中的酒馆宏。缺少所引用的变量或段落会明确报错，避免静默删掉提示词。每次发送与草稿预览分别获取当前变量，编译缓存包含本次模板与宏值；模型、目录或模式状态变化不会复用旧结果。

DSH 的运行环境快照和时间消息有独立来源，不属于可编辑的系统正文。保留模式提示时继续沿用宿主注入。

## 请求参数

「请求参数」卡片的滑块与数值输入同步，范围为整数 `0–1000000`。`0` 表示沿用原请求或适配器默认的输出上限；正数传入 DSH 的 `maxTokens`，并写入 Chat / Messages 请求的 `max_tokens`。

流式默认开启。关闭后，Chat / Messages 请求发送 `stream: false`，Chat 同时移除 `stream_options`；收到完整 JSON 后转换成 DSH 的事件格式，保留正文、思维链、工具调用、用量和结束原因。预填充与 DSML 转换继续适用。无效或不完整响应不会伪造完成事件。此控制针对插件已支持的 Chat / Messages HTTP 传输；其他适配器仍使用各自的传输实现。

配置跟随当前预设，仅在预设注入启用时生效。恢复 DSH 默认正文不会改变请求参数。合法范围不代表每个模型都接受这一输出上限；接口自身仍可拒绝过大的值。

```json
{
  "dsh_system_prompt_enabled": true,
  "dsh_system_prompt_templates": {
    "standard": "使用 {{dsh::var::model}}。工作目录：{{dsh::var::cwd}}。\n{{dsh::section::tools:sdk}}"
  },
  "dsh_request": { "max_tokens": 0, "stream": true },
  "prompts": [{ "identifier": "chatHistory", "marker": true }]
}
```

读取接口 `POST /preset-enhance/api`：

```json
{ "action": "dsh-system-template", "sessionId": "当前会话 ID", "modeId": "standard" }
```

返回 `available`、`modeId`、默认 `template`、当前 `text`、变量名和各段落的模板/宏/解析结果。工作台默认数据同时返回当前模式的 `dshSystemTemplate`。该接口用于工作台现有认证路径，不改变内部 agent 只读 API 的授权边界。

## 源码核对与验证

核对 alpha 槽位官方源码 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`：

- `packages/core/system-prompt/src/index.ts`：组装、作用域、变量、独立运行环境上下文。
- `packages/core/agent/src/dispatch.ts`：组装上下文中的 agent 与 scope。
- `packages/core/agent-loop/src/index.ts`：通用变量注册。
- `packages/client/ui-agent-preset/src/client/index.ts`、`seat-store.ts` 与 `ui-renderer`：输入框模式的公开 slot face / store 及订阅。
- `packages/preset/persona/src/index.ts` 与 Web standard 模式声明：模式人格与模型、工作目录变量。
- tools、MCP、plan-mode、file-reference、app-boot、web-app、tool-subagent：运行时段落。

自动验证覆盖参数范围、控件同步与保存、模式分别编辑/默认/恢复、动态宏与缓存、Raw 草稿和发送一致、非流式多工具响应、思考字段、用量、结束原因与 DSML。真实 `0.2.1-alpha.1` 沙盒验证使用宿主创建并挂载的 agent 与真实提示词服务，不向模型 API 发起收费请求。
