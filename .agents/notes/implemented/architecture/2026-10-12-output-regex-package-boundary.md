# 正文正则替换的可选拆包边界

Status: implemented

## 最终边界

用户在深入分析后要求实施：主包保持已有 npm 发布布局，保存和编辑规则；`packages/display-regex`（dsh-preset-display-regex）执行助手显示替换；`packages/bundle` 是组合安装入口，仅以 dependencies 和 Cordis patch 启用两个包。共享纯计算模块在构建时复制，不创建用户必须安装的第三个公共运行包。

组合方式参考 DSH 官方 cot-translation-bundle；显示接入参考本机 dsh-genui 的公开 ChatSnapshot 与 DOM 恢复思路，但不依赖 GenUI，不将正文转换为组件围栏。宿主基线为 DSH 0.2.1-alpha.2，原文源码在本机[共享沙盒](../../../SANDBOX.md)。

## 接入依据

目前核对的宿主没有普通正文字符串替换 middleware。替换整个 assistant renderer 会连带思考和工具等业务块；逐 TextNode 又无法跨 Markdown 标签。因此只对原始助手 text block 计算，在能准确对应原文节点时插入自己的 MarkdownText 根。

宿主的 slot 会附带 display:contents 包装；消息身份使用 data-chat-node-key，并从所属 data-conversation-session 找绑定，不回退到全局当前会话。DOM 节点被复用时重新验证所属会话和 source，避免跨会话串用。结构不匹配交还宿主。

API v1 使用宿主 Web 登录、配置 GET 和保存成功后的 SSE，数据不包含预设提示词及历史全文。没有硬依赖主包内部服务或私有 Session 事件；缺失 API 时恢复原文。两个包目前按同一源码构建，尚未发布子包。

## 明确保留的边界

显示包只替换副本，复制、导出和模型历史仍读原文。独立 React 根不继承宿主私有文件导航；最终按用户要求不因 dsh-ui/svg 围栏自动回退。完整替换结果仍使用宿主 Markdown，另装 GenUI 可在显示副本接管组件。流式属性随状态更新。

后续 HTML 隔离、声明式组件、选项栏、MVU、脚本执行和任意第三方围栏协作仍未实现，不能从“分包已落地”推断这些能力已存在。原整体设计见[显示分包方案](../../../../docs/plans/DISPLAY_REGEX_PACKAGE_PLAN.md)，当前契约以[正文正则](../../../../docs/api/DISPLAY_REGEX.md)为准。

## 验证

构建和打包分别检查两个运行包及组合包；Worker、提交后通知、配置竞态、React 提交确认与跨会话复用由[自动回归](../../../../tests/display-regex-runtime.test.mjs)及[真实宿主记录](../../../../docs/testing/2026-10-12-DISPLAY_REGEX.md)覆盖。已与 GenUI 0.11.1 做实际共装的普通正文、混合代码/组件/SVG、开关、清理和历史刷新验证；使用并撤销沙盒精确版本豁免，不代表 GenUI 所有组件和工具已适配。未实现正文写回。
