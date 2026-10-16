# 预填充 prefix 未出现在请求中的排查

Status: implemented

## 问题

用户报告：在沙盒实测的插件请求里「完全没有发送 prefix 参数」，并要求必须修好预填充、在真实沙盒 DSH 的插件请求上验证。

本记录说明实际发生了什么、哪些猜测被证伪，以及为此新增的可观测性与测试。

## 结论

**代码没有丢失 prefix。** 在预填充被正确配置的会话里，`prefix: true` 会出现在**最后一条 message 上**，不是请求顶层：

```json
{ "messages": [ { "role": "system", "content": "HEAD" },
                { "role": "assistant", "content": "", "reasoning_content": "好的，我继续。", "prefix": true } ] }
```

这与 DeepSeek beta 的前缀续写约定一致（标记属于那条 assistant 消息）。顶层没有 `prefix` 字段是正常的，以「body 顶层无 prefix」判定「没有发送」会误判。真实 API 复核：把该 body 直接发往 `https://api.deepseek.com/beta/chat/completions`，`dsh_prefill_target` 两个取值均返回 HTTP 200，续写正常（content 目标续出正文、reasoning 目标续出思考）。

## 观察到的真实原因（按证据强度）

1. **该槽位当时没有任何预设绑定到会话。** `GET /preset-enhance/api` 的 `bindings` 为空、`defaultPresetId` 为 undefined，因此编译结果为 null。`src/index.mts:461` 只在 `compiled !== null` 时武装 fetch 桥，桥不武装就不会有任何 prefix。这是配置状态，不是代码缺陷。
2. **抓到的真实宿主请求走 Messages 协议**（`POST /v1/messages`），不经过插件的 Chat 适配器，因此不参与这条预填充路径。这与 `src/index.mts:453` 的门控一致：Messages 模式不武装。
3. 该槽位的 `deepseekBetaPrefix` 实际为 **true**（门控 b 已满足），所以「开关默认关闭」不是本次现象的原因——默认值 false 只在全新状态成立。

## 被证伪的假设

- **激活 key 与 wire content 因 `<think>` 拆分而失配。** 一度很像，但顺序不成立：`src/lib/deepseek-beta.mts:275` 在 `thinkingMessages()`（:278）之前读的是原始 `last.content`；且 vendored 序列化器（`src/vendor/deepseek-chat/serialize.mts:201-217`）不拆 `<think>`，拆分只发生在更晚、更窄的兼容桥内。
- **key 的生产者与消费者分隔符不同。** 两者完全一致：`messageText`（`src/index.mts:1159-1161`）与 `flattenText`（`serialize.mts`）都是只取 text 块并 `join('')`。

## 字段位置（避免再踩）

`dsh_prefill_target` 存在于**预设顶层**：写入见 `web/editor.js:1824`，读取见 `src/index.mts:404` 与 :722，校验见 `src/lib/preset.mts:32`。单文件分享包中它出现在 `preset.data.dsh_prefill_target`（`tests/preset-package.test.mjs:398`），这是分享层的位置，不是运行时读取的位置。`PRESET_FORMAT.md` 第 90 行的措辞按 `preset.data` 描述，容易被读成运行时字段，实施时以代码为准。

## 影响与验证

证据分两类，强度不同，不要混用：

- **前缀标记的位置与语义**：由预览/改写逻辑（`src/index.mts:717-727` 走同一个 `rewriteDeepSeekPrefixFetch`）复核两个目标，`prefix:true` 均出现在末条消息；再由真实 beta 端点各发一次（均 HTTP 200，续写正常）确认该位置被官方接受。**这不是抓到的宿主 wire body。**
- **真实宿主抓包**：两次 `POST /v1/messages`，证明的是**官方 Messages 路由不经过插件适配器**，因此不是前缀路径（`src/index.mts:453` 的门控要求非 messages 才武装）。顶层无 prefix 属预期。

仍未完成：**尚未抓到插件适配器自己发出的真实 wire body**。要抓需要把该 profile 的 `agent-default-model` 指向 `preset-deepseek-chat` 并让插件按包名解析（headless 下 `--patch` 挂裸目录会报 `ERR_UNSUPPORTED_DIR_IMPORT`）；web 剖面已按包名安装，是可行路径。
- 覆盖缺口由测试盘点提供，是本记录保留的主要价值：真正断言「线上 body 出现 prefix」的用例只有 7 处，且工作台路径（官方 chat + `assistant_prefill` + `dsh_prefill_target`）没有任何 L3 用例；`content` 目标、工具续轮、`deepseekBetaPrefix=false` 的反向断言均缺失；`preset-stability*` 的 prefix 断言针对 `scripts/preset-stability-core.mjs` 的复刻实现，生产转换器损坏时不会变红。
- 未做：未改动运行时代码（本次未发现需要修的行为缺陷）。上面的覆盖缺口尚未补测。

## 相关资料

- [兼容桥与预填充改写](../../../../src/lib/deepseek-beta.mts)
- [激活门控](../../../../src/index.mts)
- [序列化器](../../../../src/vendor/deepseek-chat/serialize.mts)
- [预设字段校验](../../../../src/lib/preset.mts)
- [预设格式说明](../../../../PRESET_FORMAT.md)
- [工作台预填充开关](../../../../web/editor.js)
- [本次验证记录](../../../../docs/testing/2026-10-16-WORKBENCH_PREFIX.md)
