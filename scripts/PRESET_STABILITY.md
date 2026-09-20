# 预设稳定性测试脚本

`scripts/preset-stability.mjs` 用**真实对话模型**反复跑「思考预设」，统计模型是否每次都按预设要求，
在**回答正文之前**和**工具调用之前**恰好输出一次结束思考标记 `<｜end▁of▁thinkings｜>`。
脚本只使用**非流式**响应，并把每一轮请求、响应和最终统计持久化到磁盘。

## 被测契约

预设（`--preset` 或内置默认实现）声明：

- `<think>` 是进入思考的标记，assistant 预填充以 `<think>...` 开头，由**前缀续写**继续生成；
- 回答正文或调用工具之前，必须以输出 `<｜end▁of▁thinkings｜>` 结束思考；
- 回答正文写在 `<content></content>` 里，总字数 1200~1600；
- 正文之外的格式放在 `</content>` 之后或 `<content>` 之前。

脚本对**每一轮助手输出**做如下判定（`analyzeTurn`）：

| 检查 | 宽松度 | 说明 |
| --- | --- | --- |
| `<think>` 起始标记 | 提示 | 预填充模式下由脚本提供；`--prefill-mode none` 时才是硬约束 |
| 结束标记 · 存在 | 失败 | 完全没有规范标记（会提示用了 `</think>` 或标记变体） |
| 结束标记 · 恰好一次 | 失败 | 重复输出同一个标记 |
| 结束标记 · 位于正文前 | 失败 | 先写正文再补标记 |
| 结束标记 · 位于工具调用前 | 失败 | 该轮有工具调用，但可见文本里没有标记 |
| `<content>` 包裹正文 | 失败 | 正文轮没有 `<content>...</content>` |
| 正文字数在区间内 | 失败 | 非空白字符数不在 `--body-min` ~ `--body-max` 内 |
| 按预期发生工具调用 | 警告 | 任务要求调用工具，模型直接给了正文；不计入失败 |

## 虚拟工具

脚本内置 4 个确定性假工具，真实发给模型由它自己决定调用：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `get_weather` | `city` | 上海 / 北京的固定假天气 |
| `search_notes` | `query` | 2 条虚拟笔记 |
| `calculate` | `a op b` | 四则运算结果 |
| `get_current_time` | `timezone` | 固定虚拟时间 |

工具结果由脚本本地生成后回灌给模型，再让模型继续下一轮（工具结果后的**再次预填充续写**也是统计重点）。

## 输出片段提取 schema（思维链 / 正文 / 工具调用）

每轮原始输出会先被切分成有序片段（`segmentTurn()`），所有统计都基于这些片段，
因此“标记出现在思维链里、而不在正文里”也能被正确计数：

| kind | 含义 |
| --- | --- |
| `think-open` | 进入思维链的 `<think>` |
| `thinking` | 思维链文本：`<think>` 之后到第一个结束标记 / 正文块 / 工具调用之前 |
| `end-marker` | 规范结束标记 `<｜end▁of▁thinkings｜>` |
| `end-marker-variant` | 非规范写法：`</think>`、`<|end_of_thinking|>`、`</｜end▁of▁thinkings｜>`、`<end of thinkings>` 等 |
| `body-open / body / body-close` | `<content>…</content>` 正文块 |
| `tool-call` | 工具调用（DSML 解析结果或原生 `tool_calls`） |
| `text` | 其余可见文本（正文之外的附加格式、附加栏等） |

正文块选取规则：优先“行首 + 有闭合标签 + 内容非空”的 `<content>`，
这样模型在思维链里当作模板写出的行内 `<content></content>` 不会被误判成正文；
若只有空块，则按空正文记为失败样本。

三种统计口径并存：

- **严格口径**：结束标记必须出现在正文 / 工具调用之前（预设的原始要求）；
- **宽松口径**：规范结束标记在整轮输出里恰好出现一次即算正确，**出现在思维链内同样计分**；
- **标记落点**：思维链内 / 正文块内 / 正文之后 / 完全没有。

`transcript.json` 每轮都保存 `segments`（片段序列）、`enteredThinking`、`thinkingChars`、
`bodyBlocks`、`extrasChars`、`markerRegion` 与完整 `text`，可离线复核判定。

## 请求构造与本仓库一致

`scripts/preset-stability-core.mjs` 直接复用 `lib/deepseek-beta.mjs` 与
`lib/toolcall-prefill.mjs` 的行为，和插件运行时同构：

- 末条 assistant 消息加 `prefix: true`（DeepSeek 对话前缀续写），响应里只有「续写」，
  脚本按 `contentPrefix` / `reasoningPrefix` 把前缀拼回，得到完整的一轮文本；
