# 正文正则与独立显示包

正文正则由可选的 `dsh-preset-display-regex` 执行。主包负责编辑、保存、导入导出和有效配置；显示包只读取配置和宿主 ChatSnapshot，不改写会话数据。两包同版本构建，目前尚未发布新的 npm 包。

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

显示开关默认关闭，与提示词正则、预设注入分别控制。按当前会话绑定选择预设，无绑定时使用全局当前预设。规则取自 `extensions.regex_scripts`，按数组顺序执行；SPreset 的 `RegexBinding` 保留为兼容字段，不另行合并执行。

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

正则在可终止的 Worker 执行。单任务限制 200 条规则、512KiB 输入、2MiB 规则配置与输出、20,000 次替换；超时（1.5 秒）或错误时保留原文。同一会话消息的待处理任务仅保留最新版，队列最多 64 个。仅处理可见区域及邻近消息；关闭、会话切换、配置失效或插件卸载时恢复宿主正文并释放订阅。

会话历史、后续模型上下文、宿主复制与导出继续使用原始内容；本功能不修改这些路径。独立 Markdown 根也不继承宿主私有的文件跳转和图片解析上下文，复杂本地文件展示应留给宿主。本包自身不提供 HTML 或组件渲染运行时；GenUI 组件行为由另装的 GenUI 负责。切换显示开关会在原文与显示副本间切换组件挂载位置，不承诺保留第三方组件的临时输入状态。

## 浏览器配置接口

以下接口复用 DSH Web 登录，不是内部 agent 的预设只读授权接口，也不新增外部匿名访问。

- `GET /preset-enhance/api/display?sessionId=...`：读取当前显示配置。
- `GET /preset-enhance/api/display-events?sessionId=...`：SSE，在保存成功且有效配置变化后发送同结构快照，15 秒心跳。

快照字段为 `apiVersion: 1`、`instance`（宿主启动实例）、`revision`（有效配置哈希）、`sessionId`、`presetId`、`enabled`、`scripts`、`local`、`global`、`values`、`depths`。不包含预设提示词正文或聊天历史全文。无效会话返回 400，服务不可用返回 503。消费者必须在断线、不可用或结构无法对应时恢复原文；修订用于去重，不是可排序的版本号。

## 本地构建安装

在仓库根目录执行 `npm run build`，然后将主包目录和 `packages/display-regex` 目录分别安装到同一 DSH profile。只安装主包可编辑和保存正文规则，但不会执行显示替换。

`packages/bundle` 参考官方组合插件的 patch/dependencies 方式，同时启用两包。它的依赖版本须在正式发布时一起更新，当前新子包未发布，不能直接从 npm 安装这个开发版组合包。
