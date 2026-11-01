# 预设内嵌上下文文件与 DeepSeek Files 复用

Status: proposed

## 问题

预设目前只能携带文本：提示词条目的内容是字符串（`PresetPrompt.content?: string`，见 [类型定义](../../../../src/lib/types.d.mts)），编译后每条注入消息都只包含一个 `text` 块（见 [编译器](../../../../src/lib/preset.mts)）。[预设格式说明](../../../../PRESET_FORMAT.md) 里也没有资产字段，因此角色设定图、参考图或上下文文件都无法随预设分发。

DeepSeek 带图有两条路：内联 base64（每轮重传）与 Files API 的 `file_id`（上传一次、多轮引用）。插件已在**宿主附件**这条路径上实现了后者，但复用身份来自附件（`AttachmentId` + `ImageVariantId`）；预设图片没有这种身份，`RequestFiles` 缺身份时抛 `FileResolutionFailure`，整个请求退回 base64。

## 方案

### 注入点：两条适配器共用同一个瀑布

源码核实（`@deepseek-ai/dsh-llm`）：

```
agent-loop
  → llm.prepareCall(...)            // 会调用适配器自己的 prepareCall
  → preparedCall.stream(request)
  → LlmRuntime.streamWithRegistration(options, { dispatch: adapterCall.stream })
  → ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))
  → 插件 injectStream（改写 options.messages）
  → next() → dispatch → 具体适配器
```

关键结论：**适配器实现了 `prepareCall` 也不会跳过 `llm/stream` 瀑布**——`streamWithRegistration` 就是瀑布本身。因此插件的注入对**官方适配器（`@deepseek-ai/dsh-llm-deepseek`）和我们自己的 chat 适配器（`preset-deepseek-chat`）同样可见**，注入由插件完成，不需要宿主代为注入。

### 兼容矩阵：必须注入标准 ref 块

| 注入形态 | 自有 chat 适配器 | 官方适配器 |
| --- | --- | --- |
| `{ type:'image', attachment:{ attachmentId } }` | 插件 `buildRequestImages` 收集 → 变体 → Files | 官方自身收集 → `readImageRequest` → 变体 → Files |
| `{ type:'file', attachment:{ attachmentId } }` | 同上 | 同上 |
| 只有字节、没有 `attachment` ref | 可用（插件自持字节） | **不可用**（官方要求 ref） |

所以"同时兼容两者"的公共分母是**标准 ref 块**。ref 由官方附件服务入库取得：`AttachmentStore.admitPromptContent(content)` 接受同序内容数组，`{type:'text'}`、`{type:'file', attachment}`、`{type:'image', attachment}` 原样通过，**未带 `attachment` 的图片**按 `imageLimits.maxImagesPerMessage` 与 `maxMessageImageBytes` 校验后入库并回填 ref；另有 `admitEncodedImages` / `admitEncodedFile` 单入口。入库由插件调用，注入也由插件完成。

### 1. 预设格式（向后兼容）

提示词条目新增可选 `contextFile`：

```json
{ "identifier": "ref", "content": "",
  "contextFile": { "kind": "image", "mediaType": "image/png", "data": "<base64>" } }
{ "identifier": "ref", "content": "",
  "contextFile": { "kind": "image", "mediaType": "image/png", "asset": "<sha256>", "attachmentId": "<可选缓存>" } }
{ "identifier": "ref", "content": "",
  "contextFile": { "kind": "file", "mediaType": "application/pdf", "name": "spec.pdf", "asset": "<sha256>" } }
```

- `data`：编辑器粘贴/拖拽产生（编码字节）
- `asset`：字节随分享包分发，写在 `extensions.assets`（按 sha256 去重）
- `attachmentId`：首次入库后回填，后续请求直接引用，不再传字节

普通 SillyTavern JSON 可在同层放 `dsh_assets`，导入时按需迁移；旧导入器忽略未知字段。

### 2. 编译期与注入

- 有 `contextFile` 的条目产出 `{ type:'image' | 'file', ... }` 内容块，保持来源顺序，不参与宏展开
- 请求前：编码字节 → 入库拿 ref（或直接用已回填的 `attachmentId`）→ 把标准 ref 块并入 `options.messages`
- Messages 模式沿用现有 `adaptPresetForMessages`，需确认图片/文件块原样通过而非被当成文本
- 预填充识别：带上下文文件的条目算"有内容"，但**末条是图片/文件块时不构成可续写前缀**，`assistantPrefix.active` 必须为 `false`

### 3. 复用

ref 一旦是官方 `AttachmentId`，后续完全交给适配器：`readImageRequest(ref, target)` 返回**请求字节 + 覆盖全部变换输入的缓存/上传身份**，变体缓存、offload、Files 上传与兜底、跨轮复用都沿用官方实现。`DeepSeekUploadIndex` 与 `RequestFiles` 保持原样，不再需要自定义上传身份。

