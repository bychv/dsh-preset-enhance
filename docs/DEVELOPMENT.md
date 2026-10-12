# 开发与验证

```powershell
npm install
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


## 正文显示子包

根目录 `npm run build` 同时检查两个 TypeScript 项目，更新主包及 `packages/display-regex` 的宿主入口与 Worker 共享模块。客户端源码仍使用原生 JavaScript，无需另装共享运行包。

本地安装两个目录才能验证正文替换。分别在根目录、`packages/display-regex` 和 `packages/bundle` 执行 `npm pack --dry-run` 检查清单；组合包的新依赖尚未发布，不能作为当前 npm 安装入口。

针对正则与配置生命周期可运行 `node --test tests/display-regex.test.mjs tests/display-regex-runtime.test.mjs`；真实宿主检查见[正则验证](testing/2026-10-12-DISPLAY_REGEX.md)。
