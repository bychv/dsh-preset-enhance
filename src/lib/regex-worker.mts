/**
 * Terminable worker entry for prompt-side regex.
 *
 * Runs pure computation only: it never touches the store, the host services or the session log.
 * The main thread blocks on a shared control word, so a runaway rule can be terminated with
 * worker.terminate() instead of freezing the host.
 */
import { parentPort } from 'node:worker_threads';
import { createMacroContext } from './macros.mjs';
import { planRegexScript, regexName, runRegexScriptDetailed } from './prompt-regex.mjs';
import type { MacroContext, RegexScript, RegexWorkerReply, RegexWorkerTask } from './types.mjs';

/** The reply channel the main thread handed over with the task. */
interface ReplyPort {
  postMessage(value: RegexWorkerReply): void;
}

/**
 * One preparation: every matchable run of a single compilation, in rule-major order so a timeout can
 * name the rule that was running. The main thread owns the depths and targets; this side only decides
 * applicability and rewrites text.
 */
function handle(message: { task: RegexWorkerTask; port: ReplyPort }): void {
  const task = message.task;
  const reply = message.port;
  const control = new Int32Array(task.control);
  let rule = '';
  try {
    const ctx: MacroContext = createMacroContext({ local: task.local, global: task.global, values: task.values, seed: task.seed });
    // Continue the main thread's macro random stream exactly where it stopped, so a preview and the
    // real request see the same values.
    for (let index = 0; index < task.draws; index++) ctx.random();
    const texts = task.segments.map(segment => segment.text);
    const applied: string[] = [];
    let replacements = 0;
    let outputChars = texts.reduce((total, text) => total + text.length, 0);
    for (let ruleIndex = 0; ruleIndex < task.scripts.length; ruleIndex++) {
      const script = task.scripts[ruleIndex] as RegexScript;
      Atomics.store(control, 1, ruleIndex);
      rule = regexName(script);
      for (let index = 0; index < task.segments.length; index++) {
        const segment = task.segments[index];
        if (segment === undefined) continue;
        const plan = planRegexScript(script, segment.depth);
        if (!plan.runs || !plan.targets.includes(segment.target)) continue;
        const before = texts[index] ?? '';
        const result = runRegexScriptDetailed(before, script, ctx);
        if (!result.matched) continue;
        replacements += result.replacements;
        if (replacements > task.limits.maxReplacements) throw new Error('替换次数超过上限 ' + task.limits.maxReplacements);
        outputChars += result.text.length - before.length;
        if (outputChars > task.limits.maxOutputChars) throw new Error('正则处理后文本超过 ' + task.limits.maxOutputChars + ' 字符');
        texts[index] = result.text;
        if (!applied.includes(rule)) applied.push(rule);
      }
    }
    reply.postMessage({ ok: true, texts, applied, local: { ...ctx.local }, global: { ...ctx.global },
      draws: ctx.draws, warnings: [...ctx.warnings], replacements });
  } catch (error) {
    reply.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), rule });
  } finally {
    // The main thread reads this slot after its wait returns; slot 1 names the rule that was running
    // when a timeout fired.
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
  }
}

parentPort?.on('message', (message: { task: RegexWorkerTask; port: ReplyPort }) => { handle(message); });
