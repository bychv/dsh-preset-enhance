#!/usr/bin/env node
/**
 * 预设稳定性测试脚本（真实模型 / 非流式）。
 *
 * 目的：验证“思考预设”的契约稳定性 —— 模型每次在回答正文前、在工具调用前，
 * 是否都恰好输出了一次结束思考标记 <｜end▁of▁thinkings｜>。
 *
 * 典型用法：
 *   node scripts/preset-stability.mjs \
 *     --base-url https://api.deepseek.com/beta --api-key $env:DEEPSEEK_API_KEY \
 *     --model deepseek-chat --transport official --tools dsml \
 *     --trials 5 --max-turns 4 --task weather-compare
 *
 * 说明：
 *   - 请求构造完全对齐本仓库 lib/deepseek-beta.mjs + lib/toolcall-prefill.mjs：
 *     末条 assistant 预填充续写（prefix:true）、<think> 前缀拆进 reasoning_content、
 *     DSML 工具模拟（官方 Beta 不接受原生工具字段）。
 *   - 脚本内置 4 个虚拟工具（get_weather / search_notes / calculate / get_current_time），
 *     模型真实调用它们，脚本用确定性假数据返回结果，再让模型继续论证 / 写作。
 *   - 只使用非流式响应；每次请求都会记录完整统计。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  auditTurnTools,
  scanTextStream,
} from './preset-stability-stream.mjs';
import {
  VIRTUAL_TOOLS,
  TASKS,
  findTask,
  createSyntheticPreset,
  createCompiledPreset,
  runTrials,
  renderTextReport,
  renderMarkdownReport,
} from './preset-stability-core.mjs';

const HELP = [
  '用法: node scripts/preset-stability.mjs [选项]',
  '',
  '接口',
  '  --base-url <url>       API 地址，默认 https://api.deepseek.com/beta',
  '  --api-key <key>        API key；缺省依次读 DEEPSEEK_API_KEY / PRESET_TEST_API_KEY',
  '  --model <name>         模型名，默认 deepseek-chat',
  '  --transport <kind>     official | adapter，默认 official（official 会补 /beta 路径）',
  '  --tools <kind>         dsml | native | none，默认 official=dsml / adapter=native',
  '  --thinking <kind>      omit | enabled | disabled，默认 omit（不发送 thinking 字段）',
  '  --prefill-mode <kind>  prefix | plain | none，默认 prefix（assistant 预填充续写）',
  '  --temperature <n>      采样温度（可选）',
  '  --max-tokens <n>       最大输出 token（可选）',
  '',
  '样本',
  '  --trials <n>           对话组数，默认 3',
  '  --max-turns <n>        每组最多几轮助手输出，默认 4',
  '  --task <id>            任务；可重复传或用逗号分隔，默认 weather-compare',
  '                         可选: ' + TASKS.map(task => task.id).join(', '),
  '  --tool-turns <n>       覆盖“前几轮应当调用工具”的预期（默认由任务决定）',
  '  --body-min <n>         正文字数下限，默认 1200',
  '  --body-max <n>         正文字数上限，默认 1600',
  '  --preset <file>        改用真实 SillyTavern 预设（.json 或 .dsh-preset.json）',
  '  --character-id <n>     prompt_order 的 character_id，默认自动选择（优先 100001）',
  '  --post-tool-prefix <t> 工具结果后继续请求使用的预填充文本，默认继承预设',
  '',
  '输出',
  '  --out <dir>            报告目录，默认 .test-data/preset-stability/<时间戳>',
  '  --json                 额外把汇总以 JSON 打到 stdout',
  '  --quiet                只输出最终报告',
  '  --dry-run              只打印第一轮请求体，不真正调用接口',
  '  --fail-under <pct>     通过率低于该百分比时以退出码 1 结束',
  '  --timeout <ms>         单次请求超时，默认 300000',
  '  --retries <n>          429/5xx/网络错误重试次数，默认 2',
  '  --help                 显示本帮助',
].join('\n');

function die(message, code) {
  console.error('错误: ' + message);
  process.exit(code == null ? 2 : code);
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { flags._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const camel = name.replace(/-([a-z])/g, (match, char) => char.toUpperCase());
    if (eq >= 0) { flags[camel] = arg.slice(eq + 1); continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[camel] = next; index += 1; }
    else flags[camel] = true;
  }
  return flags;
}

function num(flags, name, fallback) {
  const value = flags[name];
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) die('选项 --' + name.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ' 需要数字，收到: ' + value);
  return parsed;
}

function resolveEndpoint(baseUrl, transport) {
  let url;
  try { url = new URL(baseUrl); } catch { die('base-url 不是合法 URL: ' + baseUrl); }
  if (transport === 'official') {
    if (url.hostname === 'api.deepseek.com' && !url.pathname.startsWith('/beta')) {
      url.pathname = '/beta' + (url.pathname === '/' ? '' : url.pathname);
    }
  }
  if (!/\/chat\/completions\/?$/u.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/+$/u, '') + '/chat/completions';
  }
  return url.toString();
}

function delay(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }

function createHttpCallModel(config) {
  let requests = 0;
  const callModel = async function callModel(context) {
    requests += 1;
    const payload = JSON.stringify(context.wire.body);
    let lastError = null;
    for (let attempt = 0; attempt <= config.retries; attempt += 1) {
      if (attempt > 0) await delay(Math.min(8000, 500 * Math.pow(2, attempt)));
      try {
        const response = await fetch(config.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + config.apiKey,
            accept: 'application/json',
          },
          body: payload,
          signal: AbortSignal.timeout(config.timeout),
        });
        const text = await response.text();
        if (!response.ok) {
          const retriable = response.status === 429 || response.status === 408 || response.status >= 500;
          lastError = new Error('HTTP ' + response.status + ' ' + text.slice(0, 400));
          if (retriable && attempt < config.retries) {
            if (!config.quiet) console.error('  ! 第 ' + (attempt + 1) + ' 次请求失败（' + response.status + '），准备重试');
            continue;
          }
          throw lastError;
        }
        try { return JSON.parse(text); } catch { throw new Error('响应不是合法 JSON: ' + text.slice(0, 300)); }
      } catch (error) {
        lastError = error;
        const network = !(error && error.message && error.message.indexOf('HTTP ') === 0);
        if (network && attempt < config.retries) {
          if (!config.quiet) console.error('  ! 请求异常（' + String((error && error.message) || error).slice(0, 200) + '），准备重试');
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('请求失败');
  };
  callModel.stats = () => ({ requests });
  return callModel;
}

async function loadPreset(file, config) {
  let text;
  try {
    text = await readFile(resolve(file), 'utf8');
  } catch (error) {
    die('无法读取预设文件 ' + file + '：' + String((error && error.code) || (error && error.message) || error));
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { die('预设文件不是合法 JSON: ' + error.message); }
  const preset = parsed && parsed.format === 'dsh-preset-enhance' && parsed.preset ? parsed.preset.data : parsed;
  if (!preset || !Array.isArray(preset.prompts)) die('预设文件缺少 prompts 数组: ' + file);
  const groups = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
  const ids = groups.map(group => group && group.character_id).filter(id => id != null);
  const characterId = config.characterId === undefined || config.characterId === true
    ? (ids.indexOf(100001) >= 0 ? 100001 : (ids.length > 0 ? ids[0] : null))
    : Number(config.characterId);
  return createCompiledPreset(preset, {
    name: (parsed.metadata && parsed.metadata.name) || file,
    characterId,
    postToolPrefix: config.postToolPrefix,
  });
}

function shortJson(value, limit) {
  const text = JSON.stringify(value, null, 2);
  return text.length > limit ? text.slice(0, limit) + '\n…（已截断，共 ' + text.length + ' 字符）' : text;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(HELP); return; }

  const transport = flags.transport || 'official';
  if (['official', 'adapter'].indexOf(transport) < 0) die('transport 只能是 official 或 adapter');
  const toolsMode = flags.tools || (transport === 'official' ? 'dsml' : 'native');
  if (['dsml', 'native', 'none'].indexOf(toolsMode) < 0) die('tools 只能是 dsml、native 或 none');
  const thinking = flags.thinking || 'omit';
  if (['omit', 'enabled', 'disabled'].indexOf(thinking) < 0) die('thinking 只能是 omit、enabled 或 disabled');
  const prefixMode = flags.prefillMode || 'prefix';
  if (['prefix', 'plain', 'none'].indexOf(prefixMode) < 0) die('prefill-mode 只能是 prefix、plain 或 none');

  const apiKey = flags.apiKey || process.env.DEEPSEEK_API_KEY || process.env.PRESET_TEST_API_KEY || '';
  const model = flags.model || process.env.PRESET_TEST_MODEL || 'deepseek-chat';
  const baseUrl = flags.baseUrl || process.env.PRESET_TEST_BASE_URL || 'https://api.deepseek.com/beta';
  const endpoint = resolveEndpoint(baseUrl, transport);
  const trialsCount = Math.max(1, Math.floor(num(flags, 'trials', 3)));
  const maxTurns = Math.max(1, Math.floor(num(flags, 'maxTurns', 4)));
  const bodyMin = Math.max(0, Math.floor(num(flags, 'bodyMin', 1200)));
  const bodyMax = Math.max(bodyMin, Math.floor(num(flags, 'bodyMax', 1600)));
  const timeout = Math.max(1000, Math.floor(num(flags, 'timeout', 300000)));
  const retries = Math.max(0, Math.floor(num(flags, 'retries', 2)));
  const temperature = flags.temperature === undefined ? undefined : num(flags, 'temperature', 1);
  const maxTokens = flags.maxTokens === undefined ? undefined : Math.floor(num(flags, 'maxTokens', 4096));
  const quiet = flags.quiet === true;
  const asJson = flags.json === true;
  const dryRun = flags.dryRun === true;

  const requested = String(flags.task || 'weather-compare').split(',').map(value => value.trim()).filter(Boolean);
  const tasks = requested.map(id => {
    const task = findTask(id);
    if (!task) die('未知任务 id: ' + id + '（可用: ' + TASKS.map(item => item.id).join(', ') + '）');
    if (flags.toolTurns !== undefined) {
      const planned = Math.max(0, Math.floor(num(flags, 'toolTurns', task.calls.length)));
      return Object.assign({}, task, { calls: task.calls.slice(0, planned) });
    }
    return task;
  });

  const preset = flags.preset
    ? await loadPreset(flags.preset, { postToolPrefix: flags.postToolPrefix, characterId: flags.characterId })
    : createSyntheticPreset();
  const tools = toolsMode === 'none' ? [] : VIRTUAL_TOOLS;

  const options = {
    trials: trialsCount,
    maxTurns,
    bodyMin,
    bodyMax,
    temperature,
    maxTokens,
    transport,
    toolsMode,
    thinking,
    prefixMode,
    model,
    tasks,
    tools,
    preset,
    auditTools: auditTurnTools,
    scanStream: scanTextStream,
  };

  const meta = {
    presetName: preset.name,
    endpoint,
    transport,
    toolsMode,
    thinking,
    prefixMode,
    model,
    maxTurns,
    taskIds: tasks.map(task => task.id).join(','),
    trials: trialsCount,
    bodyMin,
    bodyMax,
    startedAt: new Date().toISOString(),
  };

  if (dryRun) {
    const core = await import('./preset-stability-core.mjs');
    const messages = preset.build([]);
    const wire = core.buildWireRequest({
      messages, tools, transport, toolsMode, thinking, prefixMode, model, temperature, maxTokens,
    });
    console.log('== 预填充消息（已注入预设） ==');
    messages.forEach((message, index) => {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      console.log('[' + index + '] ' + message.role + (message.prefix ? ' (prefix)' : '') + ': ' + text.slice(0, 160).replace(/\n/gu, '\\n'));
    });
    console.log('');
    console.log('== 实际请求体 ==');
    console.log(shortJson(wire.body, 12000));
    console.log('');
    console.log('endpoint: ' + endpoint);
    console.log('contentPrefix: ' + JSON.stringify(wire.contentPrefix));
    console.log('reasoningPrefix: ' + JSON.stringify(wire.reasoningPrefix));
    return;
  }

  if (!apiKey) {
    die('缺少 API key：请传 --api-key，或设置环境变量 DEEPSEEK_API_KEY / PRESET_TEST_API_KEY。\n' +
      '      想先检查请求构造，可用 --dry-run。');
  }

  const callModel = createHttpCallModel({ endpoint, apiKey, timeout, retries, quiet });
  let turnCounter = 0;
  options.onRecord = record => {
    turnCounter += 1;
    if (quiet) return;
    const flag = record.ok ? 'PASS' : 'FAIL';
    console.log('  [' + flag + '] 第 ' + (record.trial + 1) + ' 组第 ' + record.turn + ' 轮 ' + record.phase +
      ' · 标记 ' + record.markerCount + ' 次 · 正文 ' + record.bodyChars + ' 字' +
      (record.toolCallCount > 0 ? ' · 工具 ' + record.toolCallNames.join(',') : '') +
      (record.ok ? '' : ' · ' + record.reason));
  };

  if (!quiet) {
    console.log('开始测试：' + endpoint);
    console.log('模型 ' + model + ' · 传输 ' + transport + ' · 工具 ' + toolsMode + ' · 思考 ' + thinking +
      ' · 预填充 ' + prefixMode + ' · ' + trialsCount + ' 组 × 最多 ' + maxTurns + ' 轮');
  }

  let result;
  try {
    result = await runTrials(options, callModel);
  } catch (error) {
    die('测试中断: ' + String((error && error.message) || error));
  }

  meta.finishedAt = new Date().toISOString();
  meta.requests = callModel.stats().requests;
  const textReport = renderTextReport(result.summary, meta);
  const markdown = renderMarkdownReport(result.summary, meta);

  const outDir = resolve(flags.out || join('.test-data', 'preset-stability', meta.startedAt.replace(/[:.]/gu, '-')));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.md'), markdown, 'utf8');
  await writeFile(join(outDir, 'report.json'), JSON.stringify({ meta, summary: result.summary }, null, 2), 'utf8');
  await writeFile(join(outDir, 'transcript.json'), JSON.stringify({
    meta,
    trials: result.trials.map(trial => ({
      index: trial.index,
      taskId: trial.taskId,
      records: trial.records.map(record => ({
        turn: record.turn,
        phase: record.phase,
        ok: record.ok,
        failed: record.failed,
        reason: record.reason,
        checks: record.checks,
        markerCount: record.markerCount,
        markerRegion: record.markerRegion,
        lenientOk: record.lenientOk,
        markerVariants: record.markerVariants,
        closeThinkMarks: record.closeThinkMarks,
        bodyChars: record.bodyChars,
        cjkChars: record.cjkChars,
        toolCallNames: record.toolCallNames,
        toolCallExpected: record.toolCallExpected,
        requestSummary: record.requestSummary,
        text: record.text,
        toolFormat: record.toolFormat,
        stream: record.stream,
        segments: record.segmentPreview,
        enteredThinking: record.enteredThinking,
        thinkingChars: record.thinkingChars,
        bodyBlocks: record.bodyBlocks,
        extrasChars: record.extrasChars,
        excerpt: record.excerpt,
        preview: record.preview,
        requestBody: record.requestBody,
        responseBody: record.responseBody,
      })),
    })),
  }, null, 2), 'utf8');

  console.log('');
  console.log(textReport);
  console.log('报告目录: ' + outDir);
  console.log('  report.md / report.json / transcript.json');
  if (asJson) console.log(JSON.stringify({ meta, summary: result.summary }, null, 2));

  const failUnder = flags.failUnder === undefined ? null : num(flags, 'failUnder', 0);
  if (failUnder !== null && result.summary.passRate !== null && result.summary.passRate < failUnder) {
    console.error('通过率 ' + result.summary.passRate + '% 低于阈值 ' + failUnder + '%');
    process.exitCode = 1;
  }
}

main().catch(error => die(String((error && error.stack) || error)));