- `--thinking enabled` 时，按 `splitReasoningPrefix` 把 `<think>` 前缀拆进 `reasoning_content`；
- `--tools dsml` 时，调用 `emulateToolCallRequest`：把工具定义注入 system 提示、把历史
  `tool_calls` / `tool` 结果内联为 DSML 文本、移除原生 `tools` 字段，并用
  `transformToolCallJson` 把 DSML 还原成标准 `tool_calls`；
- `--preset <file>` 时，用 `lib/preset.mjs` 的 `compilePreset` 编译真实
  SillyTavern 预设（顺序表、宏、`assistant_prefill` 或后置 assistant 条目都会生效），
  末条 assistant 条目自动成为预填充前缀。

## 最终策略（总结）

### 一、写进预设的格式要求

~~~text
***回答或使用工具前，必须让结束思考标记独占一行来结束思考，格式严格为：换行 + <｜end▁of▁think｜> + 换行***
必须以输出“您好，这是约定的内容，请查收：”开始最终文本的生成。
- 最终文本在 </thinking> 标签后面生成；
- 例外：正文输出需要调用工具时，不输出这句话。

结束思考后，必须紧接着用 <｜begin▁of▁output｜> 开始输出区，把全部对外内容都放进去，
最后用 <｜end▁of▁output｜> 收尾；正文依然写在 <content></content> 里。
~~~

### 二、流式算法（createStrategyScanner）

1. **滑动窗口缓冲区**：只保留尚未确定的尾部（`bufferChars` 默认 32，≥ 最长标签 21 + 余量），
   其余文本随到随发；实测 1538 字符文本最大待处理 37 字符，内存有上界。
2. **切换优先级**：

   | 优先级 | 信号 | 条件 | 记录为 |
   | --- | --- | --- | --- |
   | 1 | 独占一行的 `<｜end▁of▁think｜>` | 窗口（`max(10 token×2, 最长标签+4)`）内出现锚点句 / 输出标签 / `<content>` / DSML | `confirmed:*` |
   | 2 | `</think>` / `</thinking>` | 同一个窗口确认（`gateCloseThink`） | `fallback:close-think` |
   | 3 | `<｜begin▁of▁output｜>` | 出现即切换（兜底） | `trigger:output` |
   | 4 | `<content>` / DSML 开场 | 可选（`contentTrigger`，默认关） | `trigger:*` |

   锚点句**只做窗口确认，不单独当触发点**（`anchorTrigger` 默认 false），否则思考里的复述会导致过早切换。
3. **控制标签在缓冲区里扣掉**：只发 `output-open` / `output-close` 结构事件，
   不进入正文拼接，也不进入工具调用解析；工具块原样保留，解析不受影响。
4. **不完整标签前缀一律扣留**：前缀集合 + Set 查找，任意切分结果一致（测试覆盖每个切点）。

### 三、实测结果（20 组 / 41 轮，deepseek-flash，官方 Beta + DSML）

- 及时切换 **40/41**，过早 0，偏晚 0，漏切 1（重 roll 即可）；
- 控制标签剥离 182 个；输出不含控制标签 41/41；剥离后无损 41/41；
- 性能：0.21–2.49 µs/push，最高约 2000 万字/秒（`npm run bench:stability`）；
- 对照四组格式要求（无包裹 → 加包裹 → 换特殊 token），
  “输出前没有任何跳出信号”从 36% 降到 7%/0%。

### 四、残余风险

- 模型整轮不输出任何控制标签（本轮 1/41）：业务侧超时兜底或人工重 roll；
- 模型把控制标签当普通文字复述：token 形式概率极低，当前数据未出现；
- 若换成“正文之外还有其他格式”的复杂预设，区域基准必须继续用输出控制标签，
  不要用 `<content>`（模型会在思考里复述它）。

### 五、接入代码

~~~js
import { createStrategyScanner } from './scripts/preset-stability-strategy.mjs';
const scanner = createStrategyScanner({ gateCloseThink: true, outputTrigger: true });
for await (const chunk of stream) {
  for (const event of scanner.push(chunk)) {
    switch (event.kind) {
      case 'thinking': break;      // 渲染思维链
      case 'end-marker': break;    // 结束思考（mode: confirmed / fallback）
      case 'output-open': break;   // 进入输出区（控制标签已扣掉）
      case 'body': break;          // 正文
      case 'tool-call': break;     // 工具调用
      case 'output-close': break;  // 输出区结束
      default: break;              // text
    }
  }
  // scanner.phase: thinking | body | tool-call | trailing
}
for (const event of scanner.finish()) { /* 收尾，吐出缓冲区剩余文本 */ }
~~~

