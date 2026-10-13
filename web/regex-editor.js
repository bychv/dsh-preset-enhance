import { observeDisplayAvailability } from './display-availability.js';
/* SPreset's functional regex view. Stored rules are shared with the workbench. */
(() => {
    const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls)
        n.className = cls; if (text !== undefined)
        n.textContent = text; return n; };
    const field = (text, input) => { const n = node('label', 'field'); n.append(node('span', '', text), input); return n; };
    const action = (text, label, fn) => { const b = node('button', '', text); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; return b; };
    const toggle = (text, value, fn) => { const i = node('input'); i.type = 'checkbox'; i.checked = value === true; i.onchange = () => fn(i.checked); const wrap = field(text, i); wrap.classList.add('regex-toggle'); return wrap; };
    globalThis.PresetRegexEditor = {
        mount(root, options) {
            let selected = 0, filter = 'all', generation = 0, worker, timeout;
            let available = false, displayToggle, displayStatus, disposed = false;
            let list, detail, notice, source, result, channel, target, depth, scope;
            const rules = () => { const rs = options.getPreset()?.extensions?.regex_scripts; return Array.isArray(rs) ? rs : []; };
            function syntaxError(value) { if (!value)
                return '空表达式'; try {
                const parts = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(value);
                new RegExp(parts ? parts[1] : value, parts ? parts[2] : '');
                return '';
            }
            catch {
                return '表达式无效';
            } }
            function change() { generation++; worker?.terminate(); clearTimeout(timeout); if (notice?.textContent === '计算中')
                notice.textContent = '配置已变更，请重新运行'; options.onChange(); }
            function namespace() {
                const p = options.getPreset();
                p.extensions ??= {};
                p.extensions['dsh-preset-enhance'] ??= {};
                return p.extensions['dsh-preset-enhance'];
            }
            function mutate(fn) { const p = options.getPreset(); p.extensions ??= {}; p.extensions.regex_scripts ??= []; fn(p.extensions.regex_scripts); change(); render(); }
            function update(key, value) { const r = rules()[selected]; if (!r)
                return; r[key] = value; change(); renderList(); }
            function input(key, multiline = false) {
                const i = node(multiline ? 'textarea' : 'input');
                i.value = String(rules()[selected]?.[key] ?? '');
                i.spellcheck = false;
                if (i instanceof HTMLTextAreaElement)
                    i.rows = 6;
                i.oninput = () => update(key, i.value);
                return i;
            }
            function renderList() {
                list.replaceChildren();
                const rs = rules();
                list.append(node('p', 'muted', rs.filter(r => r && typeof r === 'object' && !r.disabled).length + ' / ' + rs.length + ' 启用'));
                rs.forEach((r, index) => {
                    if (!r || typeof r !== 'object' || Array.isArray(r)) {
                        list.append(node('p', 'muted', (index + 1) + ' · 非规则数据已保留'));
                        return;
                    }
                    if (filter === 'prompt' && !r.promptOnly || filter === 'display' && !r.markdownOnly)
                        return;
                    const card = node('div', 'regex-row' + (index === selected ? ' selected' : '') + (r.disabled ? ' disabled' : ''));
                    const select = action(String(index + 1).padStart(2, '0') + '  ' + (r.scriptName || '未命名规则'), '编辑规则', () => { selected = index; root.classList.add('regex-detail-open'); renderList(); renderDetail(); });
                    select.className = 'regex-row-name';
                    card.append(select, node('p', 'preview', r.findRegex || '空表达式'));
                    const error = syntaxError(r.findRegex);
                    if (error)
                        card.append(node('p', 'state error', error));
                    const bar = node('div', 'regex-row-actions');
                    bar.append(action(r.disabled ? '关' : '开', '启停规则', () => { r.disabled = !r.disabled; change(); render(); }));
                    const rowActions = [
                        ['↑', '上移', () => mutate(rs => { [rs[index - 1], rs[index]] = [rs[index], rs[index - 1]]; selected = index - 1; }), index === 0],
                        ['↓', '下移', () => mutate(rs => { [rs[index + 1], rs[index]] = [rs[index], rs[index + 1]]; selected = index + 1; }), index === rs.length - 1],
                        ['⧉', '创建副本', () => mutate(rs => { rs.splice(index + 1, 0, { ...structuredClone(r), id: crypto.randomUUID(), scriptName: (r.scriptName || '规则') + ' 副本' }); selected = index + 1; }), false],
                        ['×', '删除规则', () => { if (confirm('删除规则“' + (r.scriptName || '未命名规则') + '”？'))
                                mutate(rs => { rs.splice(index, 1); selected = Math.min(selected, rs.length - 1); }); }, false],
                    ];
                    for (const [symbol, label, fn, disabled] of rowActions) {
                        const b = action(symbol, label, fn);
                        b.disabled = disabled;
                        bar.append(b);
                    }
                    card.append(bar);
                    list.append(card);
                });
                if (!rs.length)
                    list.append(node('p', 'empty', '暂无正则'));
            }
            function renderDetail() {
                generation++;
                worker?.terminate();
                clearTimeout(timeout);
                detail.replaceChildren();
                const back = action('← 返回规则', '返回规则', () => root.classList.remove('regex-detail-open'));
                back.className = 'regex-back';
                detail.append(back);
                const r = rules()[selected];
                if (!r || typeof r !== 'object' || Array.isArray(r)) {
                    detail.append(node('p', 'empty', '选择或新建正则'));
                    return;
                }
                const card = node('section', 'regex-card');
                const head = node('div', 'regex-card-head');
                head.append(node('h2', '', r.scriptName || '未命名规则'), toggle('启用规则', !r.disabled, v => { update('disabled', !v); renderDetail(); }));
                card.append(head);
                card.append(field('规则名称', input('scriptName')));
                const pair = node('div', 'regex-pair');
                const find = input('findRegex', true);
                find.placeholder = '/pattern/flags';
                pair.append(field('查找表达式', find), field('替换内容', input('replaceString', true)));
                card.append(pair);
                const trims = node('textarea');
                trims.rows = 3;
                trims.value = (r.trimStrings ?? []).join('\n');
                trims.oninput = () => update('trimStrings', trims.value.split('\n').filter(Boolean));
                card.append(field('从匹配内容中移除', trims));
                detail.append(card);
                const places = node('section', 'regex-card');
                places.append(node('h2', '', '执行位置'));
                const grid = node('div', 'regex-pair');
                const values = () => Array.isArray(r.placement) ? r.placement : [r.placement];
                for (const [id, label] of [[1, '用户输入'], [2, '模型输出']]) {
                    const wrap = toggle(label, values().includes(id), v => { const next = new Set(values().filter((v) => typeof v === 'number' && Number.isFinite(v))); v ? next.add(id) : next.delete(id); update('placement', [...next]); });
                    wrap.classList.add('regex-choice');
                    grid.append(wrap);
                }
                places.append(grid);
                detail.append(places);
                const conditions = node('section', 'regex-card');
                conditions.append(node('h2', '', '执行条件'));
                const flags = node('div', 'regex-pair');
                flags.append(toggle('正文显示', r.markdownOnly, v => update('markdownOnly', v)), toggle('发送提示词', r.promptOnly, v => update('promptOnly', v)));
                conditions.append(flags);
                const bounds = node('div', 'regex-bounds');
                const macro = node('select');
                for (const [value, label] of [[0, '不替换'], [1, '直接展开'], [2, '转义后展开']]) {
                    const o = node('option', '', label);
                    o.value = String(value);
                    macro.append(o);
                }
                macro.value = String(r.substituteRegex ?? 0);
                macro.onchange = () => update('substituteRegex', Number(macro.value));
                bounds.append(field('查找式宏替换', macro));
                for (const [key, label] of [['minDepth', '最小深度'], ['maxDepth', '最大深度']]) {
                    const i = node('input');
                    i.type = 'number';
                    i.min = '-1';
                    i.placeholder = '不限';
                    i.value = String(r[key] ?? '');
                    i.onchange = () => update(key, i.value === '' ? null : Number(i.value));
                    bounds.append(field(label, i));
                }
                conditions.append(bounds);
                const compat = node('details');
                compat.append(node('summary', '', '兼容字段'));
                compat.append(node('pre', 'json', JSON.stringify(Object.fromEntries(Object.entries(r).filter(([key]) => !['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'markdownOnly', 'promptOnly', 'disabled', 'substituteRegex', 'minDepth', 'maxDepth'].includes(key))), null, 2)));
                const unsupported = values().filter(v => typeof v !== 'number' || ![1, 2].includes(v));
                if (unsupported.length)
                    compat.append(node('p', 'muted', '位置 ' + unsupported.join(' / ') + ' 暂不执行'));
                conditions.append(compat);
                detail.append(conditions);
                const trial = node('details', 'regex-card');
                trial.append(node('summary', '', '试运行'));
                source = node('textarea');
                source.rows = 5;
                source.placeholder = '测试文本';
                result = node('pre', 'regex-result');
                notice = node('p', 'state');
                const controls = node('div', 'regex-trial-controls');
                const select = (choices) => { const s = node('select'); for (const [value, label] of choices) {
                    const o = node('option', '', label);
                    o.value = String(value);
                    s.append(o);
                } return s; };
                channel = select([['display', '正文显示'], ['prompt', '发送提示词']]);
                target = select([['assistant', '模型输出'], ['user', '用户输入']]);
                scope = select([['all', '全部规则'], ['one', '当前规则']]);
                depth = node('input');
                depth.type = 'number';
                depth.value = '0';
                depth.setAttribute('aria-label', '深度');
                controls.append(channel, target, scope, depth, action('运行', '运行正则', run));
                trial.append(source, controls, notice, result);
                detail.append(trial);
            }
            async function run() {
                worker?.terminate();
                clearTimeout(timeout);
                const version = ++generation;
                result.textContent = '';
                notice.textContent = '计算中';
                try {
                    worker = new Worker('/preset-enhance/regex-worker.js', { type: 'module' });
                }
                catch {
                    notice.textContent = '正则无法启动';
                    result.textContent = source.value;
                    return;
                }
                const finish = (error, data) => { if (version !== generation)
                    return; worker?.terminate(); clearTimeout(timeout); notice.textContent = error || (data?.warnings?.join('；') || '完成'); result.textContent = error ? source.value : data?.texts[0] ?? source.value; };
                worker.onmessage = ({ data }) => finish(data.error, data.result);
                worker.onerror = () => finish('正则执行失败');
                timeout = setTimeout(() => finish('正则执行超时，保留原文'), 1500);
                worker.postMessage({ id: version, task: { texts: [source.value], scripts: structuredClone(scope.value === 'one' ? [rules()[selected]] : rules()), channel: channel.value, target: target.value, depth: Number(depth.value), seed: 'spreset-preview' } });
            }
            function render() {
                generation++;
                worker?.terminate();
                clearTimeout(timeout);
                root.replaceChildren();
                root.classList.add('regex-view');
                if (!options.getPreset()) {
                    root.append(node('p', 'empty', '没有可用预设'));
                    return;
                }
                const rs = rules();
                selected = Math.max(0, Math.min(selected, rs.length - 1));
                const top = node('div', 'regex-toolbar');
                top.append(node('h2', '', '正则'));
                top.append(toggle('提示词正则', namespace().promptRegex?.enabled, v => { namespace().promptRegex = { ...namespace().promptRegex, enabled: v }; change(); }));
                const displayControl = toggle('正文正则', available && namespace().displayRegex?.enabled === true, v => { if (!available)
                    return; namespace().displayRegex = { ...namespace().displayRegex, enabled: v }; change(); });
                displayToggle = displayControl.querySelector('input');
                displayStatus = node('span', 'muted');
                top.append(displayControl, displayStatus);
                syncAvailability();
                top.append(toggle('包含预填充', namespace().promptRegex?.includePrefill, v => { namespace().promptRegex = { ...namespace().promptRegex, includePrefill: v }; change(); }));
                top.append(action('＋ 新建正则', '新建正则', () => { mutate(rs => { rs.push({ id: crypto.randomUUID(), scriptName: '新正则', findRegex: '', replaceString: '', placement: [2], promptOnly: true, markdownOnly: false, disabled: false, trimStrings: [], substituteRegex: 0 }); selected = rs.length - 1; }); root.classList.add('regex-detail-open'); }));
                root.append(top);
                const layout = node('div', 'regex-layout');
                const side = node('aside', 'regex-sidebar');
                const filters = node('div', 'regex-filters');
                for (const [value, label] of [['all', '全部'], ['prompt', '提示词'], ['display', '正文']]) {
                    const b = action(label, label, () => { filter = value; render(); });
                    if (filter === value)
                        b.classList.add('active');
                    filters.append(b);
                }
                side.append(filters);
                list = node('div', 'regex-list');
                side.append(list);
                detail = node('div', 'regex-detail');
                layout.append(side, detail);
                root.append(layout);
                renderList();
                renderDetail();
            }
            function syncAvailability() {
                if (displayToggle) {
                    displayToggle.checked = available && options.getPreset()?.extensions?.['dsh-preset-enhance']?.displayRegex?.enabled === true;
                    displayToggle.disabled = !available;
                }
                if (displayStatus)
                    displayStatus.textContent = available ? '' : '正文显示包未启用';
            }
            const stopAvailability = observeDisplayAvailability(status => { if (disposed)
                return; available = status.available; syncAvailability(); });
            return { render, dispose() { disposed = true; stopAvailability(); generation++; worker?.terminate(); clearTimeout(timeout); } };
        }
    };
})();
