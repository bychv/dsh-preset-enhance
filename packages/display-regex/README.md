# DSH 预设正文正则

`dsh-preset-display-regex` 是预设主包的可选显示插件。安装后，在工作台「正则配置」开启“启用正文正则”，为规则选中“正文显示”和“助手正文”。也可通过 SPreset Editor → 附加功能 → 正则编辑，同一份配置通用。

支持历史及流式助手正文的正则替换，HTML 始终作为文本，不执行脚本。可与另装 GenUI 共用 Markdown 围栏，发现组件时不会自动回退。关闭后恢复原文；不修改历史、请求上下文及宿主导出。需要同版本、提供 display API v1 的 `dsh-preset-enhance`，仅面向 DSH 0.2.1 系列。

本地开发先在仓库根目录运行 `npm run build`，用本地构建快照满足主包对子包的依赖，再安装主包入口。正式安装使用 `dsh-preset-enhance@next`，由主包自动安装本包。

配置、接口及 GenUI/文件展示边界见仓库的 [正文正则说明](https://github.com/bychv/dsh-preset-enhance/blob/main/docs/api/DISPLAY_REGEX.md)。

## 源码与插件管理

宿主入口位于 `src/index.mts`，客户端、渲染与执行器位于 `src/client/`，共享 Worker 在主包 `src/client/worker/regex-worker.ts`。仓库根目录 `npm run build` 生成本包运行文件，原浏览器 URL 不变。

主包 `dsh-preset-enhance` 自动携带此包，在同一 DSH 插件详情页逐项控制两个包，无需另装组合入口。此包停用、加载失败或未就绪时，工作台与 SPreset 的正文总开关关闭且不可操作；规则与保存的偏好保留，恢复启用后重新使用该偏好。提示词正则独立生效。
