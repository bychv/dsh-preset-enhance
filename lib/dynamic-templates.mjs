import { createHash, randomUUID } from 'node:crypto';
import { isUserAuthored } from './compaction.mjs';
import { validateHistoryPatches } from './history-patches.mjs';
import { conversationText, projectConversationMessage, DYNAMIC_PREFILL_ID } from './external-prefill.mjs';
import { getOrder } from './preset.mjs';
import { resolveTemplateBindings, templateBindings } from './template-bindings.mjs';
const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            freeze(child);
    }
    return value;
};
const activationIds = new WeakMap();
function activationId(signal) {
    let id = activationIds.get(signal);
    if (!id)
        activationIds.set(signal, id = randomUUID());
    return id;
}
/** No store lock, no write or cross-request memoization. One shared immutable input per preparation. */
export async function prepareDynamicTemplates(registry, preset, history, options) {
    const catalog = options.templateCatalog ?? registry.service.list();
    const prompts = new Map(preset.prompts.map(p => [p.identifier, p]));
    const ids = new Set(getOrder(preset, options.characterId).filter(item => item.enabled &&
        (!prompts.get(item.identifier)?.injection_trigger?.length || prompts.get(item.identifier).injection_trigger.includes(options.trigger ?? 'normal'))).map(item => item.identifier));
    const refs = templateBindings(preset, catalog);
    const work = [...ids].filter(id => refs[id]?.mode === 'linked-dynamic');
    const bodies = Object.create(null);
    if (!work.length)
        return { catalog, bodies, assertAvailable() { } };
    const references = resolveTemplateBindings(preset, catalog, ids).references;
    // Pin the registration leases too: a reload must not mix old and new callbacks in one request.
    const leases = new Map(work.map(id => {
        const ref = refs[id];
        const template = catalog.providers.find(p => p.providerId === ref.providerId)?.templates.find(t => t.id === ref.templateId && t.version === ref.templateVersion);
        return [id, { template, runtime: template?.dynamic ? registry.resolver(ref.providerId, template.dynamic.resolverId) : undefined }];
    }));
    const needsHistory = work.some(id => leases.get(id)?.template?.dynamic?.input === 'history');
    const ordinary = work.filter(id => !leases.get(id)?.template?.dynamic?.prefill);
    const generators = work.filter(id => leases.get(id)?.template?.dynamic?.prefill);
    const copied = needsHistory ? freeze(structuredClone(history)) : undefined;
    // A compaction checkpoint is not user input: latestUser/userText must not become a
    // summary. The checkpoint stays in the history a 'history' resolver receives.
    const needsLatest = ordinary.some(id => leases.get(id)?.template?.dynamic?.input !== 'conversation-text');
    const latest = needsLatest ? (copied ?? history).findLast(m => isUserAuthored(m) && !m.content?.some(b => b.type === 'tool-result')) : undefined;
    const latestUser = latest ? copied ? latest : freeze(structuredClone(latest)) : undefined;
    const userText = latestUser?.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') ?? '';
    const dialogue = ordinary.some(id => leases.get(id)?.template?.dynamic?.input === 'conversation-text')
        ? history.flatMap(message => {
            const row = projectConversationMessage(message);
            return row ? [row] : [];
        })
        : undefined;
    const textInput = dialogue && {
        conversationText: freeze(dialogue.filter(row => row.text.length > 0)),
        userText: dialogue.findLast(row => row.role === 'user')?.text ?? '',
    };
    const variables = ordinary.length ? freeze(structuredClone({ local: options.local ?? {}, global: options.global ?? {}, values: options.values ?? {} }))
        : freeze({ local: {}, global: {}, values: {} });
    const historyRevision = createHash('sha256').update(JSON.stringify(history)).digest('hex');
    const requestId = options.requestId ?? randomUUID();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('动态模板解析超时')), options.timeoutMs ?? 5000);
    let cursor = 0, total = 0;
    const worker = async () => {
        while (cursor < ordinary.length) {
            const id = ordinary[cursor++], ref = refs[id];
            options.signal?.throwIfAborted();
            try {
                const invalid = references.find(r => r.identifier === id)?.reason;
                if (invalid)
                    throw new Error(invalid);
                if (ref.config !== undefined && (ref.config === null || typeof ref.config !== 'object' || Array.isArray(ref.config) || JSON.stringify(ref.config).length > 20_000))
                    throw new Error('动态模板配置必须是最多 20,000 字符的 JSON 对象');
                const { template, runtime } = leases.get(id);
                if (!runtime)
                    throw new Error('动态模板解析器不可用');
                const signal = AbortSignal.any([deadline.signal, runtime.signal, ...(options.signal ? [options.signal] : [])]);
                signal.throwIfAborted();
                const input = template.dynamic.input;
                const context = Object.freeze({ sessionId: options.sessionId ?? '', requestId, historyRevision, presetId: options.presetId,
                    identifier: id, mode: options.mode ?? '', protocol: options.protocol ?? 'unknown', purpose: options.purpose,
                    ...(input === 'conversation-text' && textInput ? textInput : {
                        latestUser, userText, ...(input === 'history' ? { history: copied } : {}),
                    }), variables,
                    config: freeze(structuredClone(ref.config ?? {})), signal });
                const text = await resolveWithSignal(runtime.run, context);
                signal.throwIfAborted();
                if (template?.dynamic?.output === 'history-patches') {
                    const patches = validateHistoryPatches(text, history);
                    const size = patches.reduce((sum, patch) => sum + patch.text.length, 0);
                    if (total + size > 2_000_000)
                        throw new Error('动态正文总量超过 2 MB');
                    total += size;
                    bodies[id] = { patches };
                    continue;
                }
                if (typeof text !== 'string' || text.length > 200_000)
                    throw new Error('动态正文必须是最多 200,000 字符的文本');
                if (total + text.length > 2_000_000)
                    throw new Error('动态正文总量超过 2 MB');
                total += text.length;
                bodies[id] = { text };
            }
            catch (error) {
                options.signal?.throwIfAborted();
                const reason = error instanceof Error ? error.message : '动态解析失败';
                if (ref.failurePolicy !== 'skip') {
                    deadline.abort(error);
                    throw new Error(`动态模板「${prompts.get(id)?.name ?? id}」：${reason}`);
                }
                bodies[id] = { reason };
            }
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(4, ordinary.length) }, worker));
    }
    finally {
        clearTimeout(timer);
        deadline.abort(new Error('动态模板准备已结束'));
    }
    const leasesToCheck = [];
    for (const id of generators) {
        const ref = refs[id];
        const { template, runtime } = leases.get(id);
        const config = template.dynamic.prefill;
        const prefill = options.prefill;
        const phase = options.purpose === 'preview' ? 'preview' : prefill?.phase ?? 'unknown';
        const invalid = references.find(r => r.identifier === id)?.reason;
        const skipped = (reason) => { bodies[id] = { prefillStatus: 'skipped', reason }; };
        if (invalid) {
            skipped(invalid);
            continue;
        }
        if (!prefill?.enabled || options.protocol !== 'chat-completions') {
            skipped('当前连接未启用 Chat 预填充');
            continue;
        }
        if (phase === 'unknown') {
            skipped('宿主未确认当前请求的轮次');
            continue;
        }
        if (phase === 'continuation') {
            bodies[id] = { prefillStatus: 'fallback', continuation: true, notice: '工具续轮沿用预填充配置' };
            continue;
        }
        if (phase === 'preview' && !prefill.allowPreview) {
            skipped('等待实际发送或授权解析预览');
            continue;
        }
        const tailRole = prefill.tail ? prefill.tail(bodies) : history.at(-1)?.role;
        if (tailRole === 'assistant' || (config.requireUserTail && tailRole !== 'user'))
            throw new Error('出站消息末尾与动态预填充约束冲突');
        const controller = new AbortController();
        const timeoutError = new Error('动态预填充解析超时');
        const timeout = setTimeout(() => controller.abort(timeoutError), config.timeoutMs ?? 5000);
        let unwatch;
        try {
            if (!runtime)
                throw new Error('动态预填充解析器不可用');
            const leaseSignals = [runtime.signal, ...(prefill.turnSignal ? [prefill.turnSignal] : [])];
            const dependency = new AbortController();
            unwatch = prefill.watch?.(() => dependency.abort(new Error('动态解析期间预设、变量或会话已变化，请重新发送')));
            const signal = AbortSignal.any([controller.signal, dependency.signal, ...leaseSignals, ...(options.signal ? [options.signal] : [])]);
            const turns = freeze(conversationText(history, config.turns ?? 4, config.maxChars ?? 24_000));
            const rawConfig = ref.config ?? {};
            if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig) || JSON.stringify(rawConfig).length > 20_000)
                throw new Error('动态模板配置无效');
            const reuseKey = phase === 'first' ? createHash('sha256').update(JSON.stringify([
                activationId(runtime.signal), options.sessionId, prefill.turnId, prefill.step, historyRevision, options.presetId,
                prefill.bindingKey, options.mode, options.protocol, prefill.target, tailRole, ref.fingerprint, rawConfig,
            ])).digest('hex') : undefined;
            const context = Object.freeze({
                sessionId: options.sessionId ?? '', requestId, historyRevision, presetId: options.presetId, identifier: DYNAMIC_PREFILL_ID,
                mode: options.mode ?? '', protocol: options.protocol, purpose: options.purpose, userText: turns.at(-1)?.filter(row => row.role === 'user').map(row => row.text).join('\n') ?? '',
                prefill: Object.freeze({ phase, turnId: phase === 'first' ? prefill.turnId : undefined, step: prefill.step, reuseKey,
                    turns, tailRole, target: prefill.target, revision: prefill.revision }),
                variables: freeze({ local: {}, global: {}, values: {} }), config: freeze(structuredClone(rawConfig)), signal,
            });
            const result = await resolveWithSignal(runtime.run, context);
            const value = typeof result === 'string' ? { status: 'generated', text: result } : result;
            if (value && 'status' in value && (value.status === 'fallback' || value.status === 'skipped')) {
                bodies[id] = { prefillStatus: value.status, notice: value.status === 'fallback' ? '使用原静态前缀' : '提供者跳过动态预填充' };
            }
            else if (value && 'status' in value && value.status === 'generated' && typeof value.text === 'string' && value.text.trim() && value.text.length <= 200_000 && total + value.text.length <= 2_000_000) {
                bodies[id] = { prefillStatus: 'generated', text: value.text, requireUserTail: config.requireUserTail };
                leasesToCheck.push(...leaseSignals);
            }
            else
                throw new Error('动态预填充必须返回非空文本，且符合输出长度上限');
        }
        catch (error) {
            options.signal?.throwIfAborted();
            const reason = error === timeoutError ? timeoutError.message : '动态预填充解析失败，请检查外部插件';
            if (ref.failurePolicy !== 'skip')
                throw new Error(reason);
            skipped(reason);
        }
        finally {
            unwatch?.();
            clearTimeout(timeout);
            controller.abort(new Error('动态预填充准备已结束'));
        }
    }
    return { catalog, bodies, assertAvailable: () => { for (const signal of leasesToCheck)
            signal.throwIfAborted(); } };
}
async function resolveWithSignal(run, context) {
    const { signal } = context;
    signal.throwIfAborted();
    let abort;
    try {
        const result = await Promise.race([
            new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            }),
            Promise.resolve().then(() => { signal.throwIfAborted(); return run(context); }),
        ]);
        signal.throwIfAborted();
        return result;
    }
    finally {
        signal.removeEventListener('abort', abort);
    }
}
