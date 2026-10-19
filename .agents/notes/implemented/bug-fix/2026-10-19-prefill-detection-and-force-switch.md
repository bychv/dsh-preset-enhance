# 预填充识别与强制启用兜底

Status: implemented

## 现象

预设末尾追加了空标记性质的条目时，工作台判定"不是预填充预设"，即使最后一条**有实际内容**的条目是 assistant 消息。

## 根因：两套识别不一致

- 编译器按**编译后消息的末尾**判定（`src/lib/preset.mts` 的 `assistantPrefix`）：空条目不会产生消息，所以末条仍是 assistant。
- 工作台的 `prefill-inspect`（`src/index.mts`）按**顺序表最后一条条目**判定：它取的是 `order.at(-1)` 对应的提示词角色，末尾只要有条目（哪怕它不产生任何消息），就会覆盖真正的内容条目。

于是同一预设出现"编译器认为有预填充、工作台认为没有"的分歧。

## 修复一：共享判定

新增 `lastContentRole(preset, characterId, markers)`（`src/lib/preset.mts`），`prefill-inspect` 改为调用它。语义要点：

- 从顺序表末尾向前找**第一条真正会产生消息的条目**，由它决定角色。
- 酒馆标记是**有内容**的条目，不是空条目：`chatHistory` 代表对话本身，命中它即表示最终消息属于对话、不属于预设。
- 只有编译器确实不会产出消息的条目才跳过：没有提供文本的标记、空白内容、`injection_position: 1` 的深度注入、触发器不匹配的条目。

因此"末尾空标记掩盖 assistant 预填充"与"末尾真正有内容的 system 条目"被正确区分。

## 修复二：强制启用预填充（兜底）

新增全局开关 `forcePrefill`（工作台「Assistant 预填充接口」→「强制启用预填充（识别不到时兜底）」）：

- 编译期：取预设中**最后一条 assistant 条目**（`source.plugin === 'dsh-preset-enhance'`、**排除标记注入的 assistant 文本**、排除对话历史、排除空文本）并移到末尾作为续写前缀，同时写入一条警告。
- 门控：`forcePrefill` 让请求按预填充处理，并**隐含** `deepseekBetaPrefix`，一个开关即可走兼容路径。
- 预设中没有 assistant 条目时不做改动，请求仍按普通请求发出。

## 修复三：动态预填充条目（注入的例外）

新增约定标识 `dshDynamicPrefill`（`src/lib/preset.mts` 导出 `DYNAMIC_PREFILL_ID`）。它是**唯一不就地注入**的条目：

- 编译时在它所在的顺序位置跳过注入，改为在最后追加一条 assistant 消息；
- 内容先经宏渲染，所以可以按请求变化（`markers.dshDynamicPrefill`、变量、动态模板都能改变每轮前缀），这是"变化预填充内容"的落点；
- 它排在顶层 `assistant_prefill` 与顺序表其它条目之后，因此有内容时就是末条；
- 内容为空时不产生任何消息，识别回落到常规规则。

`lastContentRole` 同步把它视为 assistant：只要它启用且有文本就返回 `assistant`，因此工作台识别与实际请求保持一致。

注意：它属于"标记注入的 assistant 文本"的**例外**——强制启用预填充时原本会排除标记注入的 assistant，但动态预填充是编译器自己追加的末条，不在排除之列。

## 验证

- 识别一致性：空标记 / 空白条目 / 深度注入 / 真正有内容的 system 条目 / `chatHistory` 收尾 / 无 `chatHistory` / 标记带文本 七种形态，`lastContentRole` 与 `compilePreset().assistantPrefix.active` 全部一致。
- 强制行为：顺序表以 system 收尾时，强制后消息序列由 `[system, user, assistant, system]` 变为 `[system, user, system, assistant]` 且 `active=true`；标记注入的 assistant 文本不被采用；无 assistant 条目时保持 `active=false`；预填充已在末尾时不变。
- 状态：非法值归一为 `false`，可独立于兼容开关持久化。
- 动态预填充：位于顺序表中段时只出现在末尾（消息角色 `[system, user, system, assistant]`）；`markers` 取值 `动态A`/`动态B` 分别成为末条文本；与顺序表 assistant 条目并存时动态条目胜出；内容为空时回落到常规识别（`active=false`）。
- 全量 **587/587** 通过，`tsc` 与构建干净。

## 遗留

- 强制模式移动条目会改变该条目原本在顺序表中的位置；若某预设把 assistant 条目当中段少样本示例使用，开启该开关后语义会变化——这正是"兜底"的取舍。
- 开关不随预设分享文件导出（属于全局接口配置，与 `deepseekBetaPrefix` 一致）。

## 相关资料

- [编译器与识别](../../../../src/lib/preset.mts)
- [接口门控与 prefill-inspect](../../../../src/index.mts)
- [工作台开关](../../../../web/editor.js)
- [使用指南](../../../../docs/guides/WORKBENCH.md)
- [测试](../../../../tests/core.test.mjs)
