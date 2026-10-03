# DSH 0.2.1-alpha.1 兼容记录

验证日期：2026-10-03。next-ver 从 main 的 84337df 创建，随后合入外部提示词模板注册、编辑器选用及酒馆 marker 关联。提示词处理链和独立显示包未引入；下文 456 项测试和宿主检查记录为合入前的适配基线，模板合入后的回归另见任务索引。

宿主使用 alpha 沙盒中的 npm 0.2.1-alpha.1；源码核对至 5badb15009ae1756c3afe0ae0cef1faafc290ccc。该源码未重新构建，运行验证针对 npm 安装。

## 调整

- package.json 的 engines.dsh 显式加入 =0.2.1-alpha.1。原有范围保留；不扩展到未经检查的 0.2.1 后续预发布版本。
- 更新手写宿主契约的核对版本，添加可复跑的宿主接口检查脚本。
- 本次未发现主包需要修改请求、预填充、工具策略或界面注册的运行逻辑。

## 源码检查

| 宿主变化 | 主包影响 |
| --- | --- |
| LLM 适配器通知调整异常隔离；请求类型和中间件签名保持不变 | 现有 Chat 适配器、预设注入和协议桥可沿用 |
| AgentPresetRegistry 内部移除模块级挂载查询，改由注册表管理生命周期，并提供 inspectCompositions | 主包使用 register/acquireScope/serviceFor 等注册表方法，不使用被删除的私有导出 |
| Loader 新增 moduleNamespace，供热重载与组合检查读取 | 未改变本插件入口形式和 effect 清理约定 |
| 会话草稿改为结构化数据，bindDraftMirror 改为 bindDraftPersistence | 主包只注册会话视图并读取 sessionId，不读写草稿接口；alpha 的独立显示包不在本次范围 |
| SessionController 列表增加分片调度 | 本插件使用的模型选择接口保持不变 |
| 工具 schemas、guard、restrict 仍提供原有作用域接口 | 无需改用硬编码工具列表 |

## 验证

- 主包类型检查和构建通过，456 项本地测试通过。
- 将 next-ver 构建快照安装到 alpha 沙盒，安装成功。
- sandbox smoke alpha 通过版本、配置、认证、HTTP 和启动日志检查。
- 真实宿主补充检查通过：工作台 API、预设模式注册、全部模式工具目录、Chat 适配器选项、两种编辑器资源和 assistant 预填充预览。
- 当次工具目录数量：standard 30、st-preset 30、ptc 29、minimal 1、cordis 32。数量是该沙盒配置的观测值，不作为插件硬编码规则。

补充检查不会调用模型、修改预设配置或切换已有会话协议；临时 Web 进程结束后自动关闭。没有验证真实模型回复、浏览器人工交互或实际热重载操作，启动冒烟不能代替这些验证。

```powershell
npm run build
npm test
& F:/Git/dsh-compact-sandbox/sandbox.cmd plugin alpha add .
& F:/Git/dsh-compact-sandbox/sandbox.cmd smoke alpha
node scripts/compat-021-verify.mjs
```

脚本默认使用本机沙盒 alpha 槽位和临时端口 3196；可通过第一个参数指定沙盒项目路径。请在本分支根目录运行，并先将当前构建安装到该槽位。脚本不输出登录令牌、预设正文或 API 密钥。

插件版本仍为 0.3.4-rc.3，尚未推送或发布。

## 模板合入后复测（2026-10-04）

- 构建通过，476 项主包回归全部通过。
- marker 关联、固定版本更新、缺失提供者、解除关联、锁定保护、保存重启和单文件分享均通过测试。
- 共享编辑器面板使用模拟 DOM 验证“关联到标记条目”与“恢复原标记”，未进行真实浏览器人工验收。
- 发现并修复：通用模板已关联闲置 marker 时，“加入当前顺序表”可能误复用该 marker。现在新增普通提示词与 marker 关联分别匹配；新增操作不能携带已有条目 identifier。
- 重新安装当前构建至 alpha 槽位，compat-021-verify.mjs 的认证启动、预设模式、工具目录、Chat 适配器选项、编辑器资源及预填充预览通过。未调用真实模型，临时服务已关闭。
- 文档相对链接检查无缺失，npm 干运行清单包含接口、兼容记录和方案文档，不含 sample。
