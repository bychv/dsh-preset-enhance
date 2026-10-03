# 工具预设与分组实施方案

本文供后续实现 agent 直接执行。当前工具目录来自 DSH 模式注册表，模式默认和会话覆盖最终都是 `{[toolName]: boolean}`，请求过滤与执行守卫共用该结果。

## 目标与约束

1. 任意内置或第三方模式的工具都可分组，一次全开、全关或仅启用某组。
2. 最终开关可保存为工具预设，由模式或会话引用；同一会话动态切换，下一次请求生效。
3. 分组只负责组织和批量编辑。组操作展开为逐工具规则，运行时继续使用扁平策略，避免多组优先级冲突。
4. 同一 `{modeId, toolName}` 最多属于一个用户组；“全部”和“未分组”是界面计算的虚拟组。
5. 缺失模式或工具的引用必须保留，安装对应插件后自动重新匹配。
6. 分享包导入后不自动应用工具配置，必须由用户显式操作。

## 数据模型

`lib/store.mjs` 新增：

```js
toolGroups: [{
  id: "uuid", name: "读取类", description: "", order: 100,
  members: [{ modeId: "standard", toolName: "read_file" }]
}],
toolPresets: [{
  id: "uuid", name: "只读", description: "", defaultEnabled: true,
  groupIds: ["group-uuid"],
  rules: [{ modeId: "standard", toolName: "shell", enabled: false }],
  updatedAt: "ISO-8601"
}],
modeToolSelections: {
  standard: { kind: "preset", presetId: "uuid" }
},
sessionToolSelections: {
  "session-id": { kind: "preset", presetId: "uuid" }
}
```

selection 只允许：

```js
{ kind: "inherit" }                  // 仅会话可用
{ kind: "custom" }                   // 使用现有扁平 policy
{ kind: "preset", presetId: "uuid" }
```

保留 `modeToolPolicies` 和 `sessionToolPolicies`。升级时不迁移旧数据：没有 mode selection 视为 `custom`，没有 session selection 视为 `inherit`。直接保存逐工具开关时切到 `custom`；选择预设时只写 selection，不复制规则。

组和预设各最多 100 个，单组最多 2,000 个成员，单预设最多 5,000 条规则。成员和规则以 `{modeId,toolName}` 唯一，重复项报错。用户组 ID 禁止以 `@` 开头。删除组只删成员关系，不删工具规则。删除被引用的预设时，模式回到 `custom`，会话回到 `inherit`；保留旧扁平 policy，避免权限突然扩大。

## 有效策略

把 `effectiveToolPolicy` 扩为 `(snapshot, sessionId, modeId, catalog)`：

1. 模式选择 `preset` 时展开该预设当前模式的规则；`custom` 或缺省读取 `modeToolPolicies[modeId]`。
2. 会话缺省/`inherit` 使用模式结果；`preset` 展开会话预设；`custom` 使用 `sessionToolPolicies[sessionId]`。
3. 展开预设时，每个目录工具先取 `defaultEnabled`（缺省 `true`），再应用同 `{modeId,toolName}` 的显式规则。
4. 目录中不存在的规则不进入有效策略，但保留并在工作台列为“未匹配”。
5. 会话选择是完整替换，不与模式策略叠加，保持现有覆盖语义。
6. `filterTools` 与 `ctx.tools.guard` 必须调用同一解析函数。

修改预设或 selection 后，在同一 transaction 增加 `revision` 并调用 `refreshPolicies(state)`。当前请求保留进入时的快照，下一请求读取新设置。

## 分组批量操作

每组显示成员数和三态复选框：全启用为选中、全停用为未选中、混合状态设置 `indeterminate=true`。组操作只处理当前模式目录中已匹配的成员：

- 点击组开关：整组全开或全关。
- “仅启用此组”：关闭当前模式全部工具，再启用该组。
- “恢复预设值”：编辑自定义策略时，将组成员恢复到工具预设或模式继承值。
- 顶部全选/全不选继续处理当前模式全部工具，不受标签筛选影响。

批量操作先修改浏览器草稿并显示“尚未保存”；点击现有“保存工具开关”后原子保存。切换模式、范围、预设或离开页面时，对未保存草稿沿用现有放弃确认。

## 工具预设界面

```text
范围 [模式默认/当前会话]  模式 [...]  工具预设 [继承/自定义/预设名]
[新建] [复制] [重命名] [删除]
```

- 模式范围不提供“继承”；会话范围提供“继承模式默认”。
- 新建预设从当前有效策略生成，默认 `defaultEnabled:true`，只保存关闭项。
- 复制生成新 UUID，复制规则和组顺序，不修改 selection。
- 修改工具预设后，引用它的模式和会话从下一请求更新。
- 显示“被 N 个模式、M 个会话引用”；删除确认需说明回退结果。

## 标签页和折叠

