# 开发与验证

```powershell
npm install --no-save --package-lock=false ./packages/display-regex
npm run build       # 类型检查并生成发布用 JavaScript
npm test            # 本地回归用例
npm run pack:check  # 检查 npm 打包内容
```

本地双协议端点可用于观察 Chat Completions 与 Messages 的流式响应和请求记录：

```powershell
node tests/fixtures/protocol-server.mjs --demo
node tests/fixtures/protocol-server.mjs
```

具备本机沙盒环境时，`npm run test:mcp:candidate` 可在 **candidate 槽位**启动两个隔离的 stdio MCP 服务，检查发现、调用和分组；结束后关闭测试服务，不写入 candidate 配置。



通过沙盒 CLI 安装新快照后，需确认运行中的 DSH 已完成插件热重载；未重新加载时重启对应槽位。磁盘资源更新不代表进程内的新静态路由已注册。新增工作台模块时，要检查实际 HTTP 模块依赖是否全部返回 200，不能只验证配置 API 或将模块内联的模拟 DOM 测试。

## 本地化与文档维护

三个包各自的 `locale/en.json`、`locale/zh-CN.json` 提供 DSH 插件管理器读取的 `meta.title` 和 `meta.description`。英文文件使用英文显示名称和简介，中文文件保留中文；键结构应一致。适配器名称、工作台及 SPreset 的中文文案仍在源码中，不会因修改这些元数据自动变成英文界面。

功能或字段变化时，先更新 `docs/guides/` 的操作说明、`docs/api/` 的接口契约或根目录 `PRESET_FORMAT.md`，再按需调整[架构入口](ARCHITECTURE.md#代码对应关系)和[文档导航](README.md)。`docs/plans/` 标明已落地与待实施范围；`docs/testing/` 保留当次版本、测试数量和验证边界，不将历史记录改写为当前版本已全部复测。

仅修改 locale 或文档时，检查 JSON 键与语言、相对链接以及三个包的 `npm pack --dry-run --ignore-scripts` 清单即可，无需重跑模型调用或完整运行测试。改变 TypeScript 源码时仍需构建。

## 正文显示子包

根目录 `npm run build` 检查主包宿主、子包宿主及浏览器 TypeScript 项目，再生成主包与显示包的运行产物。`src/client/` 保存客户端入口、折叠与滚动状态、正则编辑器、Raw 预览、可用性订阅和共享 Worker；正文包浏览器源码在 `packages/display-regex/src/client/`。既有资源 URL 保持不变，无需另装共享运行包。其余旧 JavaScript 按模块继续迁移。

主包现在携带正文包，无需换装组合入口。子包未发布时，上述安装命令用本地子包满足依赖，沙盒使用本地 tarball 或构建快照；发布 manifest 保持精确版本。分别在根目录、`packages/display-regex` 和 `packages/bundle` 执行 `npm pack --dry-run` 检查清单。安装边界和发布顺序见[正文正则](api/DISPLAY_REGEX.md#安装与升级)。

针对正则与配置生命周期可运行 `node --test tests/display-regex.test.mjs tests/display-regex-runtime.test.mjs tests/display-lifecycle.test.mjs`；真实宿主检查见[正则验证](testing/2026-10-12-DISPLAY_REGEX.md)。

## 未发布分包的本地安装

正文包尚未发布时，不直接运行 `dsh plugin ... add .` 请求 registry。开发依赖使用文首的本地安装命令；构建通过后打包两个运行包：

```powershell
New-Item -ItemType Directory -Force artifacts
npm pack ./packages/display-regex --ignore-scripts --pack-destination ./artifacts
npm pack . --ignore-scripts --pack-destination ./artifacts
```

在独立测试 profile 中，用包管理器的本地依赖覆盖将 `dsh-preset-display-regex` 指向生成的子包 tarball，再安装主包 tarball。profile 顶层只选择 `dsh-preset-enhance`；不要把正文包再选为独立 bundle，也不要修改发布 manifest 为本地路径。

当前沙盒使用 pnpm 11，覆盖写在该测试 profile 的 `pnpm-workspace.yaml` 的 `overrides` 中，值为子包 tarball 的绝对 `file:` 路径；旧式 `package.json.pnpm.overrides` 不再读取。已经验证此方式能从旧主包安装升级，保留预设、配置及主条目 ID。操作范围与结果见[升级验证](testing/2026-10-13-PACKAGE_LIFECYCLE.md#原主包入口平滑升级)。

正式发布须同步版本和精确依赖，先发布正文包并确认可下载，再发布主包；之后用户继续按原入口升级。`packages/bundle` 保留为开发期兼容入口，不是新用户的必装包。
