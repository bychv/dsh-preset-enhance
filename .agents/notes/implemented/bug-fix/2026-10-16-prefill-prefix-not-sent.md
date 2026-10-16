# 预填充未切到 beta：宿主把请求 Request 化，桥读不到请求体

Status: implemented

## 现象

工作台里预设已注入、末条是 assistant 预填充，但请求**始终不走 beta 接口**，模型按正文续写而不是按预填充续写。工作台的"历史请求"里也看不到 `prefix`。

> 本文件早前记录过一次排查，结论是"配置问题、未发现代码缺陷"。**那个结论是错的**，本文替换它。

## 根因

宿主自带的 `dsh-experimental-inspector` 包装了 `globalThis.fetch`，把每次调用**规范化成 `Request` 对象**再传给下游（`dsh-experimental-inspector/lib/index.js:53`）：

```js
const observedFetch = async (input, init) => {
  const request = new Request(input, init);   // 下游只收到 Request
  ...
```

而兼容桥只从 `init.body` 读请求体（`src/lib/deepseek-beta.mts` 的 `bodyText`），且只认字符串与 `Uint8Array`：

```js
if (typeof body === 'string') return body;
if (body instanceof Uint8Array) return new TextDecoder().decode(body);
return null;                       // Request 输入落在这里
```

所以 `raw == null`，改写函数**静默返回未改写**（`src/lib/deepseek-beta.mts` 的早退分支），前缀永远不可能发出。`captureOutgoingRequest` 同样只认 `init.body`，因此连 wire 快照都记录不下来——这也是"历史请求看不到 prefix"的直接原因。

## 为什么长期没被发现

- **预览路径传的是字符串**（`src/index.mts` 的预览分支直接构造 `(url, init)` 调用改写器），所以预览一切正常，只有真实链路失败。
- 桥的早退是**静默**的，没有警告、没有快照。
- 门控、注入、武装键、改写逻辑本身都正确，容易被逐个排除掉，把注意力留在配置上。

## 修复

在 fetch 包装层把宿主传来的 `Request` 还原成改写器认识的 `(input, init)`，其余不变：

- 新增 `materializeRequest()`（`src/lib/deepseek-beta.mts`）：`Request` 输入时用 `request.clone().text()` 取出 body，连同 method/headers/signal 组成 init；非 `Request` 输入原样返回。
- **未改写时仍把调用方原始的 `Request` 对象转发给底层 fetch**，不重新构造，避免丢失 credentials/redirect 等属性。
- 观察（`captureOutgoingRequest`）与协议观测使用规范化后的形态，因此 wire 快照恢复可记录。

## 验证

- **对照实验**：同一请求体，`string + init` 输入 → `changed=true` 且改写到 `…/beta/chat/completions`；`Request` 输入 → `changed=false`。修复后两者一致。
- **运行期探针**（真实沙盒）：修复前 `WRAP changed=false final=[object Request]`，而 `ACTIVATE keyLen=7` 证明桥已武装；修复后请求命中 beta。
- **真实 wire 快照**：`source=wire`、`protocol=chat-completions`、`status=HTTP 200`、末条 `prefix=true`、`content=""`、`reasoning_content="好的现在我是猫"`、原生 tools 已移除——即预填充正确进入思考通道。
- **回归测试**：`tests/core.test.mjs` 新增一条以 `Request` 输入驱动已安装的桥，断言改写命中 beta 且未激活时原样转发；旧代码下该用例会失败。全量 **582/582** 通过，`tsc` 与构建干净。

## 覆盖的输入形态

包装层先把输入规范化，再交给同步改写器：

| 形态 | 处理 |
| --- | --- |
| `Request` | `clone().text()` 取 body（非破坏性），未改写时仍转发调用方原始对象 |
| `string` / `Uint8Array` / `ArrayBuffer` / 其他 `ArrayBufferView` / `URLSearchParams` | 同步解码 |
| `Blob` / `ReadableStream` | 包装层异步读取；流已被占用或读取失败时保持原样（等同修复前行为） |

被读取过的 body 已被消费，因此这类调用即使在未改写时也从规范化后的 `(url, init)` 转发；其余调用继续使用调用方自己的对象。

## 遗留

- `FormData` 不读取：它不是 JSON 形态，改写器会安全跳过。
- 按当前约定 `<think>` 包装的预填充由目标设置决定通道（默认思考）；本文未改动该策略。

## 相关资料

- [桥与改写器](../../../../src/lib/deepseek-beta.mts)
- 宿主 inspector 包装：`@deepseek-ai/dsh-experimental-inspector/lib/index.js`（在宿主安装目录，不在本仓库内）
- [回归测试](../../../../tests/core.test.mjs)
- [工作台预填充开关](../../../../web/editor.js)
- [实现记录](../../../../docs/testing/2026-10-16-WORKBENCH_PREFIX.md)
