# 单文件预设分享格式 v1

文件名建议为 `名称.dsh-preset.json`，编码为 UTF-8。它是一份普通 JSON，包含所有预设和配置，无需 ZIP、目录或其他配套文件。插件仍可导入、导出普通 SillyTavern JSON。

## 文件结构

以下为空白结构示意，`preset.data` 内存放完整的 SillyTavern 预设：

```json
{
  "format": "dsh-preset-enhance",
  "version": 1,
  "metadata": {
    "name": "",
    "description": "",
    "author": ""
  },
  "preset": {
    "format": "sillytavern",
    "data": {
      "dsh_system_prompt_enabled": true,
      "prompts": [
        { "identifier": "chatHistory", "marker": true, "role": "user" }
      ],
      "prompt_order": [
        { "character_id": 100001, "order": [
          { "identifier": "chatHistory", "enabled": true }
        ] }
      ],
      "assistant_prefill": ""
    }
  },
  "prefill": {
    "enabled": true,
    "toolCalls": true,
    "extractOutput": false,
    "removeNonOfficialTools": true,
    "postToolPrefix": {
      "mode": "inherit",
      "text": ""
    }
  },
  "tools": {
    "version": 1,
    "activePresetId": null,
    "presets": [],
    "groups": []
  },
  "extensions": {}
}
```

| 字段 | 含义 |
| --- | --- |
| `format` | 固定为 `dsh-preset-enhance`，标识外层分享格式。 |
| `version` | 格式主版本，当前为整数 `1`，独立于 npm 插件版本。未知版本拒绝导入。 |
| `metadata` | 可选的名称、说明、作者等分享信息；名称可在工作台编辑。 |
| `preset.format` | 当前固定为 `sillytavern`。 |
| `preset.data` | 完整 ST JSON，保留顺序表、宏、预填充及原有 `extensions` 等字段。 |
| `prefill` | 可选的接口配置对象，省略或 `null` 表示不附带接口设置。 |
| `tools` | 可选的工具预设与分组容器；导入不自动应用，需在工作台显式导入，详见下文。 |
| `extensions` | 可选的扩展对象，建议使用插件名作为键，避免重名。 |

`format`、`version`、`preset` 必填。文件大小限制与原 JSON 导入相同，为 8 MB。自定义提示词的换行按 JSON 规则写为 `\n`；宏保留源文本，在实际请求时展开。

`preset.data.dsh_system_prompt_enabled` 是可选布尔值，省略时按 `true` 处理。它对应工作台置顶的只读“DSH 系统提示词”模板：在其他 DSH 模式中启用该预设时，`true` 保留模式原有系统提示与运行时注入，`false` 将其移除。专用“预设模式”始终移除这些内容。

## 预填充配置

`prefill` 非空时，原有字段保持必填；`extractOutput` 是同一主版本新增的可选字段，省略时按 `false` 处理：

- `enabled`：是否启用预填充自动兼容。
- `toolCalls`：是否启用 DSML 工具调用转换。
- `extractOutput`：是否启用实验性正文/工具调用提取；按照最终稳定性策略把切换前文本映射到思维链，并移除输出区控制标签。
- `removeNonOfficialTools`：关闭 DSML 处理时，非官方接口是否移除原生工具字段。官方 Beta 的原有规则不变。
- `postToolPrefix.mode`：`inherit` 继承原预设，`custom` 使用工具执行后的独立提示词。
- `postToolPrefix.text`：自定义提示词文本；留空或宏展开为空时继承原预设。

接口地址、API key、用户身份、会话 ID、会话历史、运行中的变量值和本机路径不属于预填充配置。新建分享文件只从全局状态中提取上述接口设置，不打包整个本地数据库。

## 工具预设与分组

`tools` 是可选的工具容器，子格式独立于外层 `version` 演进，当前子版本为 `1`。校验会检查数量、唯一性和引用完整性，同时保留同版本未知字段：

