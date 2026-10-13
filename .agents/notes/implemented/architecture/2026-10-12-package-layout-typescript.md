# 现有分包内的文件整理与 TypeScript 约定

Status: implemented

## 依据与决定

用户要求参考 [DSH packages](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages) 和[官方中文包地图](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.zh.md)，并使用 TypeScript；随后明确保留现有分包，主要整理包内文件。2026-10-13 实施，不新增包管理器或额外公共运行包。

保留根目录主包、`packages/display-regex` 正文包及 `packages/bundle` 组合包的职责与 npm 名称。将正文包客户端桥接、DOM 渲染、执行器移到 `src/client/` 的 TypeScript 源码；共享 Worker 移到根目录 `src/client/worker/`；主包正则编辑器和可用性通知模块位于根目录 `src/client/`。组合包的空入口也由 TypeScript 构建。

[构建脚本](../../../../scripts/build.mjs)分别检查宿主与浏览器项目，再生成既有路径的 JavaScript，保留 ModuleLoader 桥接和 Worker URL。共享计算模块和公开显示能力契约按构建复制到正文包，不依赖主包私有运行服务。客户端消费宿主的 React 与 MarkdownText，不引入另一份宿主框架。

入口地图见[packages README](../../../../packages/README.md)，开发命令见[开发验证](../../../../docs/DEVELOPMENT.md)。新增实现使用 TypeScript；工作台其余客户端和已有模板 UI 仍包含旧 JavaScript，后续按涉及模块逐步迁移，不声称全仓迁移完成。此次未将主包搬入 packages，也未采用一次性重写客户端的方式。

## 同一插件页面

DSH 0.2.1-alpha.2 按 bundle patch 声明的 rows 形成详情页，不按 repository 字段合并。现有组合 patch 已声明两个运行条目；补齐组合包的图标、中文元数据和安装说明。后续已将主包本身改为推荐组合入口，旧用户不必换包，见[保留安装入口](2026-10-13-preserve-install-entry.md)。`packages/bundle` 仅作兼容入口，不能同时选择多个入口重复装配。

真实隔离 profile 只将组合包声明为顶层依赖，两个运行包由已安装的本地快照提供。原生插件详情页已验证显示两个条目，并可单独启停正文包。三个包的版本与精确依赖仍需在发布时同步；新子包尚未发布，不能假定当前 npm 已有组合安装能力。

## 验证与边界

类型检查、构建、相关回归以及真实宿主工作台、SPreset 和 Worker 验证通过，证据见[实施验证](../../../../docs/testing/2026-10-13-PACKAGE_LIFECYCLE.md)。包职责延续[拆包决策](2026-10-12-output-regex-package-boundary.md)。显示语义仍以[正文正则契约](../../../../docs/api/DISPLAY_REGEX.md)为准，未新增 HTML、组件或会话写回能力。
