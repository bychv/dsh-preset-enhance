# 外部提示词模板 API

当前完成：模板注册目录、工作台选用、固定版本保存、静态/动态正文注入、酒馆 marker 关联和 chatHistory 深度修改。模板及解析器随作用域卸载自动清理。

**注册不会自动注入提示词。** 用户须在编辑器中选用、保存并启用预设。渲染模板、提示词序列处理器和脚本接口仍是设计方案，当前不能调用。

动态模板在发送与主动预览时解析；工作台另有同快照的 Raw 原文视图。设计、边界与验证见 [动态模板与预览方案](../plans/DYNAMIC_TEMPLATE_PREVIEW_PLAN.md)。

## 快速接入

服务名为 `presetTemplates`，契约版本为 `1`。声明依赖后，在插件自己的作用域注册：

```js
import { PRESET_TEMPLATES_SERVICE } from 'dsh-preset-enhance/templates';

export const name = 'example-choice-templates';
export const inject = [PRESET_TEMPLATES_SERVICE];

export function apply(ctx) {
  const templates = ctx.get(PRESET_TEMPLATES_SERVICE);
  const format = {
    id: 'choice-format',
    version: '1.0.0',
    title: '候选项输出格式',
    description: '供选项栏读取的候选项格式说明。',
    role: 'system',
    content: '在回复末尾输出候选行动，每个候选项放在 <option> 标签内。',
    defaults: { placement: 'afterHistory' },
  };
  const registration = templates.register(ctx, {
    providerId: 'example.choices',
    title: '候选项插件',
    templates: [format],
  });

  // 订阅回调只给修订号，读取 list() 获取最新目录。
  ctx.effect(() => templates.subscribe(() => {
    const snapshot = templates.list();
    // 使用 snapshot 刷新自己的目录视图。
  }));

  // 需要更新时使用新版本；可保留旧版本供现有的锁定引用使用。
  // registration.update([format, { ...format, version: '1.1.0', content: '新版格式说明' }]);
  // register 已绑定 ctx 的清理；也可提前 registration.dispose()。
}
```

这是宿主插件的服务接口，不是浏览器可写 API。运行环境需要能够解析本包的公开子路径；也可直接使用服务名字符串，不引用内部 `lib`。只把模板子功能放进 `ctx.inject(['presetTemplates'], scoped => ...)`，即可让提供者其他功能在预设插件缺失时继续运行；注册时应传入该 scoped 上下文。

TypeScript 可从同一公开子路径导入 `PresetTemplatesV1`、`PromptTemplateV1`、`TemplateProviderV1`、`TemplateCatalogSnapshot`、`TemplateRegistration` 和 `TemplateOwnerContext`。契约不依赖 DSH 的私有类型，也不会修改宿主的全局类型声明；需要时将 `ctx.get()` 结果标注为 `PresetTemplatesV1`。

## 方法

| 方法 | 结果与行为 |
| --- | --- |
| `register(ownerContext, definition, runtime?)` | 原子登记一个提供者，可另传动态解析器；返回 `update`、`dispose` 句柄；重复活跃 providerId 报错 |
| `registration.update(templates)` | 整批替换该提供者的目录；先校验全部条目，失败保留原目录；相同内容不增加修订 |
| `registration.dispose()` | 移除该次注册，重复调用无副作用；旧句柄不能影响重新注册的实例 |
| `list()` | 返回独立快照 `{ contractVersion, revision, providers }`，修改快照不会改变服务状态 |
| `subscribe(listener)` | 返回取消订阅函数；通知在微任务中合并，不承诺逐一送达中间修订，也不立即回放 |

需要初始数据时先订阅再读取 `list()`。订阅者应通过自己的 `ctx.effect()` 管理取消订阅。一个监听器抛错或异步拒绝不会阻止其他监听器，根包会记录监听器异常。服务停用后旧服务引用不再可用，需要等待宿主重新提供服务。

## 模板字段与限制

