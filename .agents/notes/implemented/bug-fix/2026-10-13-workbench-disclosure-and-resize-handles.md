# 工作台折叠状态与正文宽度手柄

Status: implemented

## 原因

工作台 iframe 重建后，固定 details 回到 HTML 默认状态。旧宽度锁的选择器针对布局的 sidebar/rightbar 分隔条，实际遮挡预设页的是会话正文的 `data-width-handle`，两者不是同一组控件。

## 修复

[disclosures.ts](../../../../src/client/disclosures.ts)只监听带稳定 `data-preset-disclosure` 标识的固定工作台区域，使用浏览器 localStorage 保存 open 偏好。离开返回和刷新恢复，未保存时使用原默认值；初始化恢复不反写，存储失败不阻断页面。正则、试运行、接口、工具预设及其他固定区域均纳入，已有动态工具面板保存方式保留。Raw 树、聊天历史与动态规则条目不套用此机制，也不写入预设或触发自动保存。

宿主轨迹页的 composer-overlay 标记同时改变输入区布局，因此未直接复用。客户端 [entry.ts](../../../../src/client/entry.ts)为工作台插槽占位元素标记身份，CSS 仅隐藏包含它的 `data-conversation-content` 直属正文手柄，不全局隐藏 sidebar/rightbar。视图切换卸载占位元素后规则自然失效；共享样式按 owner 集合管理，最后实例退出清理，热重载沿用样式时更新规则。显示为 none 同时撤掉指针命中和焦点区域，不只是覆盖 cursor。

原手写 client.js 已迁移为 TypeScript 构建产物，保留 ModuleLoader 注册方式和原 URL。[构建](../../../../scripts/build.mjs)同时生成 disclosures.js，宿主静态资源路由与工作台 HTML 已接入。

## 验证

构建通过，相关 34 项定向回归及全量 568 项回归通过。真实 alpha DSH 0.2.1-alpha.2 使用独立浏览器上下文验证：正则/试运行展开、请求参数折叠，离开进入插件页再返回及刷新后保持；会话内切到预设后两个实际正文手柄隐藏，切回对话恢复；无全局 html 锁或页面异常。

浏览器会话验证读取已有虚构测试会话，没有调用模型、修改真实预设或发送消息。已更新 alpha 快照并重启本会话启动的沙盒，服务保持供人工测试。未在真实宿主重跑插件启停、热重载及所有多视图组合；共享样式引用计数清理由客户端回归覆盖。

记录见[工作台 UI 验证](../../../../docs/testing/2026-10-13-WORKBENCH_UI.md)。

## 页面保留后的调整

宿主切换视图现在只卸载定位占位元素，iframe 隐藏并保留。宽度手柄样式以 `data-preset-enhance-frame-host` 占位元素为条件，离开后立即失效，不依赖 iframe 移除。详见[滚动与页面保留](2026-10-13-workbench-scroll-and-slider-theme.md)。