## 流式即时处理（把输出强制切到正文/工具调用）

`scripts/preset-stability-stream.mjs` 提供 `createMarkerStreamScanner()`，用于边收流边判断：

~~~js
import { createMarkerStreamScanner } from './scripts/preset-stability-stream.mjs';
const scanner = createMarkerStreamScanner();
for (const chunk of chunks) {
  for (const event of scanner.push(chunk)) { /* thinking / end-marker / body / tool-call ... */ }
  if (scanner.phase !== 'thinking') { /* 已经切到正文或工具调用，可以改渲染路径 */ }
}
for (const event of scanner.finish()) { /* 收尾，把缓冲区剩余文本吐出来 */ }
~~~

- 不完整的标记前缀会扣留在缓冲区（约 20 字符窗口）：任意切分喂入都既不会漏判，
  也不会把半个标记当成正文发出去（测试里按 1/2/3/5/7/13/40 字符切分结果完全一致）；
- 切换信号取**最先出现**的那个：规范结束标记、`</think>` / `</thinking>` 变体、
  `<content>` 开场标签、DSML 开场标签；
- `scanner.phase` 取值 `thinking` / `body` / `tool-call` / `trailing`，
  `scanner.switchedAt` 给出切换位置，`scanner.switchKind` 说明是被哪个信号触发的。

同一模块里的 `auditTurnTools()` 只检查 DSML 原文写法（忘记换行、标签不严谨、
缺 string 标记、被代码围栏包裹、工具名拼错等），由 CLI 注入到测试循环，
统计结果出现在报告的「工具调用格式」与「流式切换检测」两节。


### 推荐策略：独占一行 + 10 token 窗口 + 正文触发

预设格式要求改成「结束标记独占一行」后，用 `scripts/preset-stability-strategy.mjs` 实测了
三种切换策略（47 轮真实输出，同一批响应离线比较）：

| 策略 | 过早切换 | 平均漏思考 | 最坏 | 漏切 |
| --- | --- | --- | --- | --- |
| A 见到第一个结束信号就切 | 12/47 | 18 字 | 100 字 | 0 |
| B A 改进版：独占一行 + 10 token 窗口 + `</think>` 立即保底 | 12/47 | 10 字 | 10 字 | 2 |
| C B 再改进：`</think>` 也过窗口 + `<content>`/DSML 触发 | **0/47** | **0 字** | **0 字** | 1 |

结论：

- 「标记独占一行」+ 10 token 窗口能干掉**大幅**早切（最坏 100 字 → 10 字），
  因为模型复述规则时通常是行内写法（`必须以 <｜end▁of▁think｜> 结束思考`）；
- 但 **`</think>` 立即保底仍然会早切**：模型常写 `</think>` 之后继续思考，
  12/30 轮里 `</think>` 后面并没有马上出现正文；
- 把 `</think>` 也放进同一个窗口，并在最后用 `<content>` / DSML 开场标签兜底，
  可以做到 0 早切、0 漏字，47/47 文本无损；
- 此时真正的触发来源是：`<content>` 触发 16 轮、`</think>` 窗口确认 13 轮、
  独立成行标记确认 14 轮、DSML 触发 1 轮、完全无信号 3 轮（这 3 轮需要业务侧兜底超时）。

用法：`scanWithStrategy(text, chunkSize, { gateCloseThink: true, outputTrigger: true })`；
`createStrategyScanner()` 另可调 `bufferTokens`（默认 10）、`charsPerToken`（默认 2）、
`bufferChars`（默认 32）、`anchor`（锚点句）与 `anchorTrigger`（默认 **false**）。

### 当前策略到底怎么算“正确处理正文”

一轮正确处理的形态（`node scripts/preset-stability-explain.mjs <transcript.json>` 可直接打印）：

| 顺序 | 输入 | 处理 |
| --- | --- | --- |
| 1 | `<think>…思维链…` | phase=thinking，文本作为 `thinking` 事件发出 |
| 2 | `</think>` 或独占一行的 `<｜end▁of▁think｜>` | 过 10 token 窗口确认后切换，记 `confirmed:*` / `fallback:close-think` |
| 3 | `<｜begin▁of▁output｜>` | 控制标签：**从缓冲区扣掉**，只发 `output-open` 结构事件 |
| 4 | `您好，这是约定的内容，请查收：` | 正文开场句，保留在输出里（锚点默认只做窗口确认） |
| 5 | `<content>正文</content>` | 正文块 |
| 6 | `<｜end▁of▁output｜>` | 扣掉，发 `output-close` |
| 7 | DSML 工具调用块 | 原样保留在输出里，交给工具解析，标签不受影响 |