| 字段 | 说明 |
| --- | --- |
| `providerId` | 提供者稳定身份；不同提供者可注册同名模板 |
| `id`、`version` | 模板及版本身份；同一 id 可同时提供多个版本，不自动选出最新版 |
| 提供者/模板 `title` | 非空标题，最多 200 字符 |
| `description` | 可选文本，最多 2,000 字符 |
| `role` | `system`、`user` 或 `assistant` |
| `content` | 定义文本，可为空，最多 200,000 字符；注册时不展开宏、不执行回调 |
| `dynamic` | 可选 `{ resolverId, input, output }`；input 为 latest-user（默认）或 history；output 默认为 text，须包含 {{dynamic::body}}；history-patches 见下节 |
| `targetMarker` | 可选的酒馆 marker identifier，例如 charDescription、worldInfoBefore；声明后仅能关联该标记，不作为新增提示词插入 |
| `defaults.placement` | 可选位置建议：`beforeHistory`、`afterHistory` 或 `depth` |
| `defaults.depth` | depth 位置必须提供非负安全整数，其他位置不可填写 |
| `defaults.order` | depth 位置可选的安全整数，用于深度注入排序 |

三个身份字段各不超过 128 字符，以英文字母、数字或 `@` 开头，其余仅允许英文字母、数字及 `._/@+-`。version 是标识符，不做 semver 排序。同一个 providerId/id/version 的已知内容不能修改，包括标题、说明和位置建议；修改需新版本。当前只在同一注册服务存活期间检查版本指纹，注册目录不跨重启记忆版本；用户保存的关联另存内容指纹，重启后同版本内容变化也会停止注入，等待用户接受。

最多同时注册 64 个提供者，每个提供者最多 256 条模板（包含多版本）；目录序列化后的总文本上限为 4,000,000 个 JavaScript 字符单元。单次服务存活期间最多记住 8,192 个版本指纹，最多 1,024 个目录订阅。超过限制会拒绝整次操作，不截断内容。未建模字段不会进入目录，扩展能力需通过后续契约版本定义。

目录只驻留内存，退出后由提供者重新注册，不写入用户资源库、预设文件或聊天历史。提供者卸载即撤下其条目；已释放句柄不能继续 update。根包停用会清空目录和订阅。根包初始化失败时不发布此服务。

## 只读 HTTP 目录

工作台或未来显示包可通过现有 DSH Web 服务访问：

```text
GET /preset-enhance/api/templates
```

响应包含 `list()` 的字段，并附带 `fingerprints` 数组（providerId、templateId、templateVersion、fingerprint），供编辑器确认所查看的内容；空目录返回 `providers: []`，使用 `Cache-Control: no-store`。端点复用宿主 Web 服务的访问控制，不另开端口，不需要 sessionId，也不返回会话、变量或连接配置。

- `200`：当前目录快照。
- `405`：非 GET 请求；没有 HTTP 注册或写入接口。
- `503`：根包启动失败、正在停用或宿主不支持 `ctx.provide()`。

## 动态正文接入

先检查 templates.capabilities?.dynamicTemplatesV1，再注册。目录只保存动态描述，函数放在第三个 runtime 参数中，不通过 HTTP、预设或导出文件传递。

```js
if (!templates.capabilities?.dynamicTemplatesV1) return;
templates.register(ctx, {
  providerId: 'example.context', title: '动态上下文',
  templates: [{
    id: 'current-context', version: '1', title: '当前上下文', role: 'system',
    content: '本轮资料：{{dynamic::body}}',
    dynamic: { resolverId: 'context', input: 'history' },
    // 也可加 targetMarker: 'worldInfoBefore'，由用户关联现有标记。
  }],
}, {
  resolvers: {
    async context(input) {
      input.signal.throwIfAborted();
      // 可在这里以 input.userText 检索自己的只读数据，读取已提交变量。
      return JSON.stringify({ user: input.userText, count: input.history.length });
    },
  },
});
```

解析器返回字符串或 Promise<string>，最多 200,000 字符。输入为只读快照：sessionId、requestId、historyRevision、presetId、identifier、mode、protocol、purpose、latestUser、userText、variables、config 和 signal；声明 history 时才附带完整 history。工具结果不作为 latestUser。variables 提供已提交 local/global/values，不含本次稍后才执行的宏变更。