### 4. 降级阶梯

1. **入库可用**（主路线）：注入标准 ref 块 → 官方与自有适配器都支持
2. **入库不可用**：自有适配器走兜底——插件自持字节 + `preset:<hash>` 身份复用现有 upload index；官方适配器下**明确警告并跳过该图**，不静默失败、不整轮失败
3. **完全无图片能力**：仅注入文本，警告一次

### 5. 编辑器：编辑时粘贴导入

- 三种入口：**粘贴**（剪贴板位图/文件）、拖拽、文件选择；粘贴是最短路径
- 粘贴即校验：格式白名单、单图字节上限、尺寸；不合格当场提示，不写入预设
- 即时预览（缩略图 + 尺寸/字节/媒体类型），可移除
- 保存：小图保留 `data`；勾选"打包"或导出分享包时收敛为 `asset`；若入库成功则回填 `attachmentId`
- 工作台与 SPreset 编辑器共用同一套粘贴/预览/校验组件

### 6. 不支持图片的模型：在准入边界报错

官方对"模型不收图片"的处理分两层，必须区分：

- **派发层不报错**：`@deepseek-ai/dsh-llm` 在 `streamWithRegistration` 里判断 `modelInfo.inputModalities` 不含 `image` 而消息里有图时，调用 `projectImagesForTextModel(...)` 把图片**投影成文本**（文件同理走 `projectFilesToText`）。也就是说，如果插件把图注进去就撒手不管，最终会被静默降级。
- **准入层才报错**：`dsh-api-session-controller`（用户附加图片）与 `dsh-subagent` 在准入时校验 `inputModalities`，抛 `reason: MODEL_DOES_NOT_SUPPORT_IMAGES`，文案为 `Model "<model>" does not support image input.`；前端把它映射成 `image.modelUnsupported`。

预设图片进入请求的等价边界就是**插件的注入环节**，因此这里要主动报错，而不是让官方派发层去投影：

**能力来源统一走 DSH，不另建表**——`llm.resolveModelInfo(provider, model)` 一条通路覆盖三种路由：

- 官方 `deepseek-official`：DSH 直接给出 `inputModalities`
- `pi-ai`（`@deepseek-ai/dsh-llm-pi-ai`）：同样用 DSH 的 provider 解析读取模态，插件不自带 pi 的模型表
- 自有 `preset-deepseek-chat`：适配器自己实现 `listModels` / `resolveModelInfo`，而它的目录**已经同步官方**——[chat-models.mts](../../../../src/lib/chat-models.mts) 的优先级是「显式 `chatModels` 配置 → 官方 provider 设置（含 `inputModalities`）→ `llm.listModels('deepseek-official')` + `resolveModelInfo` → 内置默认」。所以"同步官方模型状态"不需要新增机制，只需在现有目录之上做校验。

**报错模板逐字复用官方**：`new LlmError('Model "<model>" does not support image input.', 'MODEL_DOES_NOT_SUPPORT_IMAGES')`。`LlmErrorCode` 就是 `string`，宿主原样透传该码，前端据此映射到 `image.modelUnsupported`，与官方准入层同形制。

执行顺序：

1. 注入前按上面的通路解析当前模型的 `inputModalities`
2. 已声明且不含 `image`、而本次编译确实带入了图片块 → 抛上面那条错误（不进入请求）
3. 模型**未声明** `inputModalities` → 按官方语义视为"不校验"，不报错
4. 编辑器侧另做一次**非致命预检**：绑定模型明显是纯文本时保存即提示，硬保证仍放在请求期

### 不包含

- 不改动宿主附件路径的上传身份与缓存语义
- 不做图片编辑/裁剪，只按官方限额校验与重采样
- 不把上下文文件注入到 DSH 系统模板或工具定义
- 不支持远程 URL 来源

## 考虑过的替代方案

- **用 deepseek-recipe 的 `ImageResolver` 作参照**：不采用。recipe 是推理服务侧的前端 SDK，其解析器服务于自己的服务端请求管线，与 DSH 的附件服务、变体身份和 Files 复用不是同一套抽象；照搬会引入第二套身份与配额概念。
- **自定义 `preset:<hash>` 上传身份**：可行（复用现有 `RequestFiles` + `DeepSeekUploadIndex`），但只覆盖自有适配器；与官方 `AttachmentId` 并存会形成两套复用键。降级为兜底方案。
- **依赖宿主自动注入**：不采用。注入由插件在 `llm/stream` 完成，两条适配器共用同一瀑布，宿主不需要参与。
- **交给官方派发层静默投影为文本**：最省事，模型也能跑，但预设里精心放的图会被无声丢掉，用户无法知道发生了什么；仅在用户显式选择"降级而非报错"时作为可选行为，不作为默认。
- **只做内联 base64**：不动入库链路，但每轮重传大图，且把二进制写进 state；仅适合小图。
- **支持远程 URL 来源**：省存储但要自带出网、SSRF 过滤、重试与超时；官方附件服务没有这个入口，本次不做。

