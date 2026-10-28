# SPreset 内嵌工具与脚本的最小兼容

Status: proposed

已部分实现：next-ver 提供默认关闭的工具注册、受限 QuickJS、输出 session 与调用消费。操作与实际边界见 [SPreset 工具](../../../../docs/api/SPRESET_TOOLS.md)。FinalRequestProcessing、stealth、条目条件及其他阶段仍待实施，本文的总体兼容目标未全部完成。

## 调研依据与纠正

2026-10-28 只读检查本地样本、样本加载器指向的远端 inject.js、SillyTavern release 分支 tool-calling.js，以及沙盒 DSH 0.2.2-alpha.2 源码。下载文件在忽略的 sample/spreset-research/，未执行远端脚本或样本函数，未发送模型请求。

远端 inject.js SHA-256：3dc23dcd6e3653675653ac5d65139fd5ed5050687123af1143cdb7a7b51ff783。这个地址可变，不能证明获取版本与预设发布时一致；文件中的 versionNumber=10000 不能当作稳定发布标识。尚未确认该脚本的开源许可，不复制其实现到发布包。

**纠正首轮假设：SPreset 没有“执行型/输出型”工具类型，也不自动判断工具用途。** 所有绑定注册为普通酒馆工具；OutputPreprocessing.consumeToolCalls 是请求输出层的全局策略。不能根据工具名、参数形状或 action 返回简单确认值来分类。

## 远端已确认的行为

### 工具定义与启用

- syncSPresetToolRegistrations（inject.js 5674 行附近）检查 binding.valid、binding.enabled，以及关联 identifier 是否在激活顺序表中。
- getActiveEntryIdentifiers（5644 行）取 character_id=100001 的顺序表，先应用条目条件脚本决策，再选 enabled !== false 的条目。不是直接读取 prompts 中 enabled。
- 实际执行 binding.code 工厂，返回 name/description/parameters/action 等定义；form/editorMode 是编辑数据，注册路径不读取 form 替代 code。
- 同一批工具名称重复保留第一个并报告错误；uuid 用于注册更新，code 也用于定义缓存校验。接入 DSH 不能照搬其只比较 uuid 的更新路径，脚本内容修改也必须失效。
- 通过酒馆 registerFunctionTool 注册 action、formatMessage、stealth、shouldRegister；停止使用时 unregister。

### 消费开关与 action

wrapSPresetOutputGenerator（1374 行附近）在输出预处理开启时包装流式生成器：

1. 正文先进入输出预处理 session，普通文本继续流式返回。
2. consumeToolCalls 开启时缓存最新累计 toolCalls，每个流包向酒馆暴露 toolCalls=[]。
3. 流结束后调用 formatter，把生成文本追加到原正文，再输入同一个输出预处理 session，最后 finish 刷新 hold。
4. 成功后不向酒馆恢复调用，因此 **action 不执行，也没有正常工具续轮**。
5. formatter 或输出预处理失败时，最后一个包恢复原 toolCalls，交回酒馆正常工具流程。

没有工具归属过滤：包含其他扩展工具在内的全部调用都会进入 formatter。非流式走 consumeSPresetToolCallsFromResponse，在响应副本上追加正文并删除调用；tool_calls/function_call 正常结束改为 stop，失败返回原响应。不是仅显示替换，真实消息内容也发生变化。

formatSPresetToolCalls（1166 行附近）传入 calls、defaultText、provider、stream、final:true、channel；calls.arguments 已解析。返回字符串或包含 output/text/content 的对象。formatter 未启用时有默认参数转文本规则，不等于停用消费。默认规则对单字段文本解包，其余值 JSON 序列化并用换行连接。

### stealth 和最终请求处理

SillyTavern 的 [tool-calling.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/tool-calling.js) 显示：formatMessage 用于调用通知，不是把结果转成 assistant 正文；stealth 仍执行 action，但不保存普通 invocation，契约声明不触发后续生成。它与 consumeToolCalls 是不同机制。

FinalRequestProcessing（inject.js 1590–1663 行附近）在酒馆 chat completion generate 的 fetch 前处理 JSON 请求副本。可原地修改并返回 undefined，或返回请求对象；不能改变 stream/chat_completion_source，失败中止发送。它面对酒馆的请求结构，不能直接假定等同于 DSH GenerateOptions 或任意厂商 wire JSON。

## 当前插件缺口

- [s-preset-library](../../../../src/lib/s-preset-library.mts)保留 ToolBindings，但未运行注册；编辑器只展示。
- OutputPreprocessing 的默认 toolCallFormatter 为字符串，mergeDefaults 会把远端实际使用的对象形态转为空字符串。先修复此处及分享/镜像往返，兼容旧字符串，不重写用户脚本。
- [响应转换](../../../../src/lib/toolcall-prefill.mts)目前把原生及正文/思考中的 DSML 还原成普通工具调用，没有 SPreset 消费阶段。
- [脚本运行时方案](../../../../docs/plans/PLUGIN_TEMPLATE_CONTRACT_PLAN.md)仍未落地。

## 最小适配：复用 DSH 的操作接口

不新建工具类型、通用工作流系统、第二套工具执行器，也不照搬全局 fetch monkey patch 或酒馆 DOM 操作。工具定义 + 消费策略足够表达首批功能。

