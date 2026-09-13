# DSH Preset Enhance

为 DeepSeek Harness 加载和编辑 SillyTavern 预设，并在发送给模型前按顺序表注入消息。

## 安装

```powershell
dsh plugin --profile web add github:bychv/dsh-preset-enhance
```

重新启动 `dsh web` 后，左侧栏会出现“预设工作台”，新建对话的模式列表中会出现“预设模式”。

安装插件后会新增 **预设模式**。在该模式中新建的对话会从第一轮起自动启用“模式默认”预设；第一次实际请求会把当时的默认值固定到该对话。该模式会清除 DSH 的身份 system prompt、运行环境快照和工具 schema，发送给模型的消息只由预设和真实聊天记录组成。普通模式只在用户为当前会话明确启用后注入，并保留 DSH 原有内容。

预设工作台可从左侧栏打开，也保留在对话的“预设”标签页。导入或编辑预设并保存后，可以设为模式默认。条目列表分为：

- **顺序表内**：已经参与当前顺序表的条目，其中复选框控制启用状态；未勾选的条目仍属于顺序表。
- **闲置条目**：没有加入当前顺序表，不参与注入；点击“加入”才会移动到使用区。

支持顺序表中 `chatHistory` 前后的 system、user、assistant/model 消息，以及按聊天深度注入。支持常用 SillyTavern 变量宏，包括 `setvar`、`getvar`、global 变量、数值修改、随机选择与骰子。`extensions` 会原样保留在预设 JSON 中，当前版本不执行其中的扩展行为。