实测（基准 = 输出控制标签位置，`anchorTrigger: false`）：

| 组 | 及时切换 | 过早 | 偏晚 | 漏切 |
| --- | --- | --- | --- | --- |
| C 旧 <output> | 36/37 | 0 | 0 | 1 |
| D 新 token | **45/45** | 0 | 0 | 0 |
| E 新 token + 扩缓冲 | 40/41 | 0 | 0 | 1 |

两个必须注意的坑：

- **锚点句会被复述**：把它当触发点会过早切换（D 组 8 次、E 组 7 次），默认改为只做窗口确认；
- **`<content>` 不是区域边界**：模型也会在思考里复述 `<content>`，拿它当基准会把正常切换误判成“偏晚”
  （E 组 8 次误判）。区域基准只能用输出控制标签。

另外修掉一个跨缓冲区的判定 bug：缓冲区被切分后，局部下标 0 曾被误当成“行首”，
导致行内复述的标记/锚点被当成独占一行。现在用 `atLineStart` 状态跟踪，任意切点都正确。

### 输出区标签 `\n<output>…</output>\n`

`<content>` 是正文**子区域**，预设本来就允许“正文之外的其他格式放在 `<content>` 前面”，
所以不能拿它当输出区起点。实测 42 轮：有 **30 轮** 在 `<output>` 与 `<content>` 之间还有
合法前置输出，合计 **818 字**（平均 27 字，最多 **331 字**）—— 用 `<content>` 兜底时这些字
会被错判成思维链。改成 `<output>` 兜底后：过早切换 0 轮、漏切 1 轮；再补 `<content>` 兜底
则 0 轮漏切。模型对 `<output>` 的遵守率是 33～34/37～42 轮。

触发器标签必须同时加进扣留集合（`HOLD_PATTERNS`），否则标签被切到两个 chunk 里
就永远拼不回来 —— 这个 bug 就是被“任意切分一致性”测试抓到的。

### 缓冲区与性能

- `bufferChars`（默认 **32**）是滑动窗口至少保留的尾字符数：新标签 `<｜begin▁of▁output｜>` 19 字符、
  旧变体 21 字符，留足余量后标签在任意位置被切开都能拼回来（测试逐个切点验证过）；
- 确认窗口取 `max(bufferTokens × charsPerToken, 最长标签 + 4)`，保证“标记后紧跟输出区标签”能被确认；
- 热路径优化：扣留判定改用**预计算前缀集合**（O(尾长) 次 Set 查找，替代 any/startsWith 扫描），
  确认窗口改为直接取最小值（去掉每次 filter/sort 的数组分配）；
- 基准（`node scripts/preset-stability-bench.mjs 300`，1538 字符正文轮）：

| 路径 | 切分 | µs/push | 吞吐 |
| --- | --- | --- | --- |
| 策略扫描器 | 1 字符 | 0.21 | 488 万字/s |
| 策略扫描器 | 10 字符 | 0.71 | 1398 万字/s |
| 策略扫描器 | 50 字符 | 2.49 | 1995 万字/s |
| 旧事件扫描器 | 任意 | ~3.1 | 32 万字/s（1 字符） |

缓冲区是**有上界**的：1538 字符文本、3 字符切分下最大待处理 **37 字符**，不随输出增长；
控制标签在缓冲区里被扣掉，不会进入正文拼接或工具调用解析。

### 锚点开场句实验（5×20 组对照）

> 说明：每次只有 20 组，单轮波动很大；D 与 E 只差缓冲区大小，而缓冲区**不影响模型输出**，
> 两者差异属于采样噪声，只能横向看格式要求带来的趋势。

| 组 | 轮数 | 输出区检出 | 输出前无跳出信号 | 锚点落在输出区前 |
| --- | --- | --- | --- | --- |
| A 仅独占一行标记 | 47 | 44/47（94%） | 17/47（36%） | 0 |
| B + `<output>` 包裹 | 42 | 42/42（100%） | 10/42（24%） | 0 |
| C + 锚点句 | 37 | 36/37（97%） | 4/37（11%） | 16 |
| D 新 token | 45 | 45/45（100%） | 3/45（7%） | 29 |
| E 新 token + 扩缓冲 | 41 | 41/41（100%） | 0/41（0%） | 21 |

### 锚点措辞的注意点

要求“必须以输出‘您好，这是约定的内容，请查收：’开始最终文本的生成、最终文本在 `</thinking>` 之后”
后实测（同一模型、同一任务）：

