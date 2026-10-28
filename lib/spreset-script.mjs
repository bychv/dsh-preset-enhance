import { getQuickJS } from 'quickjs-emscripten';
const LIMIT = 2 * 1024 * 1024;
/** Pure JavaScript only: no host objects, module loader, filesystem or network. */
export async function runSPresetScript(expression, input, signal) {
    signal?.throwIfAborted();
    if (expression.length > 256 * 1024)
        throw new Error('SPreset 脚本超过大小限制');
    const json = JSON.stringify(input);
    if (json.length > LIMIT)
        throw new Error('SPreset 脚本输入超过大小限制');
    const engine = await getQuickJS();
    signal?.throwIfAborted();
    const runtime = engine.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    const deadline = Date.now() + 150;
    runtime.setInterruptHandler(() => Date.now() > deadline || signal?.aborted === true);
    const vm = runtime.newContext();
    try {
        const promise = vm.unwrapResult(vm.evalCode(`
      globalThis.console = Object.freeze({ log(){}, info(){}, warn(){}, error(){}, debug(){} });
      (async () => {
        const input = JSON.parse(${JSON.stringify(json)});
        const value = await (${expression});
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw Error('脚本必须返回可序列化的值');
        return encoded;
      })()
    `));
        try {
            for (let jobs = 0; jobs < 128; jobs++) {
                const state = vm.getPromiseState(promise);
                if (state.type === 'fulfilled') {
                    try {
                        const result = vm.getString(state.value);
                        if (result.length > LIMIT)
                            throw new Error('SPreset 脚本输出超过大小限制');
                        signal?.throwIfAborted();
                        return JSON.parse(result);
                    }
                    finally {
                        state.value.dispose();
                    }
                }
                if (state.type === 'rejected') {
                    try {
                        throw new Error('SPreset 脚本失败：' + String(vm.dump(state.error)?.message ?? '运行错误'));
                    }
                    finally {
                        state.error.dispose();
                    }
                }
                if (Date.now() > deadline || signal?.aborted)
                    throw new Error('SPreset 脚本已取消或超时');
                const count = vm.unwrapResult(runtime.executePendingJobs(1));
                if (!count)
                    throw new Error('SPreset 不支持等待外部异步操作');
            }
            throw new Error('SPreset 脚本任务超过限制');
        }
        finally {
            promise.dispose();
        }
    }
    finally {
        vm.dispose();
        runtime.dispose();
    }
}
export const scriptFunction = (source) => {
    if (typeof source !== 'string' || !source.trim())
        throw new Error('SPreset 脚本不能为空');
    return '(' + source.trim().replace(/;\s*$/, '') + ')';
};