定义文本的宏照常展开；槽位结果作为字面文本插入，不递归执行其包含的宏。可用上下文类型为 DynamicTemplateContextV1，运行时注册类型为 TemplateRuntimeV1。解析器只读取数据，不写预设、变量和历史，不自动启动独立模型生成。

用户在两个编辑器的关联条目中填写配置 JSON、选择“失败时停止发送”（默认）或“失败时跳过条目”，点击“应用动态配置”后沿用普通保存/自动保存。template-select 新增 configure 动作，参数为 identifier、config（最多 20,000 字符 JSON 对象）和 failurePolicy（abort/skip）；锁定条目仍需先解锁。

仅启用且命中触发条件的条目执行，最多并发 4 个解析器，共用 5 秒截止时间。解析器响应发送取消、超时和作用域卸载；迟到结果丢弃。工具续轮重新读取当前历史，传输重试沿用同一份准备结果。动态调用不占保存事务，期间依赖发生变化会停止发送并提示重试，失败不会提交半成品宏变量。

根包不跨请求缓存回调结果，不用旧静态编译缓存绕过解析。固定版本约束定义；更改回调语义应提供新模板版本，运行数据变化无需 update 目录。

动态绑定的 mode 为 linked-dynamic；config、failurePolicy 和普通引用字段随单文件分享保留。本轮结果与历史不导出，旧版会跳过未知关联模式。转为本地副本会清除动态槽位并保留其余定义文本；如需保留某次实际正文，可先从预览复制。marker 解除关联仍恢复原标记来源。

## 工作台消息与 Raw 预览

“解析当前草稿”才执行动态解析；加载、自动保存及预填充检测不调用解析器。chatHistory 默认只展示最近两条消息，完整展开沿用同一快照，预设注入保持原位置。标题旁的“原始消息（Raw）”查看、复制完整请求正文，历史折叠不影响 Raw。

“查看最近实际请求”读取发送边界记录；Chat、Messages 和 Beta/DSML 转换后的正文按原文保存，HTTP 失败也可查看。工作台打开时接收新快照通知，可选择工具续轮和传输尝试。快照仅在内存中保留，每会话最近 4 次、总正文最多 32 MiB，插件重载后清空；缺失和超限明确提示。

草稿通过同一宏/正则编译、系统消息适配和动态解析流程。DeepSeek-预设增强的文本请求再调用共用序列化与 Beta 纯转换；宿主支持时读取其默认生成参数。官方 Messages、其他适配器、附件上传和发送时新生成的宿主提示词以发送后捕获的实际 Raw 为准；不能将尚未确认的适配器输入标成实际出站。

后端动作：POST /preset-enhance/api 的 request-snapshot 接收 sessionId 和可选 snapshotId，返回 snapshot；GET /preset-enhance/api/request-events?sessionId=... 只通知快照 ID。复用宿主鉴权与同源限制，不含请求头或凭据。两种视图共用相同快照，切换与展开不触发重新解析。

## 实现与下一步

源码入口为 `src/lib/template-registry.mts`；宿主发布及 HTTP 路由在 `src/index.mts`；公开类型来自 `src/template-api.d.mts`，构建为 `templates.d.mts` 随 npm 包提供。公开运行时入口 `templates.mjs` 只导出服务名，导入不会启动插件。

选用与解析在 `src/lib/template-bindings.mts`，两个编辑器共用 `web/plugin-templates.js`，实际请求和预览均经过 `compilePreset`。后续 T03 实现提示词序列处理链；显示包和脚本系统另行实施。

## 工作台选用与保存

普通编辑器与 SPreset 编辑器都有独立的“插件模板”区，与本地资源库分开。选择具体版本后点击“加入当前顺序表”，可继续调整位置、启用开关与深度；正文和角色由关联模板提供，只读。重复添加会定位已有条目，保留其启用状态。

普通工作台沿用预设自动保存开关；关闭时手动保存。SPreset 沿用“保存预设”。目录刷新不修改草稿；异步添加期间草稿或顺序表变化会拒绝覆盖。锁定条目须先解锁才能更新版本或解除关联。

