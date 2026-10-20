# 借鉴官方 recipe 的工具解析，同时保留现有兼容兜底

Status: proposed

## 问题与依据

2026-10-20 调研官方 [deepseek-recipe](https://github.com/deepseek-ai/deepseek-recipe/tree/935817c66f5d6e64838f419692545f06787e485f)，参考提交固定为 `935817c66f5d6e64838f419692545f06787e485f`。本插件对照提交为 `c70d859`。本机克隆在 `sample/deepseek-recipe`，详细调研在 `sample/DEEPSEEK_RECIPE_REVIEW.md`，均被忽略；后续协作应以本文和固定提交链接为依据，不依赖 sample 被提交。

官方实现提供增量状态机、参数事件和结束原因处理，值得借鉴。但它处理推理后端原始输出，本插件接收 API 已拆分的正文、思维链与 SSE；不能整体替换后假定现有容错仍成立。

**用户明确要求：保留各种工具调用格式现有的兼容性兜底策略。采用官方状态机不得缩小当前可识别格式，也不得以“官方未支持”为由删除已有恢复路径。**

## 计划

1. 优先修正结束原因覆盖。当前 JSON/流式转换捕获调用后直接写 `tool_calls`，本地虚构探针确认 JSON 路径连 `length`、`content_filter` 也覆盖。参考官方只把正常 `stop` 转为工具结束的做法，保留异常结束原因；实施前核对 DSH 如何处理非正常结束携带的工具调用，避免改变标签后仍执行被截断或过滤的内容。
2. 如推进增量解析，用 TypeScript 实现工具名、参数名、属性和值的状态处理，保留跨块标记。标准格式优先解析，已有宽容解析保留为兜底；两者共用调用身份和完成状态，防止同一调用重复提交。参数 delta 只是展示/传输进度，不代表允许提前执行。
3. 每一步用现有工具转换与正文提取用例核对行为，再补官方测试启发的新边界。无需引入 Rust/Python 服务、tokenizer 或额外运行包，也不为此重写整个请求桥接。

## 必须保留的兼容范围

| 范围 | 要求 |
| --- | --- |
| DSML 竖线 | 保留单/双竖线、ASCII 与全角竖线及其间空白的既有识别 |
| 标记形态 | 保留 calls、tool_calls 等现有 wrapper 方言、大小写和分隔符漂移、转义反斜杠、零宽字符与 U+2581 填充处理 |
| 紧凑输出 | 不依赖换行；相邻 invoke/parameter、多参数同行、逐字符分片都可处理 |
| 外层包装 | 保留普通 tool_calls 包装、Markdown 代码围栏及无 wrapper 的完整 DSML invoke 恢复 |
| 官方信封 | 在显式 tool-calls begin/end 信封内识别不带 DSML 字样的 pipe invoke/parameter；信封外的裸 pipe 标签仍不得提升为调用 |
| 残缺格式恢复 | 保留重复闭标签、自闭参数、可确定边界的缺失 parameter 闭标签等恢复；无法证明调用完整时不执行，不把任意截断片段补成有效调用 |
| V4.1 名称 | 保留已有 namespace::function 的解析与历史往返行为，不擅自改名或扁平化 |
| 参数语义 | string=true 保持字符串，包括内嵌 JSON 和已有闭标签内的空白；其他参数沿用现有 JSON 解析及回退规则 |
| 输出通道 | 正文、原生思维链、正文提取器重新归类的文本均可捕获；不要求调用必须位于正文标签内 |
| 结束兜底 | 无 finish_reason、无 [DONE] 的正常 EOF 仍排空已缓冲的完整调用；错误和取消不伪造调用；截断调用不因状态机 finish 自动补齐 |
| 去重与次数 | 同一调用同时出现在正文和思维链时保留现有跨通道去重；同一通道两次相同调用仍是两次，不可全局按参数去重 |
| 流式体验 | 普通正文/思维链继续流式发送；只保留判断标记和调用所需的缓冲，不改成整条响应结束后才显示 |

上述范围以[当前转换器](../../../../src/lib/toolcall-prefill.mts)及[既有测试](../../../../tests/toolcall-prefill.test.mjs)的具体判定为准，不借兼容名义放宽为任意 XML 执行。继承[思维链调用捕获决策](../../implemented/bug-fix/2026-10-07-reasoning-tool-call-capture.md)的通道、次数和结束边界。

## 官方参考的适用边界

- [output_parser.rs](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/deepseek-recipe/src/stream/output_parser.rs)：状态、分片保留、思考/正文续写起始状态。token 输入可区分真实特殊 token 与普通文本拼出的同形标签，本插件的 SSE 字符串无法获得该保证。
- [processor.rs](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/deepseek-recipe/src/stream/processor.rs)：参数 JSON 转义、增量事件、结束原因及边界测试。
- [Chat 请求转换](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/deepseek-recipe/src/protocol/openai/chat_completion/request/convert.rs)：仍拒绝 prefix 与原生工具上下文并存，工具上下文也包括历史 tool_calls/tool 消息。不能据此取消当前工具定义和历史的文本转换；这不是线上 Beta 能力实测结论。
- [思维链归一化](https://github.com/deepseek-ai/deepseek-recipe/blob/935817c66f5d6e64838f419692545f06787e485f/deepseek-recipe/src/protocol/reasoning_content.rs)：已有思维链保留、缺失字段补空的规则可作对照；不复制旧轮思维链，也不伪造 ET_ 调用 ID 绕过验证。

官方仓库使用 MIT。若移植实质代码，保留 DeepSeek 的版权和许可；当前只是参考分析，未将官方实现复制进发布源码。

## 验收与风险

- JSON 与 SSE 两路径均覆盖正常 stop、length、content_filter、无结束信号、错误和取消；检查“完整第一条 + 截断第二条”不会扩大执行范围。
- 上表格式在正文、思维链、提取开关组合下保持兼容；测试完整块、任意标记处分片和逐字符分片。
- 补空字符串、字符串内 JSON/引号/反斜杠、Unicode、空调用、失败标记回退和续写前导换行用例；已有覆盖不重复堆叠。
- 双解析路径不得重复交付；不完整增量不得在 finish 时变成可执行调用；主通道和兜底结果的参数语义一致。
- 若引入参数 delta，补宿主集成验证工具名、ID、索引和参数拼接，确认 DSH 不会在调用未完成时执行。
- 关注长工具参数的缓冲和扫描开销，但不以优化为由删除容错路径。

## 当前验证范围

已读取上述官方源码，未编译官方 Rust 项目，未调用真实模型 API。使用本插件现有产物和虚构输入确认：官方单竖线 DSML 已能捕获；string=true 内的 JSON 保留为字符串；JSON 转换会把 length/content_filter 覆盖为 tool_calls。该证据不等于新状态机已实现，也不代表宿主执行语义已验证。

后续源码改动与验证入口：[宿主桥接](../../../../src/lib/deepseek-beta.mts)、[工具转换](../../../../src/lib/toolcall-prefill.mts)、[工具转换测试](../../../../tests/toolcall-prefill.test.mjs)、[正文提取测试](../../../../tests/output-extractor.test.mjs)。
