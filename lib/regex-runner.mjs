/**
 * Synchronous, terminable front end for the prompt-side regex worker.
 *
 * The compile entry is synchronous and runs inside a state transaction, so the worker is driven with
 * a shared control word and Atomics.wait instead of an async boundary: the caller keeps its shape,
 * and a rule that never returns is terminated rather than allowed to freeze the host.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
export const REGEX_DEFAULT_TIMEOUT_MS = 2000;
export const REGEX_DEFAULT_MAX_RULES = 200;
export const REGEX_DEFAULT_MAX_SEGMENT_CHARS = 512 * 1024;
export const REGEX_DEFAULT_MAX_TOTAL_CHARS = 2 * 1024 * 1024;
export const REGEX_DEFAULT_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
export const REGEX_DEFAULT_MAX_REPLACEMENTS = 20000;
const CONTROL_SLOTS = 2;
function limitsOf(options) {
    return {
        timeoutMs: options.timeoutMs ?? REGEX_DEFAULT_TIMEOUT_MS,
        maxRules: options.maxRules ?? REGEX_DEFAULT_MAX_RULES,
        maxSegmentChars: options.maxSegmentChars ?? REGEX_DEFAULT_MAX_SEGMENT_CHARS,
        maxTotalChars: options.maxTotalChars ?? REGEX_DEFAULT_MAX_TOTAL_CHARS,
        maxOutputChars: options.maxOutputChars ?? REGEX_DEFAULT_MAX_OUTPUT_CHARS,
        maxReplacements: options.maxReplacements ?? REGEX_DEFAULT_MAX_REPLACEMENTS,
    };
}
class WorkerRegexRunner {
    worker = null;
    limits;
    url;
    constructor(options) {
        this.limits = limitsOf(options);
        // The built worker sits beside this module in lib/, so the plugin ships both together.
        this.url = new URL('./regex-worker.mjs', import.meta.url);
    }
    /** Spawn on first use and after a terminated worker, so one bad rule cannot poison later runs. */
    ensureWorker() {
        if (this.worker)
            return this.worker;
        const worker = new Worker(this.url);
        // An unhandled worker error must not crash the host: the next run respawns.
        worker.on('error', () => { if (this.worker === worker)
            this.worker = null; });
        worker.on('exit', () => { if (this.worker === worker)
            this.worker = null; });
        worker.unref();
        this.worker = worker;
        return worker;
    }
    discard() {
        const worker = this.worker;
        this.worker = null;
        if (worker)
            void worker.terminate();
    }
    run(preparation) {
        const scripts = preparation.scripts;
        if (scripts.length === 0) {
            return { texts: preparation.segments.map(segment => segment.text), applied: [], local: { ...preparation.local },
                global: { ...preparation.global }, draws: preparation.draws, warnings: [], replacements: 0 };
        }
        if (scripts.length > this.limits.maxRules)
            throw new Error('正则规则数 ' + scripts.length + ' 超过上限 ' + this.limits.maxRules);
        if (preparation.seed === undefined)
            throw new Error('没有确定性种子，无法在 worker 中重放宏随机状态，因此不执行正则规则');
        let total = 0;
        for (const segment of preparation.segments) {
            if (segment.text.length > this.limits.maxSegmentChars)
                throw new Error('单条文本超过 ' + this.limits.maxSegmentChars + ' 字符，未执行正则规则');
            total += segment.text.length;
        }
        if (total > this.limits.maxTotalChars)
            throw new Error('文本总量超过 ' + this.limits.maxTotalChars + ' 字符，未执行正则规则');
        const control = new Int32Array(new SharedArrayBuffer(CONTROL_SLOTS * 4));
        Atomics.store(control, 0, 0);
        Atomics.store(control, 1, -1);
        const { port1, port2 } = new MessageChannel();
        const task = { ...preparation, limits: this.limits, control: control.buffer };
        try {
            this.ensureWorker().postMessage({ task, port: port2 }, [port2]);
        }
        catch (error) {
            this.discard();
            throw new Error('正则执行未能启动：' + (error instanceof Error ? error.message : String(error)));
        }
        const status = Atomics.wait(control, 0, 0, this.limits.timeoutMs);
        const reply = receiveMessageOnPort(port1)?.message;
        port1.close();
        if (status === 'timed-out') {
            const index = Atomics.load(control, 1);
            const running = index >= 0 ? scripts[index] : undefined;
            const name = running && typeof running.scriptName === 'string' && running.scriptName.trim()
                ? running.scriptName.trim()
                : (index >= 0 ? '第 ' + (index + 1) + ' 条规则' : '未知规则');
            this.discard();
            throw new Error('正则执行超时（超过 ' + this.limits.timeoutMs + 'ms）：规则「' + name + '」，已终止本次处理且未发送改写结果');
        }
        if (reply === undefined) {
            this.discard();
            throw new Error('正则执行未返回结果，已终止本次处理且未发送改写结果');
        }
        if (!reply.ok) {
            if (typeof reply.error === 'string' && reply.error.includes('超过'))
                this.discard();
            throw new Error('正则规则「' + reply.rule + '」执行失败：' + reply.error);
        }
        return { texts: reply.texts ?? [], applied: reply.applied ?? [], local: reply.local ?? {}, global: reply.global ?? {},
            draws: reply.draws ?? preparation.draws, warnings: reply.warnings ?? [], replacements: reply.replacements ?? 0 };
    }
    dispose() {
        this.discard();
    }
}
let shared = null;
/** The one runner a plugin instance uses, so previews and real requests share the same limits. */
export function getRegexRunner() {
    shared ??= new WorkerRegexRunner({});
    return shared;
}
/** Called on plugin teardown: a terminated worker cannot outlive its plugin. */
export function disposeRegexRunner() {
    shared?.dispose();
    shared = null;
}
export function createRegexRunner(options = {}) {
    return new WorkerRegexRunner(options);
}
