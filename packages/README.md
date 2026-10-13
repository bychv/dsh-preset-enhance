# 包地图

| 位置 | npm 包 | 职责 |
| --- | --- | --- |
| 仓库根目录 | `dsh-preset-enhance` | 保留原安装入口，携带正文包；预设、工作台、提示词处理与共享正则配置 |
| [display-regex](display-regex/README.md) | `dsh-preset-display-regex` | 可选的助手正文显示替换 |
| [bundle](bundle/README.md) | `dsh-preset-enhance-bundle` | 开发期兼容入口；正常升级使用主包 |

保持现有分包，不额外引入公共运行包。源码使用 TypeScript，生成的 JavaScript 继续保持既有发布路径；两种文件不混作可维护源码。

正文包的宿主入口在 `display-regex/src/index.mts`，浏览器桥接、渲染与执行器在 `display-regex/src/client/`。共享 Worker 源码在根目录 `src/client/worker/regex-worker.ts`，构建到主包和正文包各自的资源路径。主包正则编辑、Raw 预览和可用性订阅在 `src/client/`；其余旧工作台 JavaScript 按涉及模块逐步迁移。组合包入口在 `bundle/src/index.mts`。

在仓库根目录运行 `npm run build` 和 `npm run typecheck`。构建先通过宿主与浏览器检查，再更新产物；不要直接修改生成文件。每个包的 README 说明安装边界，跨包契约见[正文正则](../docs/api/DISPLAY_REGEX.md)。
