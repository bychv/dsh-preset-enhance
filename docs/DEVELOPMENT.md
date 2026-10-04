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

