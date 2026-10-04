import { createHash, randomUUID } from 'node:crypto';
const NS = 'dsh-preset-enhance';
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
export function templateBindings(preset, catalog) {
    const extensions = preset.extensions;
    const raw = object(extensions) && object(extensions[NS]) ? extensions[NS].templateBindings : undefined;
    if (raw !== undefined && !object(raw))
        throw new Error('templateBindings 必须为对象');
    if (!catalog)
        return raw ?? {};
    const bindings = Object.assign(Object.create(null), raw ?? {});
    for (const id of Object.keys(bindings))
        if (bindings[id]?.automatic === true)
            delete bindings[id];
    const disabled = object(extensions) && object(extensions[NS]) && Array.isArray(extensions[NS].autoTemplateDisabled) ? extensions[NS].autoTemplateDisabled : [];
    const candidates = new Map();
    for (const provider of catalog.providers)
        for (const template of provider.templates) {
            if (!template.targetMarker)
                continue;
            const list = candidates.get(template.targetMarker) ?? [];
            list.push({ providerId: provider.providerId, template });
            candidates.set(template.targetMarker, list);
        }
    for (const prompt of preset.prompts) {
        if (!markerTarget(prompt) || Object.hasOwn(bindings, prompt.identifier) || disabled.includes(prompt.identifier))
            continue;
        const matches = candidates.get(prompt.identifier) ?? [];
        if (matches.length > 1) {
            bindings[prompt.identifier] = { mode: 'auto-conflict', candidates: matches.map(({ providerId, template }) => `${providerId}/${template.id}@${template.version}`).sort() };
        }
        else if (matches.length === 1) {
            const { providerId, template } = matches[0];
            bindings[prompt.identifier] = { mode: template.dynamic ? 'linked-dynamic' : 'linked', target: 'marker', automatic: true,
                ...(raw?.[prompt.identifier]?.providerId === providerId && raw?.[prompt.identifier]?.templateId === template.id ? { config: raw[prompt.identifier].config, failurePolicy: raw[prompt.identifier].failurePolicy } : {}),
                providerId, templateId: template.id, templateVersion: template.version, fingerprint: templateFingerprint(template), contentSnapshot: template.content };
        }
    }
    return bindings;
}
export const templateFingerprint = (template) => createHash('sha256').update(JSON.stringify(template)).digest('hex');
export function templateCatalogWithFingerprints(catalog) {
    return { ...catalog, fingerprints: catalog.providers.flatMap(provider => provider.templates.map(template => ({
            providerId: provider.providerId, templateId: template.id, templateVersion: template.version,
            fingerprint: templateFingerprint(template),
        }))) };
}
function find(catalog, ref) {
    return catalog?.providers.find(provider => provider.providerId === ref.providerId)?.templates
        .find(template => template.id === ref.templateId && template.version === ref.templateVersion);
}
const markerTarget = (prompt) => prompt.marker === true &&
    prompt.identifier !== 'dsh-preset-enhance:dsh-system-prompt';
