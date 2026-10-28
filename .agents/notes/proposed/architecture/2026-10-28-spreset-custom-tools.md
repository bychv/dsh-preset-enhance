# SPreset 内嵌工具与脚本兼容

Status: proposed

## 调研范围与结论

2026-10-28 静态检查用户指定的本地预设、当前 next-ver 源码及沙盒 DSH 0.2.2-alpha.2 工具服务。未执行样本脚本、未加载其远程脚本、未发送模型请求。本文不复制样本正文、工具名称或外部加载地址。

应兼容 SPreset 的数据契约与脚本阶段，而非特判某个预设。样本不是单纯的工具 schema：它组合工具定义、调用转正文、输出缓冲及最终请求改写。只注册工具会改变其原意，尤其可能额外触发 DSH 工具续轮。

样本的 tavern_helper 脚本实际是注入远程 SPreset 的加载器，并非完整运行时。以下字段结构与脚本行为可由样本确认；启用优先级、调用消费是否仍执行 action、stealth 的具体语义及所有阶段的原始执行顺序，仍需核对 SPreset 对应版本源码，不能视为已确认。

## 已观察的数据契约

| 字段 | 样本结构及作用 |
| --- | --- |
| extensions.SPreset.ToolBindings | 以 prompt identifier 为键的记录；包含 enabled、uuid、code、valid、resolvedName、editorMode、form |
| code | 函数体形式，return 一个含 name、description、parameters、action、stealth 的对象；不是 JSON |
| form | 表单镜像，包含 name、displayName、description、参数列表、actionBody、formatMessageBody、stealth |
| OutputPreprocessing | enabled、script；脚本接收 buffer/final/state，返回 output/hold/state |
| consumeToolCalls | 样本配置为 true，配合 formatter 将工具参数转换为输出文本；是否同时执行 action 待核对运行时 |
| toolCallFormatter | 对象 { enabled, script }；脚本接收 calls，使用 call.name 和已解析的 call.arguments |
| FinalRequestProcessing | { enabled, script }；接收 request，返回修改后的请求 |

样本有两条工具绑定，其中一条开启、一条关闭；均具有表单及代码两种表示。action 返回简单确认值，正文来自 formatter 对调用参数的提取。最终请求脚本在条件满足时把部分消息移动到动态工具 description，并重建 messages，因此它不等价于普通提示词序列处理器。条件不满足时原样返回。另有 ChatSquash 后处理和提示词条件脚本，属于独立阶段，不应混成一个万能 eval。

## 当前实现缺口

- [s-preset-library](../../../../src/lib/s-preset-library.mts)保留 ToolBindings，编辑器工具页目前仅展示原始配置，没有注册或执行。
- normalizeSPresetData 的 OutputPreprocessing 默认 toolCallFormatter 为字符串，mergeDefaults 遇到对象会落回空字符串。镜像同步及规范化展示经过该路径时有丢失风险；应先支持实际对象结构及旧字符串格式，并验证保存、分享、编辑往返。
- [现有响应转换](../../../../src/lib/toolcall-prefill.mts)将原生/正文/思考中的调用恢复为标准工具调用，由 DSH 执行；没有调用转正文的独立消费阶段。
- 脚本运行时与 promptSequence 仍是[规划](../../../../docs/plans/PLUGIN_TEMPLATE_CONTRACT_PLAN.md)，不得把预留名称视作可调用服务。

## 建议实现边界

### 1. 先建立统一的工具描述

引入内部规范化描述，包含预设身份、绑定 ID、模型可见名称、schema、启用条件、执行脚本引用及输出处理引用。form 是可编辑结构，code 是可执行定义；不能在二者冲突时悄悄选取有利的一份。先核对 SPreset 的 editorMode/生成规则，未知版本冲突应显示诊断。valid/resolvedName 只作缓存提示，导入后重新校验。

启用状态应结合实际选中的预设、关联条目与顺序表状态、绑定开关及工具策略；精确优先级待原运行时验证。内部身份使用预设 ID + 绑定 ID，不用名称做身份。同名宿主/MCP/其他预设工具不得覆盖；优先报告冲突，不自动改模型名称破坏脚本引用。

### 2. 区分执行与输出消费

执行型工具通过 DSH tools.register 接入，schema 与 action 映射到工具定义及 execute，输出契约也要补齐；不能只向 HTTP tools 追加一个宿主找不到的工具。注册和准入要在 tools.resolve 前准备，并与现有[工具策略](../../../../src/lib/tool-restrictions.mts)统一，支持会话隔离、切换预设、停用、热重载释放。当前策略特别处理 agent-local 工具，新增工具须同时验证 schema 可见性与执行守卫，不只依赖 restrict。