| 需求 | 优先采用的 DSH 入口 | 适配职责 |
| --- | --- | --- |
| 工具注册及释放 | tools.register / 返回释放函数 / Cordis 生命周期 | code 产出 schema；action 代理到脚本执行器 |
| 本轮启用 | ToolRegistrationOptions.when | 关联条目决策及选中预设，在 tools.resolve 准入前确定；与已有工具策略一致 |
| 执行、取消、审批、结果记录 | tools 原生执行管线与 exec.signal | 不绕过 tools.execute；保留现有守卫、超时、工具历史 |
| 结果与卡片 | output.schema/render、presentCall/presentResult | 保留 action 返回类型；formatMessage 仅有可确认的展示映射，不冒充正文 |
| 调用转正文 | llm/stream 官方 waterfall | 拦截统一 StreamChunk，消费完成调用后生成标准文本事件 |
| 调试 | 现有请求预览/Raw 和宿主工具记录 | 保留真实 wire 请求；标记消费阶段结果及失败原因，避免把未执行 action 记成成功工具执行 |

DSH 依据：沙盒官方源码 packages/core/tools/src/contracts.ts、index.ts，packages/llm/llm/src/index.ts 的 llm/stream 声明，以及 types.ts 的 StreamChunk。对应源码标签 dsh-v0.2.2-alpha.2（f3803c96974ad4a94195fb97e5c637e9c2a3afe3）。本插件已在 [src/index.mts](../../../../src/index.mts)使用 llm/stream，不需要为消费逻辑再改宿主服务方法。

### 注册与执行

内部身份按预设 ID + binding ID 保存，模型名称沿用定义；同名宿主/MCP 冲突显式报告，不覆盖。会话隔离不能只靠同名全局注册加 when：需在对应 agent scope 下建立生命周期，验证动态注册早于准入；不同会话可有同名不同定义。when 只判断，不在回调里修改注册。

工具 action 返回字符串时按字符串结果呈现，不随意 JSON.parse 改变返回类型。DSH 0.2.2 的 output 声明是必需项；未知输出约束须采用宿主支持的 JSON 契约并验证，不能只填 execute。所有调用包括消费失败恢复后的调用均受 DSH 原有权限控制。

### 响应消费

通过已有 llm/stream 路径包装本次请求的 next()，仅作用于明确启用预设的用户生成请求，不能误处理标题等辅助调用。请求开始固定预设/脚本版本与消费设置，处理中切换预设不混用新旧 formatter。

统一流已经把不同协议变成 block-start/tool-call-delta/block-end/finish 等事件，可避免分别实现 OpenAI/Gemini/Claude 消费器。完整缓存待消费工具块，普通正文按已有流继续输出；不能只删 delta 而留下 block-end 中完整 tool-call。调用收齐且正常结束后执行 formatter，把结果作为新文本块交给宿主。保证 block index 唯一、start/end 配对、usage 不丢，最终 finish 在刷新后发送。原始 replayState 可能引用已删除的工具块，需按官方 replay 契约同步处理或明确放弃不再有效的元数据。

消费失败恢复缓存的原工具块，交 DSH 执行；不能自行直接执行 action。error/aborted/max-tokens 不改写成正常结束，也不执行残缺参数。保持已有 DSML 兼容恢复层，在其输出标准工具事件之后消费，不新增竞争解析器。

**默认按原 SPreset 语义消费全部调用**，不能静默收窄为仅预设工具。界面应简短说明该模式会跳过工具执行，用户可用现有工具面板禁用不需要的宿主工具。若未来增加消费范围，必须作为明确的 DSH 扩展配置，而不是推断工具类型。PTC 把真实工具包装为 run_code，无法假装和原生消费等价；首版不承诺 PTC 消费兼容。

### 脚本支持与范围

复用同一个最小隔离执行器处理 code 工厂、action 和 formatter/输出预处理，不按某个脚本源码字符串做特例。仅 JSON 输入输出，可终止并限制时间与状态体积；不在宿主直接 new Function/eval。普通 Worker 或 node:vm 不等于安全隔离。可评估受限 JS 引擎，具体依赖和维护成本另行验证，不先搭完整脚本平台。

首版保留官方纯数据参数契约，不模拟 SillyTavern、DOM、任意网络/文件、远程 import。依赖这些能力的脚本明确标为不支持。导入与预览不执行 action，分享配置不能携带用户授权。使用虚构数据测试定义和 formatter；正式预览执行纯函数也必须有超时控制。

普通工具 + consumeToolCalls + formatter + 输出 session 是首个闭环。stealth 的隐藏持久化及终止续轮语义暂不适配，不能用隐藏卡片冒充兼容。条件脚本影响条目激活，遇到已启用但尚未支持的条件脚本必须提示，不能假装条件已计算。

FinalRequestProcessing 放下一步：先确认脚本所需的酒馆请求字段，构造窄兼容对象；能映射的修改回写官方 GenerateOptions，确需协议 wire 字段的再接本插件已有请求桥接。任意新增 schema 没有执行器的问题必须显式处理。仅工具注册和消费成功不代表样本的整个最终请求改写、ChatSquash 已兼容。

## 验收与边界

先做字段往返，再用虚构工具验证普通 Chat 的注册→原生执行与消费→正文两条路径，然后验证现有预填充 DSML。检查消费开关/formatter 开关组合、失败恢复、多个工具、流式/非流式、取消/截断、思考中 DSML、真实历史与 Raw、不同会话同名工具、切换及热重载。PTC、stealth、酒馆全局依赖单独列为不支持，不能宣称全兼容。

调研阶段完成远端及官方接口静态核对，未执行第三方脚本。后续实验性实现使用虚构工具测试隔离、注册与消费；实际验证范围见功能文档及提交说明。下载源码留在 sample，不提交或打包；后续实现按协议独立编写 TypeScript。