1. 保留外层 `<details class="config-card">`，用于折叠整个工具区域。
2. 组导航使用 `role="tablist"`，固定包含“全部”和“未分组”，用户组按 `order`、名称排序；标签显示 `名称 · 已启用/总数`。
3. 标签栏提供“收起标签栏”。收起后换成紧凑 `<select>`，当前组不变；小于 760px 自动使用 select。
4. 当前标签内容放入 `<details class="tool-group-content" open>`；summary 放三态开关、统计和批量操作，工具列表可单独折叠。
5. 分组管理作为工具卡片的“管理分组”二级页，支持新增、重命名、排序、删除和分配工具。拖放只能是快捷方式，必须同时提供复选框操作。
6. tab 支持方向键、Home/End、Enter/Space，并设置 `aria-selected`、`aria-controls`；折叠按钮设置动态 `aria-expanded`。

折叠状态只进 `localStorage`，不进入分享文件：

```text
dsh-preset-enhance.tool-tabs-collapsed
dsh-preset-enhance.tool-group-content-open
dsh-preset-enhance.tool-active-group:<modeId>
```

虚拟组 ID 使用 `@all`、`@ungrouped`。

## API

沿用 `/preset-enhance/api` 和 revision 乐观锁：

| action | 行为 |
| --- | --- |
| `save-tool-groups` | 整体校验并保存分组；本地新增引用须来自已知目录，原有失配引用允许保留。 |
| `save-tool-preset` | 新建或更新预设；未知引用允许保存并返回 warnings。 |
| `delete-tool-preset` | 删除预设并回退所有 selection。 |
| `select-tool-policy` | 按 scope 原子切换 inherit/custom/preset。 |
| `save-mode-tools` | 保留；成功后写 mode `{kind:"custom"}`。 |
| `save-session-tools` | 保留；普通保存写 `{kind:"custom"}`，`inherit:true` 清除 selection 和会话 policy。 |
| `import-package-tools` | 显式导入包内组和预设，不自动应用。 |

GET 新增 `toolGroups`、`toolPresets`、`modeToolSelections`、当前会话的 `sessionToolSelection`、预设引用计数和 `unresolvedToolRefs`，不要返回其他会话的 selection。

所有写入须先完整校验，再进入 transaction，不能循环中部分写入后抛错。对象键继续用现有 `assign`，防止特殊键影响原型。保存预设规则时另建只校验语法的函数，不能复用当前会拒绝失配工具的 `validateToolPolicy`。

## 单文件分享

沿用外层 `version:1` 和工具子格式 `tools.version:1`：

```json
{
  "tools": {
    "version": 1,
    "activePresetId": "tool-profile-1",
    "presets": [{
      "id": "tool-profile-1", "name": "只读", "description": "",
      "defaultEnabled": true, "groupIds": ["tool-group-1"],
      "rules": [{
        "modeId": "plugin-mode-id", "toolName": "plugin-tool-name", "enabled": false
      }]
    }],
    "groups": [{
      "id": "tool-group-1", "name": "读取类", "description": "", "order": 100,
      "members": [{ "modeId": "plugin-mode-id", "toolName": "plugin-tool-name" }]
    }]
  }
}
```

- 默认只导出当前关联的工具预设及其 `groupIds` 所引用的组。
- `activePresetId` 只是作者推荐项，不表示导入时自动启用。
- 不导出 selection、会话 ID、目录缓存、折叠状态或引用计数；失配引用照常导出。
- 显式导入前显示新增组/预设数量、匹配数和失配数。ID 同且内容相同则复用；ID 冲突且内容不同则生成 UUID，并重写包内引用。
- 未知 `tools.version` 继续保留和导出，但禁止应用。

`lib/preset-package.mjs` 新增 `validateToolsPackage`，校验数量、唯一性和引用完整性，同时保留同版本未知字段。

## 实施顺序

1. 新建 `lib/tool-presets.mjs`：校验、引用键、预设展开、引用计数、导入冲突重映射。
2. `lib/store.mjs`：新增字段与旧状态归一化。
3. `index.mjs`：snapshot、有效策略、GET 和 action，确保过滤器与守卫一致。
4. `lib/preset-package.mjs`：工具子格式导入导出。
5. `web/index.html`、`web/editor.js`、`web/editor.css`：独立草稿模型、三态组、折叠标签和管理页。
6. 先完成纯逻辑和 API 测试，再接 UI。

## 验收清单

1. 旧状态的模式和会话策略行为不变。
2. 不同模式同名工具按 `{modeId,toolName}` 区分。
3. `defaultEnabled`、显式规则和目录新增工具正确合并。
4. 请求 schema 与执行守卫同步关闭工具。
5. 会话连续切换继承、自定义和两个预设，下一请求生效。
6. 修改被多处引用的预设后，所有引用同步更新。
7. 组三态、全开、全关、仅启用此组正确。
8. 缺失插件引用保留，插件恢复后重新匹配。
9. 删除组不改变规则；删除预设按约定回退。
10. 包导入不自动改策略；ID 冲突正确重映射。
11. 单文件往返保留未知字段、工具组和失配引用。
12. 标签栏/内容折叠、移动端 select 和键盘操作可用。
13. 两窗口 revision 冲突不会覆盖先保存数据。
14. 数量上限、重复项、悬空 `groupIds` 和非法特殊键被拒绝。

完成时运行 `npm test`、`npm run check`、`npm pack --dry-run`，确认包不含 `sample/`；候选沙盒至少验证一个内置模式、一个插件模式、会话动态切换和折叠状态。
