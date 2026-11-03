# 预设内嵌上下文文件（图片与文件）

Status: implemented

## 问题

预设原先只能携带文本：提示词条目的内容是字符串，编译后每条注入消息只含一个 `text` 块，[预设格式](../../../../PRESET_FORMAT.md) 里也没有资产字段。角色设定图、参考图或上下文文件无法随预设分发。

DeepSeek 带图有两条路：内联 base64（每轮重传）与 Files API 的 `file_id`（上传一次、多轮引用）。插件已在**宿主附件**路径上实现了后者，但复用身份来自附件；预设图片没有这种身份，`RequestFiles` 缺身份时抛 `FileResolutionFailure`，整个请求退回 base64。

## 决定

### 注入口径：插件自己注入，两条适配器都覆盖

源码核实（`@deepseek-ai/dsh-llm`）：`LlmRuntime.streamWithRegistration` 就是 `ctx.waterfall(this, 'llm/stream', options, () => adapterStream(...))`，因此**适配器实现 `prepareCall` 也不会跳过 `llm/stream` 瀑布**。插件在这个瀑布里改写 `options.messages` 即可，官方适配器（`@deepseek-ai/dsh-llm-deepseek`）与自有 `preset-deepseek-chat` 共用同一注入点，宿主无需参与。

### 兼容分母是"标准附件引用"，不是字节

| 注入形态 | 自有 chat 适配器 | 官方适配器 |
| --- | --- | --- |
| `{ type:'image'\|'file', attachment:{ attachmentId } }` | 插件 `buildRequestImages` 收集 → 变体 → Files | 官方自身收集 → `readImageRequest` → 变体 → Files |
| 只有字节、没有 ref | 不可用（序列化器按 `attachment` 查找版本） | 不可用 |

所以预设字节先经宿主附件服务入库（`admitPromptContent` / `admitEncodedFile`），拿到官方引用后再注入。入库与注入都由插件完成。

### 分层实现

1. **格式**：条目新增可选 `contextFiles` 数组（每项 `kind`/`mediaType`/`data`/`asset`/`attachmentId`/`name`/`width`/`height`，上限 24 项），旧的单数 `contextFile` 兼容为一元素列表。校验在 [context-files.mts](../../../../src/lib/context-files.mts)，白名单 + 8 MB 上限 + 规范 base64。**同名文件允许重复添加**：身份由宿主附件服务的内容寻址决定，`name` 只是展示信息，因此不按名去重、也不自行改名（与 DSH 自身附件语义一致）。
2. **编译**：每个文件编译成一个**身份块**（`type: 'preset-context'` + `identifier`/`index`/`kind`/`mediaType`），**字节不进编译结果**，因此按会话缓存的编译不会复制二进制。只有上下文文件、正文为空的条目算有内容，不会被丢弃。
3. **请求期**：`materializePresetContext` 把身份块换成标准附件引用；入库不可用时**告警并跳过该块**，不整轮失败。
4. **预填充识别**：带上下文文件的 assistant 条目不算续写前缀（`assistantPrefix.active === false`），`lastContentRole` 返回 `other`；前缀必须是纯文本消息。
5. **模态校验**：注入**预设图片**前解析当前路由的 `inputModalities`（统一走 `llm.resolveModelInfo`，官方 / pi-ai / 自有适配器同一条通路）。已声明且不含 `image` 时抛官方同形制错误 `MODEL_DOES_NOT_SUPPORT_IMAGES`，文案 `Model "<model>" does not support image input.`。**会话历史里已有的图片不在此列**，仍由宿主原有逻辑处理（`projectImagesForTextModel`）。
6. **编辑器**：提示词编辑区新增「上下文文件」区块，支持粘贴位图、拖拽、文件选择三入口，即时缩略图/大小/类型与白名单、8 MB 校验，不合格不写入。

## 其他选择

- **用 deepseek-recipe 的 `ImageResolver` 作参照**：不采用。它是推理服务侧前端 SDK，与 DSH 的附件服务、变体身份和 Files 复用不是同一套抽象。
- **自定义 `preset:<hash>` 上传身份**：只覆盖自有适配器，且与官方 `AttachmentId` 并存会形成两套复用键；本次未采用。
- **依赖宿主自动注入**：不需要，瀑布对两条适配器都可见。
- **交给官方派发层静默投影为文本**：图会被无声丢弃，不采用。
- **支持远程 URL 来源**：需自带出网、SSRF 过滤与重试；本次不做。

## 影响与验证

已执行：

- `node scripts/build.mjs`（干净 typecheck）与全量 **615/615** 测试通过。
- 新增用例覆盖：`contextFile` 校验（类型白名单、缺来源、非规范 base64、非法 sha256）；编译产出身份块且**字节不进入编译结果**；context-only 条目不被丢弃；带上下文文件的 assistant 条目 `assistantPrefix.active === false` 且 `lastContentRole === 'other'`；入库成功时替换为标准引用且**只统计预设注入的图片**（历史图片不计数）；入库缺失时告警跳过。
- 编辑器侧由队友实现，`node --check web/editor.js` 通过，并纳入现有 vm + DOM 桩测试。

未执行 / 未覆盖（明确缺口）：

- **未在真实 GUI 手工点验**粘贴与预览观感。
- **未做分享包资产收敛**：`extensions.assets` 的导出（`data` → `asset` 去重）与导入迁移尚未实现；`asset` 来源目前只有宿主侧解析路径，编辑器不产出。
- **未实现内联字节兜底**：入库不可用时直接跳过并告警，而不是退回自有适配器的内联路径（序列化器按附件引用查找版本，需另行改造）。
- **无双适配器真实请求验证**：`inputModalities` 判定与引用注入均只经单元测试与源码核对，未在沙盒对官方/自有适配器各发一次带图请求。
- 编辑器在纯文本模型下的**非致命预检提示**（提案验收第 16 条）未做。
- SPreset 编辑器未复用该区块。

## 相关资料

- [格式与校验](../../../../src/lib/context-files.mts) · [请求期材料化](../../../../src/lib/preset-context.mts) · [编译器](../../../../src/lib/preset.mts) · [类型](../../../../src/lib/types.d.mts)
- [注入与模态校验](../../../../src/index.mts) · [分享包](../../../../src/lib/preset-package.mts) · [Messages 映射](../../../../src/lib/messages-translate.mts)
- [本地复刻：文件存储](../../../../src/vendor/deepseek-chat/file-store.mts) · [请求期解析](../../../../src/vendor/deepseek-chat/request-files.mts) · [上传索引](../../../../src/vendor/deepseek-chat/upload-index.mts) · [图片序列化](../../../../src/vendor/deepseek-chat/serialize.mts)
- [预设格式](../../../../PRESET_FORMAT.md) · [工作台指南](../../../../docs/guides/WORKBENCH.md) · [测试](../../../../tests/core.test.mjs)
