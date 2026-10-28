# 正文正则与独立显示包

正文正则由可选的 `dsh-preset-display-regex` 执行。主包负责编辑、保存、导入导出和有效配置；显示包只读取配置和宿主 ChatSnapshot，不改写会话数据。从 0.3.6-alpha.1 起，两包同版本发布，主包精确依赖正文包。

## 配置

```json
{
  "extensions": {
    "regex_scripts": [
      {
        "id": "example",
        "scriptName": "虚构替换",
        "findRegex": "/hello/g",
        "replaceString": "你好",
        "placement": [2],
        "markdownOnly": true,
        "promptOnly": false,
        "disabled": false
      }
    ],
    "dsh-preset-enhance": {
      "displayRegex": { "enabled": true }
    }
  }
}
```

工作台「正则配置」面板与 SPreset 附加功能均可编辑这份规则及两套总开关，保存路径一致。显示开关默认关闭，与提示词正则、预设注入分别控制。正文包未安装、停用、加载失败或状态尚未确认时，两处编辑器的正文总开关显示关闭且不可操作；仍可编辑、保存规则。分包恢复就绪后使用预设中保存的开关偏好，临时停用不会被自动保存成预设修改。DSH 插件页启停和热重载会实时同步，无需刷新。按当前会话绑定选择预设，无绑定时使用全局当前预设。规则取自 `extensions.regex_scripts`，按数组顺序执行；SPreset 的 `RegexBinding` 保留为兼容字段，不另行合并执行。

| 字段 | 显示行为 |
| --- | --- |
| `markdownOnly: true`、`placement` 包含 `2` | 替换助手正文的显示副本 |
| `promptOnly: true` | 另由主包处理请求中的提示词副本 |
| 两个通道均开启 | 各自从对应原文计算，互不重复使用结果 |
| `disabled` | 停用当前规则 |
| `minDepth` / `maxDepth` | 最新聊天楼层为 0；空或 -1 不限。无法确定历史深度时跳过有深度限制的规则 |
| `trimStrings`、`substituteRegex` | 沿用提示词正则的捕获组、匹配内容清理和查找式宏展开 |

显示任务的 local/global 宏变量均为副本，重绘不提交变量变更。随机宏以消息身份和配置修订为种子，同一来源与修订下保持稳定。

## 渲染与边界

运行时定位每个会话视图中的助手 text block，从公开 ChatSnapshot 读取原始 Markdown。相邻 text block 按换行连接；思考、图片、工具调用和其他块隔开匹配范围。新回复、历史回复和流式回复使用同一流程，流式更新约每 120ms 合并一次。

替换结果仍按 Markdown 展示，HTML 作为字面文本显示，不运行脚本。含 `dsh-ui` / `svg` 的正文同样执行正则，再由宿主 Markdown 生成围栏供 GenUI 接管；不因发现组件自动回退，也不将新生成的组件围栏强制转为纯文本。显示容器提供流式状态并在更新时复用 React 根，显示包不自行解析或执行 GenUI 组件。已在 DSH 0.2.1-alpha.2 与 GenUI 0.11.1 共装验证普通正文、混合代码/组件/SVG、开关、卸载及历史刷新。GenUI 本身的版本声明尚未覆盖该宿主，验证使用了临时精确版本豁免，不代表其全部功能已适配。更改代码块数量、顺序或围栏语言可能影响 GenUI 按原始快照取语言的逻辑，此类规则尚未保证兼容。其他插件自定义的正文渲染器不保证兼容：结构无法准确对应时保留宿主显示。

显示容器保留原正文节点的样式类与所在层级，使按 Markdown 外层设置气泡的皮肤继续生效，不固定背景颜色。已在 DSH 0.2.1-alpha.2 与 `@smalltailqwq/dsh-client-ui-skin-maid-atelier` 0.1.7 验证明暗主题及关闭后恢复；不代表所有第三方皮肤结构均已验证。

正则在可终止的 Worker 执行。单任务限制 200 条规则、512KiB 输入、2MiB 规则配置与输出、20,000 次替换；超时（1.5 秒）或错误时保留原文。同一会话消息的待处理任务仅保留最新版，队列最多 64 个。仅处理可见区域及邻近消息；关闭、会话切换、配置失效或插件卸载时恢复宿主正文并释放订阅。

会话历史、后续模型上下文、宿主复制与导出继续使用原始内容；本功能不修改这些路径。独立 Markdown 根也不继承宿主私有的文件跳转和图片解析上下文，复杂本地文件展示应留给宿主。本包自身不提供 HTML 或组件渲染运行时；GenUI 组件行为由另装的 GenUI 负责。切换显示开关会在原文与显示副本间切换组件挂载位置，不承诺保留第三方组件的临时输入状态。

