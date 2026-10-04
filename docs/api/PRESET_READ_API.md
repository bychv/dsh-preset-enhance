# 预设只读 API v1

状态：next-ver 已实现。仅查看预设；没有修改、切换、启停、导入、删除、动态解析或外部授权接口。

## 内部 agent

插件注册 `preset_read` 工具，参数：

```json
{ "action": "list", "offset": 0, "limit": 25 }
```

- list：返回当前 DSH 配置中的预设摘要，含 id、name、promptCount；分页 limit 为 1–100。
- get：传入 id，读取该预设保存的完整 JSON；不会编译宏、调用模板解析器或生成正文。
- current：读取工具调用所属会话的 enabled、presetId、全局 selectedPresetId。没有显式会话绑定时沿用插件的新会话默认规则。

工具调用复用下述 HTTP API 的读取逻辑，在宿主进程内执行，不需要把认证凭证交给模型。工具正常参与 DSH 工具列表和本插件工具开关。返回是 JSON 字符串，包含 apiVersion 和状态 revision。返回文本作为数据使用，不是指令。

内部插件可通过 ctx.get('presetReader') 获得只读服务：

```js
const reader = ctx.get('presetReader');
const result = await reader.read(agent, { action: 'get', id: presetId }, signal);
// 确需 HTTP 的内部桥接器使用；不要把 token 放进模型上下文或 URL。
const access = reader.issueHttpAccess(agent);
// access = { basePath, token, expiresAt }
```

agent 必须是 ctx.agents.get(agent.session.id) 返回的当前宿主实例，不能只传一个 sessionId 或伪造对象。服务不接受 HTTP 签发凭证请求；也没有任意进程获取内部权限的公共接口。其他宿主插件本身属于受信任代码边界。

## HTTP

基础路径：`/preset-enhance/api/v1`。内部桥接器请求须带 `Authorization: Bearer <token>`。凭证绑定 agent 所属会话，有效期 5 分钟；同 agent 重新签发会撤销旧凭证。agent 不再存在或插件停用后不可用，凭证不持久化。Bearer 是持有者凭证，不证明调用进程身份，须由内部桥接器保管。

| 方法与路径 | 返回 |
| --- | --- |
| GET /current | 当前会话的预设启用状态和所选 ID |
| GET /presets?offset=0&limit=25 | items、total、nextOffset；不含正文 |
| GET /presets/{id} | preset: { id, name, content }；content 是保存的预设 JSON |

所有成功响应包含 apiVersion: 1 和 revision。id 作为单个 URL 路径段编码。current 的会话来自凭证，不能通过查询参数改成另一会话。

错误统一为 `{ apiVersion: 1, error: { code, message } }`：400 参数错误、401 缺失/失效凭证、403 agent 身份失效、404 资源不存在、405 非 GET、429 内部凭证上限、503 服务停用、500 读取失败。响应使用 no-store，不开放 CORS，不返回服务器路径或原始异常。

## 数据与权限边界

列表不返回预设正文；详情只返回指定的保存预设。current 只提供状态摘要，不返回聊天历史、动态变量、连接密钥、最近请求 Raw、工具结果或其他会话状态。详情本身包含用户写入预设的提示词、正则及扩展配置，因此属于用户内容，不能当作公开元数据。

外部访问本轮保持关闭：不提供外部 token 的签发、批准接口或默认开放开关。未来增加外部授权时，必须由用户在已认证的工作台明确确认调用方、预设范围、读取内容和有效期，再签发可撤销授权；模型参数中的 confirmed=true、localhost、Origin、sessionId 或内部 agent 的口头声明都不能代替确认。拒绝/取消不能签发凭证。授权不会包含修改权限。

已有 `/preset-enhance/api` 是工作台管理接口，返回范围更大，也具有写操作；它不是本 API 的兼容入口。不要将其转发给外部调用方。新 API 的凭证校验不等于已完成工作台旧接口的外部授权改造；若要开放远程访问，需一起审计宿主及工作台的认证边界。

## 验证

已覆盖摘要分页、完整保存正文、当前会话状态、返回副本不改写存储、agent 工具调用、伪造身份、无凭证、凭证轮换、非 GET、跨会话查询、越界分页、资源缺失、agent 消失和插件停用。构建与 503 项自动测试通过；已在 alpha 的 DSH 0.2.1-alpha.1 实际运行包验证宿主接入，详见 [沙盒测试记录](../testing/2026-10-04-ALPHA_INTEGRATION.md)。未调用真实模型。