- beforeHistory：插入当前顺序表的 chatHistory 之前；无标记时放末尾。
- afterHistory：放在当前顺序表末尾；无 chatHistory 时先补入标记，已有但停用时要求先启用。
- depth：转为现有深度注入字段，沿用工具调用/结果配对保护。

以上只是初次加入的位置建议。更新版本不改用户设置的位置和开关。尾部 assistant 模板沿用预填充判定，宏在编译时展开。提供者或锁定版本缺失、指纹不符时跳过该条目并提示，不使用旧快照偷偷注入；停用和闲置条目不产生缺失警告。提供者恢复后下一请求重新解析，已缓存请求也会失效。

“接受上方所选版本”显式更新正文快照和绑定；“转为本地副本”解除绑定，保留当前快照、顺序和开关，之后可自由编辑，也不再依赖提供者。

## 引用与单文件分享

### 关联酒馆内置标记

外部模板现在也能提供预设内 marker 条目的正文。提供者仍使用 register 注册静态模板，可加 targetMarker 指定用途：

```js
{
  id: 'character-description', version: '1', title: '角色描述',
  role: 'system', targetMarker: 'charDescription',
  content: '角色信息：{{char}}',
}
```

用户在两个编辑器的“插件模板”区选择版本、选择现有 marker，然后点击“关联到标记条目”并保存。未指定 targetMarker 的通用模板也可手动关联到 marker。注册本身不接管任何条目，不按显示名称匹配或自动创建标记。

关联只替换编译时的正文：保留原 identifier、marker、角色、顺序、深度、触发条件和启用状态，不把闲置或停用条目自动加入顺序表。模板 role/defaults 对 marker 关联不生效；模板宏仍在原位置展开。chatHistory 仅接受下述结构化历史修改模板，不能用普通文本替换；内置 DSH 系统提示词控制条目不能作为目标。

更新固定版本、内容指纹检查、缺失依赖提示和锁定限制沿用普通关联。缺失或同版本变更时跳过该条目，不悄悄切回旧快照或原标记来源。“恢复原标记”解除关联，之后重新使用原有 markers 输入；它不把原 marker 转为普通文本提示词。此接口提供正文，不实现世界书检索或变量插件本身。

标记关联保存为 templateBindings[identifier]，在普通引用字段上增加 target: "marker" 和 contentSnapshot。原 prompts 条目完整保留，正文编辑框只读显示插件快照。导出和重载保持该引用；旧版不支持 marker 关联时会跳过并提示，而非将其作为普通模板注入。

在 ST 预设内部保存（分享包中即 preset.data），以提示词 identifier 为键：

```json
{
  "extensions": {
    "dsh-preset-enhance": {
      "templateBindings": {
        "plugin-template:example": {
          "mode": "linked",
          "providerId": "example.choices",
          "templateId": "choice-format",
          "templateVersion": "1.0.0",
          "fingerprint": "保存时计算的 SHA-256"
        }
      }
    }
  }
}
```

prompts 中同 identifier 的角色和正文是保存时的源文本快照，prompt_order 仍是开关和位置的权威。未知扩展字段保留。普通 JSON 和单文件分享都会保留引用及快照；接收者未安装提供者时可查看快照、安装依赖，或显式转为本地副本。不分享整个提供者目录、运行时变量或插件代码。

编辑器通过 POST /preset-enhance/api 的 template-select 动作转换草稿，参数为 preset、presetId、selection。selection 包含 operation（add/bind-marker/update/detach/configure）、identifier（关联标记/更新/解除/配置时）、providerId/templateId/templateVersion、expectedFingerprint（添加/关联/更新时）和 characterId。返回 preset、identifier、changed；该动作不写盘，之后复用已有带 revision 的保存动作。GET 目录端点仍然只读。

## chatHistory 按深度修改

