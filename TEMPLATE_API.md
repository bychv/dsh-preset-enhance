# 外部提示词模板 API

当前完成：模板注册目录、工作台选用、固定版本保存与请求注入。外部插件可注册、更新、读取和订阅静态提示词模板，并随作用域卸载自动清理。

**注册不会自动注入提示词。** 用户须在编辑器中选用、保存并启用预设。渲染模板、提示词序列处理器和脚本接口仍是设计方案，当前不能调用。

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
| `register(ownerContext, definition)` | 原子登记一个提供者，返回 `update`、`dispose` 句柄；重复活跃 providerId 报错 |
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
| `content` | 静态文本，可为空，最多 200,000 字符；注册时不展开宏、不执行回调 |
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

编辑器通过 POST /preset-enhance/api 的 template-select 动作转换草稿，参数为 preset、presetId、selection。selection 包含 operation（add/update/detach）、identifier（更新/解除时）、providerId/templateId/templateVersion、expectedFingerprint（添加/更新时）和 characterId。返回 preset、identifier、changed；该动作不写盘，之后复用已有带 revision 的保存动作。GET 目录端点仍然只读。
