# DSH 预设正文正则

`dsh-preset-display-regex` 是预设主包的可选显示插件。安装后，在 SPreset Editor → 附加功能 → 正则开启“正文正则”，为规则选中“正文显示”和“模型输出”。

支持历史及流式助手正文的正则替换，HTML 始终作为文本，不执行脚本。可与另装 GenUI 共用 Markdown 围栏，发现组件时不会自动回退。关闭后恢复原文；不修改历史、请求上下文及宿主导出。需要从此源码构建、提供 display API v1 的 `dsh-preset-enhance`，仅面向 DSH 0.2.1 系列。

本地开发先在仓库根目录运行 `npm run build`，再分别安装主包目录和本目录。此新包尚未发布到 npm。

配置、接口及 GenUI/文件展示边界见仓库的 [正文正则说明](https://github.com/bychv/dsh-preset-enhance/blob/next-ver/docs/api/DISPLAY_REGEX.md)。
