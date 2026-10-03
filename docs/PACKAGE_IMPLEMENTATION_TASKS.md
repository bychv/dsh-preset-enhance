# 分包实施任务索引

本分支 next-ver 已合入 T01/T02 外部提示词模板和酒馆 marker 关联；T03 及显示包 T04–T08 的 alpha 实现未合入。marker 接口与保存规则见 TEMPLATE_API.md。

合入验证（2026-10-03）：构建和类型检查通过，473 项主包回归通过。此次未重新安装沙盒；0.2.1-alpha.1 的宿主检查记录对应合入前的适配基线。

用途：逐项实施和交接时从这里查阅。每次只完成一个可验证的小功能，状态区分“已实现”和“仅有方案”，不把规划中的服务写成已可调用。

## 当前进度

| 任务 | 状态 | 本任务交付 | 验收重点 |
| --- | --- | --- | --- |
| T01 外部模板注册目录 | 已实现 | 根包 presetTemplates 服务、公开类型、只读目录接口、接入文档 | 两提供者同名隔离、版本校验、原子更新、卸载清理、不改变请求 |
| T02 工作台选用与注入 | 已实现 | 插件模板分区、引用保存、顺序表加入与开关、统一编译 | 自动保存、锁定版本、缺失依赖、历史后插入、预填充、单文件分享 |
| T03 提示词序列处理链 | 待实现，可独立于显示包 | promptSequence 服务、固定处理阶段、用户控制排序与失败策略 | 多插件串行、工具块保护、取消、预览、重试不重复注入 |
| T04 显示包最小闭环 | 待实现 | packages/display 独立构建入口、根包最小配置读取接口、只读预览入口 | 可单独打包安装、缺少根包时降级、主栏/侧栏身份与卸载 |
| T05 显示侧正则 | 待实现，依赖 T04 | 共享纯计算核心、浏览器 worker、显示开关与原文回退 | 请求与显示通道分开、超时、历史变化、数据修订 |
| T06 HTML 与基础组件 | 待实现，依赖 T04/T05 | 静态隔离 HTML、组件围栏和基础组件目录 | 解析失败回退、隔离、重复挂载、资源路径及与 genui 共存 |
| T07 可定制选项栏 | 待实现，依赖 T01/T02/T06 | choice-bar 外观模板、字段映射、追加草稿与显式发送 | HTML/CSS 槽位、长列表折叠/滚动、旧选项点击、独立更新 |
| T08 独立状态生产者 | 待实现，依赖 T06 | RenderService、变量提供者适配、晚到结果和独立重生成 | 正文正常结束、版本冲突、重启恢复、MVU 所有权、历史依赖 |
| T09 脚本运行时接入 | 仅预留 | 引用、能力查询与适配边界；执行器另立任务 | 未安装也可展示、取消、卸载后写入、事件重入、跨会话隔离 |

T01/T02 已完成模板服务与选用注入；显示包仍未创建。T04 先提供独立预览；正文内嵌入须证明能可靠定位且不会影响工具、图片和推理块，不能先隐藏整个助手节点。

## T01 交接

- 使用说明与示例：[外部提示词模板 API](../TEMPLATE_API.md)。这是当前已实现接口的权威说明。
- 注册表：`src/lib/template-registry.mts`；公开运行时入口：`src/templates.mts`；公开类型：`src/template-api.d.mts`。
- 宿主集成：`src/index.mts` 发布 `presetTemplates`，提供 `GET /preset-enhance/api/templates`。
- 针对性测试：`tests/template-registry.test.mjs`、`tests/template-api.test.mjs`；测试包含两个模拟提供者及不改变预设文件/模型请求的检查。
- 构建会生成 `templates.mjs`、`templates.d.mts` 和 `lib/template-registry.mjs`，公开类型和使用文档均包含在发布包文件清单中。

T02 已复用现有 store 的事务、revision、自动保存和预设编译入口；不要让提供者自行保存模板到用户资源库，或注册新的 llm/stream 处理器重复注入。

### T01 验证记录

2026-09-30：构建与类型检查通过，新增 8 项测试和已有 7 项启动/生命周期回归通过。另使用 alpha 槽位现有的 `@deepseek-ai/cordis` 4.0.4 验证两个提供者注册、单个作用域卸载/重载，以及服务撤下后的依赖清理；未安装插件或启动完整沙盒服务。

```powershell
npm run build
node --test tests/template-registry.test.mjs tests/template-api.test.mjs tests/plugin-lifecycle.test.mjs tests/startup-recovery.test.mjs
npm pack --dry-run --ignore-scripts
```

打包清单已确认包含公开运行时入口、声明文件、注册表和 API 文档，不含 sample。上述打包检查依赖前一步成功构建；没有发布或推送。

## 设计文档

- [显示侧正则、HTML 与组件分包](DISPLAY_REGEX_PACKAGE_PLAN.md)：包边界、渲染路径、选项栏与独立组件更新。
- [外部模板与插件接口设计](PLUGIN_TEMPLATE_CONTRACT_PLAN.md)：模板引用、序列处理链、功能组合和未来脚本系统。

设计文档包含未实现能力。完成后更新本索引，并把稳定接口整理到独立使用文档，不要求接入方通读整份设计草案。

## T02 交接

- 选用/固定版本/脱离关联：src/lib/template-bindings.mts；共享面板：web/plugin-templates.js 与 CSS。
- 普通工作台复用自动保存，SPreset 复用手动保存；绑定存入 ST extensions，源文本快照保存在 prompts，单文件导出保持完整。
- 编译和预览统一解析关联。缓存键包含启用模板的实际指纹与缺失状态，提供者卸载/恢复不会继续用旧结果。
- 文档权威入口：[模板 API](../TEMPLATE_API.md)；分享格式补充：[PRESET_FORMAT.md](../PRESET_FORMAT.md)。
- 附带修复：工作台协议切换调用宿主 sessionController.selectModel 更新当前会话；无会话时才改默认值。模型列表读取官方目录，未手动设置时同步官方目录，chatModels 可覆盖；重置或清空恢复同步。
- 验证：构建与 468 项完整本地回归通过，另新增 1 项共享面板草稿冲突测试通过；使用 alpha 现有 Schema 库校验配置。新增测试覆盖保存/分享、版本缺失、模板卸载重载后的请求缓存、当前会话隔离、模型目录同步。未安装、启动沙盒或调用真实模型。

下一项为 T03 提示词序列处理链，继续按设计的最小范围推进。