export function resolveTemplateBindings(preset, catalog, activeIds, bodies) {
    const bindings = templateBindings(preset, catalog);
    const warnings = [];
    const references = [];
    const missing = new Set();
    const prompts = preset.prompts.map(prompt => {
        if (!Object.hasOwn(bindings, prompt.identifier))
            return prompt;
        const ref = bindings[prompt.identifier];
        if (ref?.mode === 'auto-conflict') {
            if (!activeIds || activeIds.has(prompt.identifier)) {
                const reason = `自动关联冲突，请在插件模板中选择：${ref.candidates.join('、')}`;
                references.push({ identifier: prompt.identifier, fingerprint: null, reason });
                warnings.push(`插件模板「${prompt.name ?? prompt.identifier}」${reason}`);
            }
            return prompt;
        }
        const template = object(ref) ? find(catalog, ref) : undefined;
        const fingerprint = template ? templateFingerprint(template) : null;
        const marker = object(ref) && ref.target === 'marker';
        const history = prompt.identifier === 'chatHistory';
        const reason = !object(ref) || ref.mode !== (template?.dynamic ? 'linked-dynamic' : 'linked') || (history && (!marker || template?.targetMarker !== 'chatHistory' || template?.dynamic?.output !== 'history-patches')) || prompt.identifier === 'dsh-preset-enhance:dsh-system-prompt' ||
            (marker ? !markerTarget(prompt) : !!prompt.marker) ||
            (template?.targetMarker !== undefined && (!marker || template.targetMarker !== prompt.identifier))
            ? '模板关联无效'
            : !template ? '提供者或锁定版本不可用'
                : ref.fingerprint !== fingerprint ? '同版本内容已变化，请查看并重新接受'
                    : '';
        const body = bodies && Object.hasOwn(bodies, prompt.identifier) ? bodies[prompt.identifier] : undefined;
        const unavailable = reason || (template?.dynamic && bodies ? body?.reason || (history ? (!Array.isArray(body?.patches) ? '历史修改未解析' : '') : (typeof body?.text !== 'string' ? '动态正文未解析' : '')) : '');
        if (!activeIds || activeIds.has(prompt.identifier)) {
            references.push({ identifier: prompt.identifier, fingerprint, reason: unavailable });
            if (unavailable)
                warnings.push(`插件模板「${prompt.name ?? prompt.identifier}」已跳过：${unavailable}`);
        }
        if (unavailable) {
            missing.add(prompt.identifier);
            return prompt;
        }
        if (history)
            return prompt;
        return { ...prompt, role: marker ? prompt.role : template.role, content: template.content, ...(marker ? { marker: false } : {}) };
    });
    // Keep placeholders in the order table so missing templates do not produce duplicate warnings.
    return {
        preset: { ...preset, prompts: prompts.map(prompt => missing.has(prompt.identifier) && prompt.identifier !== 'chatHistory'
                ? { ...prompt, content: '', marker: false } : prompt) },
        warnings, references,
    };
}
/** Edit an unsaved draft; the caller retains responsibility for revision-aware saving. */
export function selectTemplate(source, catalog, selection, locks = []) {
    const preset = structuredClone(source);
    const extensions = preset.extensions;
    if (extensions !== undefined && !object(extensions))
        throw new Error('extensions 必须为对象');
    const ext = (preset.extensions ??= {});
    if (ext[NS] !== undefined && !object(ext[NS]))
        throw new Error('预设插件扩展必须为对象');
    const settings = ext[NS] ??= {};
    const bindings = templateBindings(preset);
    settings.templateBindings = bindings;
    if (!['add', 'update', 'detach', 'bind-marker', 'configure', 'restore-auto'].includes(selection.operation))
        throw new Error('模板操作无效');
    if (selection.operation === 'add' && selection.identifier !== undefined)
        throw new Error('新增模板不能指定现有条目；关联标记请使用 bind-marker');
    let prompt = preset.prompts.find(item => item.identifier === selection.identifier);
    const effective = templateBindings(preset, catalog);
    const previous = prompt && Object.hasOwn(effective, prompt.identifier) && effective[prompt.identifier]?.mode !== 'auto-conflict' ? effective[prompt.identifier] : undefined;
    if (selection.operation === 'restore-auto') {
        if (!prompt || !markerTarget(prompt))
            throw new Error('请选择 marker 条目');
        if (locks.includes(prompt.identifier))
            throw new Error('条目已锁定，请先解锁');
        delete bindings[prompt.identifier];
        settings.autoTemplateDisabled = (Array.isArray(settings.autoTemplateDisabled) ? settings.autoTemplateDisabled : []).filter((id) => id !== prompt.identifier);
        return { preset, identifier: prompt.identifier, changed: JSON.stringify(preset) !== JSON.stringify(source) };
    }
    if (selection.operation === 'configure') {
        if (!prompt || previous?.mode !== 'linked-dynamic')
            throw new Error('动态关联条目不存在');
        if (locks.includes(prompt.identifier))
            throw new Error('条目已锁定，请先解锁');
        if (!object(selection.config) || JSON.stringify(selection.config).length > 20_000 || !['abort', 'skip'].includes(selection.failurePolicy ?? ''))
            throw new Error('动态模板配置无效');
        bindings[prompt.identifier] = { ...previous, config: structuredClone(selection.config), failurePolicy: selection.failurePolicy };
        return { preset, identifier: prompt.identifier, changed: JSON.stringify(preset) !== JSON.stringify(source) };
    }
    if (selection.operation === 'bind-marker') {
        if (!prompt || !markerTarget(prompt))
            throw new Error('请选择可关联的酒馆 marker 条目');
        if (locks.includes(prompt.identifier))
            throw new Error('条目已锁定，请先解锁');
        if (previous && !previous.automatic)
            throw new Error('条目已有关联，请更新版本或先解除关联');
    }
    if (selection.operation === 'update' || selection.operation === 'detach') {
        if (!prompt || !previous)
            throw new Error('关联模板条目不存在');
        if (locks.includes(prompt.identifier))
            throw new Error('条目已锁定，请先解锁');
        if (selection.operation === 'detach') {
            if (previous.mode === 'linked-dynamic' && previous.target !== 'marker')
                prompt.content = (prompt.content ?? '').replaceAll('{{dynamic::body}}', '');
            delete bindings[prompt.identifier];
            if (markerTarget(prompt))
                settings.autoTemplateDisabled = [...new Set([...(Array.isArray(settings.autoTemplateDisabled) ? settings.autoTemplateDisabled : []), prompt.identifier])];
            return { preset, identifier: prompt.identifier, changed: true };
        }
        if (previous.providerId !== selection.providerId || previous.templateId !== selection.templateId) {
            throw new Error('更新只能选择同一提供者、同一模板的版本');
        }
    }
    const template = find(catalog, selection);
    if (!template)
        throw new Error('提供者或所选模板版本不可用，请刷新目录');
    const fingerprint = templateFingerprint(template);
    if (selection.expectedFingerprint !== fingerprint)
        throw new Error('目录已变化，请刷新并重新查看模板');
    const marker = selection.operation === 'bind-marker' || previous?.target === 'marker';
    if (marker && (!prompt || !markerTarget(prompt)))
        throw new Error('marker 条目已改变，请解除关联后重新选择');
    if (template.targetMarker !== undefined && (!marker || template.targetMarker !== prompt?.identifier))
        throw new Error('模板仅适用于指定 marker');
    if (marker && prompt?.identifier === 'chatHistory' && (template.targetMarker !== 'chatHistory' || template.dynamic?.output !== 'history-patches'))
        throw new Error('chatHistory 仅接受结构化历史修改模板');
    if (marker) {
        settings.autoTemplateDisabled = (Array.isArray(settings.autoTemplateDisabled) ? settings.autoTemplateDisabled : []).filter((id) => id !== prompt.identifier);
        Object.defineProperty(bindings, prompt.identifier, { enumerable: true, configurable: true, writable: true, value: {
                ...(object(previous) ? previous : {}), mode: template.dynamic ? 'linked-dynamic' : 'linked', automatic: false, target: 'marker', providerId: selection.providerId, templateId: selection.templateId,
                templateVersion: template.version, fingerprint, contentSnapshot: template.content,
            } });
        return { preset, identifier: prompt.identifier, changed: JSON.stringify(preset) !== JSON.stringify(source) };
    }
    if (selection.operation === 'add') {
        prompt = preset.prompts.find(item => {
            const ref = Object.hasOwn(bindings, item.identifier) ? bindings[item.identifier] : undefined;
            return ref?.target !== 'marker' && !item.marker && ref?.providerId === selection.providerId && ref.templateId === selection.templateId && ref.templateVersion === selection.templateVersion;
        });
        if (prompt && locks.includes(prompt.identifier))
            throw new Error('条目已锁定，请先解锁');
    }
    const existing = !!prompt;
    if (!prompt) {
        prompt = { identifier: `plugin-template:${randomUUID()}`, name: template.title, role: template.role, content: template.content,
            injection_position: template.defaults?.placement === 'depth' ? 1 : 0,
            ...(template.defaults?.placement === 'depth' ? { injection_depth: template.defaults.depth, injection_order: template.defaults.order ?? 100 } : {}),
        };
        preset.prompts.push(prompt);
    }
    if (selection.operation === 'update' || !existing) {
        prompt.role = template.role;
        prompt.content = template.content;
        Object.defineProperty(bindings, prompt.identifier, { enumerable: true, configurable: true, writable: true, value: {
                ...(object(previous) ? previous : {}), mode: template.dynamic ? 'linked-dynamic' : 'linked', providerId: selection.providerId,
                templateId: selection.templateId, templateVersion: template.version, fingerprint,
            } });
    }
    if (selection.operation === 'add') {
        if (!preset.prompt_order?.length)
            preset.prompt_order = [{ character_id: selection.characterId ?? 100001,
                    order: source.prompts.map(item => ({ identifier: item.identifier, enabled: item.enabled !== false })) }];
        const group = selection.characterId == null
            ? preset.prompt_order.find(item => String(item.character_id) === '100001') ?? preset.prompt_order[0]
            : preset.prompt_order.find(item => String(item.character_id) === String(selection.characterId));
        if (!group)
            throw new Error('所选顺序表不存在');
        if (!group.order.some(item => item.identifier === prompt.identifier)) {
            const item = { identifier: prompt.identifier, enabled: true };
            let history = group.order.findIndex(entry => entry.identifier === 'chatHistory');
            if (template.defaults?.placement === 'afterHistory') {
                if (history < 0) {
                    if (!preset.prompts.some(entry => entry.identifier === 'chatHistory'))
                        preset.prompts.push({ identifier: 'chatHistory', name: 'Chat History', marker: true, role: 'user' });
                    group.order.push({ identifier: 'chatHistory', enabled: true });
                }
                else if (!group.order[history].enabled)
                    throw new Error('请先启用当前顺序表的 chatHistory，再添加历史之后的模板');
                group.order.push(item);
            }
            else
                group.order.splice(history < 0 ? group.order.length : history, 0, item);
        }
    }
    return { preset, identifier: prompt.identifier, changed: JSON.stringify(preset) !== JSON.stringify(source) };
}