## 浏览器配置接口

以下接口复用 DSH Web 登录，不是内部 agent 的预设只读授权接口，也不新增外部匿名访问。

- `GET /preset-enhance/api/display?sessionId=...`：读取当前显示配置。
- `GET /preset-enhance/api/display-events?sessionId=...`：SSE，在保存成功且有效配置变化后发送同结构快照，15 秒心跳。

快照字段为 `apiVersion: 1`、`instance`（宿主启动实例）、`revision`（有效配置哈希）、`sessionId`、`presetId`、`enabled`（有效开关）、`configuredEnabled`（预设偏好）、`available`（能力就绪）、`scripts`、`local`、`global`、`values`、`depths`。不包含预设提示词正文或聊天历史全文。无效会话返回 400，服务不可用返回 503。消费者必须在断线、不可用或结构无法对应时恢复原文；修订用于去重，不是可排序的版本号。

### 显示能力生命周期

- `GET /preset-enhance/api/display-status`：无需会话的正文包就绪状态。
- `GET /preset-enhance/api/display-status-events`：同状态 SSE，监听启停与实例替换。

状态为 `{ apiVersion: 1, available: boolean, instance: string | null }`。内置编辑器复用现有 `template-events` 的 `display` 字段接收该状态，与模板刷新共享一条连接；独立状态 SSE 留给其他消费者。页面隐藏释放订阅，返回时重新连接；包括宿主切换页面后仍缓存的 iframe，由宿主活动通知控制，不能只依赖 pagehide。接口复用宿主 Web 登录，断线或未知版本按不可用处理。客户端不通过此接口修改插件启停，启停仍由 DSH 插件管理器负责。

两个包通过公开 `./display-api` 导出 `PRESET_DISPLAY_SERVICE`、`PRESET_DISPLAY_EVENT` 和类型。显示包在资源校验完成后提供 `presetDisplayRegex`，就绪或退出时发出 `preset-display/availability`；主包用当前实例的 `ready` 判定有效能力，避免仅凭安装记录显示开启。该能力不包含规则内容或用户数据。

## 工作台试运行

工作台现有 `POST /preset-enhance/api` 的 `regex-test` 操作支持 `channel: "prompt" | "display"`，省略时保持提示词行为。正文通道固定使用助手目标，复用显示计划、表达式与宏规则，在服务端可终止 Worker 中执行；总开关只作为结果中的 enabled/notes 提示，不阻止手工测试。不会保存试运行的正文和宏变量。界面切换通道后丢弃旧通道的迟到结果。

## 安装与升级

安装入口继续使用 `dsh-preset-enhance`。主包通过精确版本的运行依赖携带正文包，并由自己的 Cordis patch 注册 `preset-enhance` 与 `preset-display-regex` 两个条目。DSH 同一插件详情页列出这两个条目，可分别启停；无需改装 `dsh-preset-enhance-bundle`。

旧用户按原通道升级主包并重启宿主即可。包名、主条目 ID、数据路径和预设格式均不变，保留已导入预设、当前选择、会话绑定和配置；新增的正文替换偏好默认关闭。主条目的用户配置及停用 patch 继续按原 ID 生效。当前源码支持 DSH `0.2.1` 和 `0.2.2`，新增范围及验证基线见[兼容记录](../compatibility/DSH_0.2.2_COMPATIBILITY.md)；旧版宿主继续使用对应兼容的旧插件版本，不把新增显示包声明为已适配旧宿主。

`packages/bundle` 保留为开发期组合入口，仍直接装配同样两个条目，不再推荐给原主包用户。DSH 不递归执行依赖包的 bundle patch，因此主包被组合入口引用时不会重复加载正文包。不要在同一 profile 同时选择主包、组合包、正文包三个入口；开发期曾单独安装正文包的 profile 应取消该独立入口，只保留主包。此项不会自动改写用户的 profile。

本地先执行 `npm run build`。子包尚未发布时，用本地 tarball 或构建快照满足主包依赖后在隔离 profile 验证，不能直接从 npm 获取未发布的子包。安装开发依赖时可使用 `npm install --no-save --package-lock=false ./packages/display-regex`，不把本地路径写入发布 manifest。发布时同步三包版本及精确依赖，先发布正文包，确认可下载后再发布主包，最后按需发布兼容组合入口；否则旧用户升级时会遇到缺失依赖。