先检查 `templates.capabilities?.historyPatchesV1`。注册时指定 `targetMarker: 'chatHistory'`、`dynamic.input: 'history'` 和 `dynamic.output: 'history-patches'`。此类模板的 `content` 必须为空，不设置 `defaults`；保留 `role` 字段供目录协议使用，实际插入角色由每项操作指定。

```js
if (!templates.capabilities?.historyPatchesV1) return;
templates.register(ctx, {
  providerId: 'example.history', title: '历史上下文',
  templates: [{
    id: 'context', version: '1', title: '本轮历史补充', role: 'system',
    content: '', targetMarker: 'chatHistory',
    dynamic: { resolverId: 'history', input: 'history', output: 'history-patches' },
  }],
}, {
  resolvers: {
    history(input) {
      input.signal.throwIfAborted();
      const patches = [{
        operation: 'insert', depth: 0, role: 'system',
        text: '本轮上下文：' + JSON.stringify(input.config),
      }];
      const index = input.history.findLastIndex(message => message === input.latestUser);
      if (index >= 0) patches.push({
        operation: 'append-text', depth: input.history.length - 1 - index,
        text: '\n请结合补充上下文作答。',
      });
      return { patches };
    },
  },
});
```

用户在“插件模板”中选择版本，再关联到已有的 `chatHistory` 标记并保存。当前一个 chatHistory 关联一个提供者模板，可在同一次返回中提供多项操作。现有锁定、启用、触发条件、配置 JSON、版本更新和解除关联行为继续生效；解除关联恢复原历史来源。

| 操作 | 深度含义 | 其他字段 |
| --- | --- | --- |
| `insert` | `0` 为历史尾部、后置预设提示词之前；`1` 为最后一条消息之前；超过历史长度时放最前面 | `role` 为 system/user/assistant；`text` 为空白时不插入 |
| `replace-text` | `0` 为最后一条原消息，`1` 为倒数第二条；越界报错 | `text` 替换指定文本块；`textIndex` 默认 0，只计算 text 块 |
| `append-text` | 与 replace-text 相同 | 向指定文本块末尾原样追加 `text`；仅当原消息没有文本块且 textIndex 为 0 时新建文本块 |

深度基于解析器收到的 `input.history`，包括工具消息，以消息对象而非用户/助手轮次计数。所有操作使用同一份原始深度坐标，前面的插入不会改变后面操作的目标。多个操作按返回顺序处理；同一边界的插入保持顺序。插入复用预设深度排序，order 固定为 100，与其他同 order 的深度条目按顺序表稳定排序。`textIndex` 对应原消息中的文本块序号；替换为空串不会删除消息或其他内容块。

工具结果消息不能修改；助手工具调用消息可修改其中的普通文本，但工具调用块、图片、附件、角色、来源、ID 均保留。落在工具调用与结果之间的插入会移到该调用之前，并在预览警告中说明。历史为空时仍可插入。将 assistant 插入到最终尾部时，沿用插件现有的预填充判断。

解析器返回 `{ patches: HistoryPatchV1[] }` 或对应 Promise，最多 256 项、合计 200,000 个 JavaScript 字符单元。整批先校验，任一项无效则按现有 failurePolicy 停止发送或跳过整批；不会部分应用，也不会移除 chatHistory 或误用历史快照。空数组表示不修改。普通动态文本模板仍只接受字符串。类型 `HistoryPatchV1`、`HistoryPatchResultV1`、`DynamicTemplateResultV1` 从公开 `templates` 子路径导入。

修改只发生在请求副本，不写入会话存档或分享文件。所有解析器和宏的“最近消息”输入仍取原历史；其他模板不会读到本轮 patch 的半成品。操作文本为字面量，不执行其中的宏。之后仍会应用用户启用的提示词正则和适配器转换；请求副本中的历史消息保留原 ID 与正则深度，新增消息作为插件注入处理。

工作台主动预览与发送共用准备及编译流程，实际请求与 Raw 来自同一出站快照；折叠历史不影响修改或发送内容。工具续轮重新解析当时的原历史，传输重试复用已准备结果。回调结果不跨请求缓存，操作内容计入编译缓存键。提供者缺失或卸载时不会继续使用上次的 patch。