| 组 | 轮数 | 只认标记/结束标签：输出前无跳出信号 | 锚点也算（且在输出区前） | 锚点起作用的轮数 |
| --- | --- | --- | --- | --- |
| A 仅独占一行标记 | 47 | 17/47（36%） | 17/47（36%） | 0 |
| B + `<output>` 包裹 | 42 | 10/42（24%） | 10/42（24%） | 0 |
| C + 锚点开场句 | 37 | 10/37（27%） | **4/37（11%）** | **16** |

结论：

- 锚点句本身遵守率很高（32/37，86%），但**只有 16 次落在输出区之前**，
  另外 16 次被模型当成正文第一句写进了 `<content>` 里面 —— 那样只能当内容，不能当边界信号；
- 落在输出区之前时，它可以把“输出前没有任何跳出信号”的轮次从 10/37 降到 4/37，
  也就是说**可以让模型自己跳出思维链，不依赖策略兜底**；
- 要求里的 `</thinking>` 标签几乎没被遵守（2/37），模型更愿意写独占一行的标记和 `</think>`；
- 若要让锚点稳定当边界信号，措辞必须锁死位置，例如“在结束思考后、`<output>` 之前单独输出
  一行该句，且不写进 `<content>` 里”，然后再复测。

## 用法

~~~powershell
# DeepSeek 官方 Beta：前缀续写 + DSML 工具模拟（官方 Beta 不接受原生工具字段）
node scripts/preset-stability.mjs `
  --base-url https://api.deepseek.com --transport official --tools dsml `
  --api-key $env:DEEPSEEK_API_KEY --model deepseek-chat `
  --trials 5 --max-turns 4 --task weather-compare

# 第三方 OpenAI 兼容适配器：原生工具 + 末条 assistant 预填充
node scripts/preset-stability.mjs `
  --base-url https://your-adapter.example/v1 --transport adapter --tools native `
  --api-key $env:PRESET_TEST_API_KEY --model your-model `
  --trials 5 --max-turns 4 --task calc-report

# 先检查请求体、不消耗额度
node scripts/preset-stability.mjs --dry-run --tools dsml

# 用真实 ST 预设（含顺序表 / assistant_prefill / 后置 assistant 前缀）
node scripts/preset-stability.mjs --preset .\我的预设.json --tools dsml --trials 3
~~~

API key 也可以来自环境变量 `DEEPSEEK_API_KEY` 或 `PRESET_TEST_API_KEY`；
`--base-url` 默认 `https://api.deepseek.com/beta`，`--model` 默认 `deepseek-chat`。

### 主要参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--transport` | `official` | `official` 走 DeepSeek Beta 前缀续写；`adapter` 按给定地址直连 |
| `--tools` | 官方 `dsml` / 适配器 `native` | `dsml`、`native` 或 `none` |
| `--thinking` | `omit` | `omit` 不发 `thinking` 字段；`enabled` 把 `<think>` 拆进 `reasoning_content` |
| `--prefill-mode` | `prefix` | `prefix` 加 `prefix: true`；`plain` 只保留末条 assistant；`none` 不预填充（基线对照） |
| `--trials / --max-turns` | 3 / 4 | 对话组数与每组最大轮数 |
| `--task` | `weather-compare` | `weather-compare`、`calc-report`、`single-tool`、`no-tool`，可用逗号组合 |
| `--tool-turns` | 由任务决定 | 覆盖「前几轮应调用工具」的预期 |
| `--body-min / --body-max` | 1200 / 1600 | 正文字数区间 |
| `--preset` | 内置 | 换成真实 SillyTavern 预设文件 |
| `--out` | `.test-data/preset-stability/<时间戳>` | 报告目录 |
| `--fail-under` | 关闭 | 通过率低于该百分比时退出码 1（便于 CI） |
| `--timeout / --retries` | 300000 / 2 | 单次请求超时与重试次数（429/5xx/网络错误） |

## 输出

每次运行都会在 `--out` 目录落盘三份文件：

- `report.md`：人读汇总（总体通过率、逐项检查、分阶段、字数分布、失败明细）；
- `report.json`：`meta` + `summary`，便于二次统计或画图；
- `transcript.json`：每组每轮的请求体、响应体、判定结果与片段，便于复盘失败样本。

终端同时打印同一份文本报告；每组每轮还会实时打印一行 `[PASS]/[FAIL]` 进度。

退出码：`0` 正常；`1` 触发 `--fail-under`；`2` 参数错误、缺少 API key 或请求失败。

## 自检

`tests/preset-stability.test.mjs` 对请求构造、响应还原、判定规则、统计汇总和工具循环做了断言，
不需要 API key：

~~~powershell
node --test tests/preset-stability.test.mjs
~~~