```json
{
  "version": 1,
  "activePresetId": "tool-profile-1",
  "presets": [
    {
      "id": "tool-profile-1",
      "name": "只读",
      "description": "",
      "defaultEnabled": true,
      "groupIds": ["tool-group-1"],
      "rules": [
        { "modeId": "plugin-mode-id", "toolName": "plugin-tool-name", "enabled": false }
      ],
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "groups": [
    {
      "id": "tool-group-1",
      "name": "读取类",
      "description": "",
      "order": 100,
      "members": [
        { "modeId": "plugin-mode-id", "toolName": "plugin-tool-name" }
      ]
    }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `tools.version` | 工具子格式版本，整数，当前为 `1`，省略时按 `1` 处理。未知整数版本只保留和再次导出，禁止应用（见下）；非整数或小于 `1` 是格式错误，拒绝整个包。 |
| `tools.activePresetId` | 可选；引用 `presets[].id`，只是作者的推荐项，导入时不会自动启用任何工具。 |
| `tools.presets[].id` | 包内稳定的预设 ID，不能以 `@` 开头。 |
| `tools.presets[].name` | 预设名称，必填。 |
| `tools.presets[].description` | 可选说明。 |
| `tools.presets[].defaultEnabled` | 目录中未被 `rules` 明确覆盖的工具的缺省开关；省略时为 `true`。 |
| `tools.presets[].groupIds` | 引用 `groups[].id`，用于组织工具和批量编辑；必须指向本包内存在的分组。 |
| `tools.presets[].rules` | 逐工具显式规则 `{modeId, toolName, enabled}`；同一 `{modeId,toolName}` 只能出现一次。 |
| `tools.presets[].updatedAt` | 可选 ISO-8601 时间戳，仅用于展示。 |
| `tools.groups[].id` | 包内稳定的分组 ID，不能以 `@` 开头；`@all` 和 `@ungrouped` 是界面计算的虚拟分组，不写入文件。 |
| `tools.groups[].name` | 分组名称，必填。 |
| `tools.groups[].order` | 排序值，省略时为 `100`，用于标签顺序。 |
| `tools.groups[].description` | 可选说明。 |
| `tools.groups[].members` | `{modeId, toolName}` 数组；组内不得重复，同一引用在包内最多属于一个用户分组。 |

语义约定：

- 工具引用统一使用 `{modeId, toolName}`，接收端按实时模式和工具目录解析，不写死内置模式、插件工具或本机安装路径；不同模式的同名工具互相独立。
- 分组只负责组织和批量编辑，运行时仍展开为逐工具规则：先取 `defaultEnabled`，再应用同 `{modeId,toolName}` 的显式规则。
- 目录中不存在的模式或工具不会导致拒绝：引用照常导入、导出并在工作台列为“未匹配”，安装对应插件后自动重新匹配。
- 上限：分组 100 个、预设 100 个、单组 2,000 个成员、单预设 5,000 条规则；ID 最长 100 字符，`modeId` 和 `toolName` 最长 200 字符。
- 以下情况作为格式错误拒绝整个包：重复的分组或预设 ID、组内重复成员、同一工具同时属于两个用户分组、`groupIds` 指向不存在的分组、`activePresetId` 未指向本包内的预设、`presets`/`groups` 存在但不是数组。
- 同一子版本内的未知字段（`tools` 容器、预设、分组、规则、成员各级）原样保留；编辑名称、提示词或接口设置后再次导出时不会丢失。

### 导出范围

- 默认只导出当前关联的工具预设，以及该预设 `groupIds` 引用的用户分组；不会导出其他预设或分组。
- 未关联任何工具预设时：新预设导出空容器 `{"version":1,"activePresetId":null,"presets":[],"groups":[]}`，已导入的分享文件沿用其原有工具容器（原本没有 `tools` 字段时也不额外添加）。
- 不导出 selection（模式默认和会话选择）、会话 ID、目录缓存、引用计数，以及浏览器本地界面状态（标签/内容折叠、最后配置的 DSH 模式、自动保存工具开关）；未匹配引用照常导出。
- `activePresetId` 只记录作者推荐，导入不会自动启用或切换任何工具开关。

### 显式导入与冲突处理

- 导入分享文件从不自动应用工具配置：包内的组和预设随预设一起保存，模式默认和会话的工具开关保持不变。
- 用户在工作台显式选择“导入包内工具配置”后才应用：先显示新增/复用/重映射数量和匹配/失配数量（预览不写入），确认后原子写入。
- ID 相同且内容一致时复用它在本机已有的分组/预设；ID 相同但内容不同时生成新的 UUID，同时重写包内引用（预设的 `groupIds` 与 `activePresetId` 跟随重映射）。
- 接收端按实时目录解析引用：能匹配的计入匹配数，未匹配的保留并提示，等插件恢复后重新匹配。

### 未知工具子版本

`tools.version` 为未知整数（例如未来插件写出的 `2`）时，包仍可正常导入、编辑和再次导出，内容原样保留；只有应用会被拒绝，并显示“分享文件的工具子版本 N 暂不支持应用”。

## 工作台导入、编辑与导出

1. “导入 JSON”自动识别 ST JSON 和本格式。导入分享文件后，将原预设保存为当前默认，并保存附带配置（包括包内工具预设和分组）。附带接口配置和工具配置都不会自动应用。
2. “应用包内接口设置（全局）”显式应用文件中的 `prefill`，下一次请求生效。
3. “导入包内工具配置”显式应用文件中的 `tools`：先显示新增、复用、重映射数量以及匹配、失配数量，确认后才写入，且不改变任何模式或会话的工具选择。未知 `tools.version` 时禁止应用并给出提示。
4. “保存接口设置”保存全局接口设置，同时将其附加到当前选中的已保存预设。包内未来扩展字段保留。
5. “导出分享文件”导出一个 `.dsh-preset.json`：提示词和名称使用当前编辑器草稿；接口配置优先使用该预设已附带的配置，没有分享数据时使用全局已保存配置；工具容器使用当前关联的工具预设（仅该预设及其 `groupIds` 引用的分组），没有关联时沿用该预设已保存的包内工具容器，新预设则导出空容器（空的 `presets` 和 `groups`）。尚未保存的接口表单内容不会被导出。
6. “导出 ST JSON”只导出 `preset.data`，用于其他 ST 兼容软件。

导入的未知字段会在相同主版本的读写中保留，包括顶层、`preset` 包装层、`prefill`、工具容器（含未知工具子版本）和扩展对象。编辑名称或提示词只替换对应字段；保存接口设置只替换已知接口配置字段。保留的外来扩展数据也会随分享文件再次导出。

## 版本演进

同一主版本只添加可选字段，旧版本客户端保留其不识别的数据。改变必填字段、字段含义或已有行为时提升外层 `version`；工具子格式独立演进。未知外层主版本必须报错，不按 ST JSON 降级解析，以免丢失配置；未知工具子版本仍可导入、编辑、导出和往返，只禁止应用。
