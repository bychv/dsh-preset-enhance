# 助手正文正则的显示副本

Status: implemented

## 决定

根据用户 2026-10-12 的实施要求，正文替换放入可选 `dsh-preset-display-regex` 包。主包负责规则、预设绑定及保存；显示包读取原始 ChatSnapshot，在 Worker 中计算，再展示替换后的 Markdown。HTML 始终作为文本，不执行脚本，不修改真实会话数据。

规则沿用 `extensions.regex_scripts`，显示仅取 markdownOnly + assistant placement；提示词通道独立。宏变量副本不回写，随机种子按消息与配置修订固定。思考、图片和工具块隔开匹配范围。按照用户最终要求，组件围栏不触发自动回退；完整替换结果交给宿主 Markdown，围栏由另装 GenUI 接管。显示包只提供流式标记与复用的渲染根，不实现组件引擎。

## 选择依据

逐 TextNode 改写不能跨 Markdown 元素匹配，且 React 可覆盖结果；写回 Session 会改变上下文和导出，因此采用原始文本的可恢复显示副本。错误、超时、停用、断线及结构不匹配时保留或恢复宿主原文。

配置使用成功提交后的 SSE 更新，客户端观察消息及视图边界；并发渲染等待实际 React commit，再隐藏原文，不能以一次 animation frame 作为提交完成信号。流式更新复用渲染根，不在每个分片重新挂载。

## 验证与边界

[正文正则接口与限制](../../../../docs/api/DISPLAY_REGEX.md)、[沙盒验证](../../../../docs/testing/2026-10-12-DISPLAY_REGEX.md)和[自动回归](../../../../tests/display-regex-runtime.test.mjs)记录执行范围。未验证任意第三方正文渲染器，未实现 HTML、组件、脚本或消息写回。新子包尚未发布。