输出型工具在模型响应边界恢复成统一调用后，通过所选 formatter 转成 assistant 文本。仅消费当前请求明确归属的预设工具；宿主/MCP 工具照常交给 DSH。不能把一个全局 consumeToolCalls 直接应用到所有调用，否则样本 formatter 的兜底分支可能吞掉正常工具。

同一响应混合输出型与执行型调用时，只移除已成功消费的调用，保留其余调用的 ID、参数、顺序与工具结束语义。全部被消费且正常结束才可按普通正文完成；错误、取消、长度截断不得伪装成成功。不完整 JSON 不执行 formatter，也不杜撰参数。action 是否运行及运行顺序，必须按已确认的 SPreset 语义实现，不能默认用执行 action 然后再生成一轮正文来替代。

这属于响应语义转换，应发生在 DSH 保存 assistant 消息之前，不放进显示正则包。否则屏幕看起来有正文，下一轮历史仍是另一套内容。Raw 保留真实出站请求，另区分原始响应与转换后内容，不用转换结果冒充线上原文。

### 3. 最小脚本运行能力

采用可终止、资源受限的隔离运行时；导入和预览不执行 action，脚本授权不随分享文件携带。不能在宿主直接 new Function/eval，也不能把 node:vm 或普通 Worker 本身宣称为安全沙盒。

首批支持纯函数定义与数据处理：工具定义工厂、formatter、输出缓冲脚本。跨边界仅传 JSON 数据，明确 console 的受限实现；状态按请求/choice 隔离，取消与卸载后丢弃迟到结果。文件、网络、DOM、SillyTavern 全局、远程 import 均不隐式开放。带这些依赖的脚本给出缺失能力，不能默默返回成功。

form 可直接用于静态 schema 预览，但任意 actionBody/code 的兼容仍需要运行时；不通过匹配某段 return 常量源码来绕过脚本支持。表单与代码统一编译到上述描述，避免两套生命周期。

### 4. 明确流水线

建议本插件的处理阶段为：预设编译与宏/提示词正则 → 工具定义及协议请求准备 → 受限最终请求脚本 → 参数与协议完整性校验 → 预填充工具兼容转换 → 实际请求快照 → HTTP。

FinalRequestProcessing 接收的是协议请求副本，不是只有 messages 的 promptSequence。限制可修改的字段，不向脚本传鉴权头、密钥或任意 URL 配置；新增动态工具必须声明为输出用途或有已登记执行处理器，不能制造无人处理的工具。与预填充转换的先后是本插件设计，需用 SPreset 源码和虚构夹具验证语义差异。

响应顺序建议：原生/DSML 调用统一恢复 → 预设调用消费与格式化 → 输出缓冲脚本 → 现有正文提取与宿主事件。当前提取与 DSML 在同一模块交织，需要拆清职责后验证，不能再新增一套竞争解析器。所有已有 DSML 格式与思考/正文捕获兜底保留。

任意 formatter 可能依赖完整 calls，首版等完整调用参数再格式化，普通正文继续流式。不要承诺任意脚本输出都能逐 token 展示。缓冲脚本要限制 hold 大小及状态体积，并在最终完成时明确刷新规则。

## 实施顺序与验收

1. 修复字段无损保留，增加虚构的 form/code/object formatter 分享往返测试；工作台显示支持状态。
2. 获取并核对对应 SPreset 运行时版本与许可，固定字段优先级、启用规则、consume/stealth 及阶段契约。远程加载器不可直接放进 DSH 页面执行。
3. 实现隔离纯函数运行与工具规范化，先完成普通 Chat 的输出型调用闭环，再接执行型 action。随后验证 Messages、预填充 DSML 及 PTC；不支持的组合明确标识。
4. 按需求接最终请求处理、ChatSquash 和条件脚本，避免第一步就重建整个酒馆环境。

重点验收：绑定/顺序表开关组合、两会话不同预设同名工具、切换及热重载、中途停用；普通原生调用与 DSML、思考中的调用、混合调用、跨 chunk 参数、错误/取消/截断；历史中的正文与工具配对；Raw 和实际出站一致；纯函数失败与超时不吞正常工具；导入和预览无副作用。

未实现以上功能。本轮仅静态调研与记录，没有修改运行代码或执行测试。