## 验收与风险

可观察的完成条件：

1. **自有 chat 适配器**：预设图/文件进入请求，且走 Files 上传与变体解析
2. **官方适配器**：同一预设无需改配置即可带图（走官方 ref 解析）
3. 同一张图连续 N 轮只产生 **1 次** Files 上传
4. `file_id` 过期时恰好重传 **1 次**并成功，不整轮失败
5. 首次入库回填 `attachmentId`，后续请求不再传字节
6. 入库不可用时按降级阶梯行为可观察：自有适配器仍可用，官方适配器有明确警告
7. 缺资产的旧预设仍能工作，不崩溃
8. 不持久化 API key、不写绝对路径；分享包可往返
9. 超过 `maxImagesPerMessage` / `maxMessageImageBytes` 时明确警告
10. 末条为图片/文件时 `assistantPrefix.active === false`
11. 编辑器粘贴位图后立即预览并可保存
12. Messages 模式下图片/文件块不被 `adaptPresetForMessages` 破坏
13. 纯文本模型 + 含图预设 → 请求以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 失败，文案含模型 id，且**不**落入官方的静默文本投影
14. 多模态模型 → 正常带图，不误报
15. 模型未声明 `inputModalities` → 不报错（与官方一致）
16. 编辑器在纯文本模型下保存含图预设时给出非致命提示

风险：

- **入库能力是否对插件开放**：目前 [index.mts](../../../../src/index.mts) 只用到 `readImageRequest`，需确认 `ctx.get('attachments')` 是否暴露 `admitPromptContent` / `admitEncodedImages` / `admitEncodedFile`。这决定主路线与降级路线。
- **官方适配器的模态支持**：官方适配器声明 `inputModalities: ['text','image']`，文件类型是否同样支持需实测。
- **ref 失效**：附件库清理后回填的 `attachmentId` 可能失效，需要"引用失败则用本地字节重新入库"的一次重试，且不能把失败算进配额。
- **体积**：内联 base64 会把二进制写进预设与 state；即便持久化不是 OOM 的原因，state 体积仍影响每次事务的解析与写盘耗时，故打包成 `asset` 优于长期内联。
- **两条通道收敛**：宿主附件与预设上下文文件必须共用同一套 ref 语义，否则同一张图可能被重复计入配额。
- **UI 成本**：工作台与 SPreset 编辑器都要加粘贴、拖拽、预览与校验。
- **隐私**：分享包带图/带文件可能包含敏感内容，导出需明确提示。

### 待确认

- `pi-ai` 的模型是否都声明了 `inputModalities`；未声明时按官方「不校验」处理，是否需要更保守的选择
- 插件注入发生在瀑布内，抛出的 `LlmError` 会以 `finish/error` 结束该轮；是否要在工作台另外展示一次可读提示
- 插件是否可调用 `admitPromptContent`（决定主路线还是降级路线）
- 官方适配器是否支持文件（非图片）输入
- 是否允许 assistant 角色条目带上下文文件
- 图片是否参与提示词正则（当前正则只处理文本段）

## 相关资料

- 官方包（宿主侧，不在本仓库）：`@deepseek-ai/dsh-llm` 的 `streamWithRegistration` 瀑布；`@deepseek-ai/dsh-attachment` 的 `admitPromptContent` / `readImageRequest` / `admitEncodedImages` / `admitEncodedFile`；`@deepseek-ai/dsh-llm-deepseek` 的内联上限与 offload 量化常量
- 本地复刻：[文件存储](../../../../src/vendor/deepseek-chat/file-store.mts) · [请求期解析](../../../../src/vendor/deepseek-chat/request-files.mts) · [上传索引](../../../../src/vendor/deepseek-chat/upload-index.mts) · [图片序列化](../../../../src/vendor/deepseek-chat/serialize.mts) · [宿主图片类型](../../../../src/vendor/deepseek-chat/host-types.mts) · [连接与配额](../../../../src/vendor/deepseek-chat/config.mts)
- [编译器](../../../../src/lib/preset.mts) · [预设类型](../../../../src/lib/types.d.mts) · [分享包](../../../../src/lib/preset-package.mts)
- [请求注入与图片收集](../../../../src/index.mts) · [Messages 映射](../../../../src/lib/messages-translate.mts)
- [预设格式](../../../../PRESET_FORMAT.md)
