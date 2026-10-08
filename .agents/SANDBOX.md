# 本机共享 DSH 沙盒

这是本机各工作树共用的沙盒位置，不是仓库内目录，也不是全局安装的 DSH。其他机器应替换路径，不假定相同盘符。

| 用途 | 位置 |
| --- | --- |
| 沙盒项目 | `F:/Git/dsh-compact-sandbox` |
| 统一启动器 | `F:/Git/dsh-compact-sandbox/sandbox.cmd` |
| alpha 槽位 | `F:/Git/dsh-compact-sandbox/.sandboxes/alpha` |
| alpha 官方源码 | `F:/Git/dsh-compact-sandbox/.sandboxes/alpha/github-source` |
| alpha 独立配置与数据 | `F:/Git/dsh-compact-sandbox/.sandboxes/alpha/home` |
| 沙盒测试报告 | `F:/Git/dsh-compact-sandbox/reports` |

当前项目的兼容与交互验证默认使用 alpha；执行前读取本机 `dsh-sandbox-test` skill，并用启动器确认实际版本。槽位版本可能更新，不以旧笔记中的版本号代替检查。

```powershell
& F:/Git/dsh-compact-sandbox/sandbox.cmd status alpha
# 以下安装命令须在本次任务的插件工作树根目录执行。
npm run build
& F:/Git/dsh-compact-sandbox/sandbox.cmd plugin alpha add .
& F:/Git/dsh-compact-sandbox/sandbox.cmd web alpha
```

插件按快照安装，源码更新后需重新安装才能验证。不要运行全局 dsh 替代启动器，不混用日常用户数据。共享槽位可能被其他任务使用，安装、重启前先确认占用与当前状态。

## 实际模型调用

本次“思维链工具调用未捕获”调查已获用户授权，可在沙盒进行少量实际 API 调用。该授权属于此项调查，不是所有未来任务的无限调用授权。

使用沙盒已有连接配置与凭据，先用虚构提示词和最小工具集验证单次调用，再视结果验证必要的工具续轮。不要硬编码或打印凭据，不读取真实预设内容作为公开测试夹具。优先采用临时目录中的无副作用工具，避免把模型生成的任意工具调用直接放开执行。

需要保存原始响应定位分片时，只保存本次虚构测试的数据到忽略的 `.test-data/`，清除认证头等敏感字段；公共笔记仅记录必要的格式片段、配置组合与结果，不复制完整思维链。

实际试验记录应区分：纯解析、假端点、真实 API、真实 DSH 工具执行。某一层通过不能代替整条链路验证。
