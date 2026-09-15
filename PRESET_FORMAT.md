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
| `tools` | 可选的工具配置容器，当前只保存、转发，不执行。 |
| `extensions` | 可选的扩展对象，建议使用插件名作为键，避免重名。 |

`format`、`version`、`preset` 必填。文件大小限制与原 JSON 导入相同，为 8 MB。自定义提示词的换行按 JSON 规则写为 `\n`；宏保留源文本，在实际请求时展开。

## 预填充配置

`prefill` 非空时，下列字段全部必填：

- `enabled`：是否启用预填充自动兼容。
- `toolCalls`：是否启用 DSML 工具调用转换。
- `removeNonOfficialTools`：关闭 DSML 处理时，非官方接口是否移除原生工具字段。官方 Beta 的原有规则不变。
- `postToolPrefix.mode`：`inherit` 继承原预设，`custom` 使用工具执行后的独立提示词。
- `postToolPrefix.text`：自定义提示词文本；留空或宏展开为空时继承原预设。

接口地址、API key、用户身份、会话 ID、会话历史、运行中的变量值和本机路径不属于预填充配置。新建分享文件只从全局状态中提取上述接口设置，不打包整个本地数据库。

## 工具预设与分组预留结构

当前版本只验证 `tools` 为对象、`presets` 和 `groups` 为数组，其内容原样保留。导入、切换预设、应用包内接口设置均不改变本机工具开关。

预留结构约定如下，供后续实现使用：

```json
{
  "version": 1,
  "activePresetId": null,
  "presets": [
    {
      "id": "tool-profile-1",
      "name": "",
      "groupIds": ["tool-group-1"],
      "rules": [
        { "modeId": "plugin-mode-id", "toolName": "plugin-tool-name", "enabled": false }
      ]
    }
  ],
  "groups": [
    {
      "id": "tool-group-1",
      "name": "",
      "members": [
        { "modeId": "plugin-mode-id", "toolName": "plugin-tool-name" }
      ]
    }
  ]
}
```

- `tools.version` 为工具子格式版本，与外层格式独立；当前未实现工具子格式解释器，未知子版本也只透传。
- ID 为包内稳定字符串；`activePresetId` 引用 `presets[].id`，`groupIds` 引用 `groups[].id`。
- 工具引用使用 `{modeId, toolName}`，在接收端按实时模式/工具目录解析，不写死内置模式、插件工具或本机安装路径。
- 工具分组用于组织工具；工具启用策略由 `rules` 表达，缺省规则预留为继承接收端策略。
- 不存在的模式和工具也保留引用，当前不会触发安装或启用。未来的执行器需要明确处理引用缺失、冲突和应用范围。

工具分组编辑器、工具策略导入应用和冲突处理将在后续实现；此处约定数据存放位置和引用方式。

## 工作台导入、编辑与导出

1. “导入 JSON”自动识别 ST JSON 和本格式。导入分享文件后，将原预设保存为当前默认，并保存附带配置。附带接口配置不会自动覆盖全局设置。
2. “应用包内接口设置（全局）”显式应用文件中的 `prefill`，下一次请求生效；工具预设和分组暂不执行。
3. “保存接口设置”保存全局接口设置，同时将其附加到当前选中的已保存预设。包内未来扩展字段保留。
4. “导出分享文件”导出一个 `.dsh-preset.json`：提示词和名称使用当前编辑器草稿；接口配置优先使用该预设已附带的配置，没有分享数据时使用全局已保存配置。尚未保存的接口表单内容不会被导出。
5. “导出 ST JSON”只导出 `preset.data`，用于其他 ST 兼容软件。

导入的未知字段会在相同主版本的读写中保留，包括顶层、`preset` 包装层、`prefill`、工具容器和扩展对象。编辑名称或提示词只替换对应字段；保存接口设置只替换已知接口配置字段。保留的外来扩展数据也会随分享文件再次导出。

## 版本演进

同一主版本只添加可选字段，旧版本客户端保留其不识别的数据。改变必填字段、字段含义或已有行为时提升外层 `version`；工具子格式独立演进。未知外层主版本必须报错，不按 ST JSON 降级解析，以免丢失配置。
