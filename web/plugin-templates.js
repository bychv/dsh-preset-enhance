/* Shared, read-only catalog UI. Draft changes go through each editor's normal save path. */
(() => {
  const namespace = 'dsh-preset-enhance';
  const bindings = preset => preset?.extensions?.[namespace]?.templateBindings ?? {};
  const linked = (preset, id) => Object.hasOwn(bindings(preset), id);
  const key = ref => JSON.stringify([ref.providerId, ref.templateId, ref.templateVersion]);
  const node = (tag, text) => {
    const out = document.createElement(tag);
    if (text !== undefined) out.textContent = text;
    return out;
  };
  function mount(root, options) {
    if (!root) return null;
    let catalog = { providers: [], fingerprints: [] }, chosen = '', busy = false, ready = false, note = '', stopped = false;
    let refreshing = null;
    const rows = () => catalog.providers.flatMap(provider => provider.templates.map(template => ({
      provider, template, ref: { providerId: provider.providerId, templateId: template.id, templateVersion: template.version },
    })));
    const fingerprint = ref => catalog.fingerprints.find(item => key(item) === key(ref))?.fingerprint;
    const button = (label, callback, disabled = false) => {
      const out = node('button', label); out.type = 'button'; out.disabled = disabled || busy;
      out.onclick = callback; return out;
    };
    const mutate = async selection => {
      if (busy) return;
      const source = options.getPreset();
      if (!source) return;
      const serialized = JSON.stringify(source), characterId = options.getCharacterId();
      busy = true; render();
      try {
        const result = await options.api({ action: 'template-select', preset: source,
          presetId: options.getPresetId(), selection: { ...selection, characterId } });
        if (options.getPreset() !== source || JSON.stringify(source) !== serialized || options.getCharacterId() !== characterId) {
          throw new Error('操作期间草稿已变化，请重新操作；未覆盖现有修改');
        }
        if (result.changed) options.onChange(result.preset, result.identifier);
        else options.onSelect(result.identifier);
        note = result.changed ? '已加入草稿。' : '已定位现有条目。';
      } catch (error) { note = error.message; }
      finally { busy = false; render(); }
    };
    function render() {
      if (stopped) return;
      const opened = root.open;
      root.replaceChildren(node('summary', '插件模板'));
      root.open = opened;
      const help = node('p', '选择版本，加入当前顺序表。');
      help.className = 'muted'; root.append(help);
      root.append(button('刷新目录', refresh));
      const message = node('p', note || (!catalog.providers.length ? '当前没有可用的插件模板。' : ''));
      message.setAttribute('role', 'status'); root.append(message);
      const select = node('select'); select.setAttribute('aria-label', '选择插件模板及固定版本');
      select.append(node('option', '选择模板版本…')); select.firstChild.value = '';
      const available = rows();
      for (const row of available) {
        const option = node('option', `${row.provider.title} / ${row.template.title} · ${row.template.version}`);
        option.value = key(row.ref); select.append(option);
      }
      select.value = chosen; select.disabled = busy || !ready;
      select.onchange = () => { chosen = select.value; render(); };
      root.append(select);
      const selected = available.find(row => key(row.ref) === chosen);
      if (selected) {
        root.append(node('p', `${selected.ref.providerId} · ${selected.ref.templateId} · ${selected.template.role} · ${selected.template.defaults?.placement ?? 'beforeHistory'}`));
        if (selected.template.description) root.append(node('p', selected.template.description));
        const content = node('pre', selected.template.content); content.className = 'plugin-template-text'; root.append(content);
        if (!selected.template.targetMarker) root.append(button('加入当前顺序表', () => mutate({ operation: 'add', ...selected.ref,
          expectedFingerprint: fingerprint(selected.ref) }), !ready || !options.getPreset()));
        const targets = (options.getPreset()?.prompts ?? []).filter(prompt => prompt.marker === true &&
          !['chatHistory', 'dsh-preset-enhance:dsh-system-prompt'].includes(prompt.identifier) &&
          (!selected.template.targetMarker || selected.template.targetMarker === prompt.identifier));
        const target = node('select'); target.setAttribute('aria-label', '关联酒馆标记条目');
        target.append(node('option', '选择 marker 条目…')); target.firstChild.value = '';
        for (const prompt of targets) {
          const option = node('option', `${prompt.name ?? prompt.identifier} · ${prompt.identifier}`);
          option.value = prompt.identifier; option.disabled = options.isLocked(prompt.identifier) || linked(options.getPreset(), prompt.identifier); target.append(option);
        }
        const bind = button('关联到标记条目', () => mutate({ operation: 'bind-marker', identifier: target.value, ...selected.ref,
          expectedFingerprint: fingerprint(selected.ref) }), true);
        target.onchange = () => { bind.disabled = busy || !ready || !target.value; };
        target.disabled = busy || !ready;
        if (targets.length) root.append(target, bind);
        else if (selected.template.targetMarker) root.append(node('p', '此预设没有对应的 marker：' + selected.template.targetMarker));
      }
      const preset = options.getPreset();
      if (!preset) return;
      root.append(node('h4', '此预设的关联条目'));
      const groupIds = new Set(options.getOrder().map(item => item.identifier));
      const bound = preset.prompts.filter(prompt => linked(preset, prompt.identifier));
      if (!bound.length) root.append(node('p', '尚未选用插件模板。'));
      for (const prompt of bound) {
        const ref = bindings(preset)[prompt.identifier] ?? {};
        const matching = available.find(row => key(row.ref) === key(ref));
        const valid = ready && matching && ref.mode === 'linked' && fingerprint(ref) === ref.fingerprint;
        const reason = !ready ? '目录未连接，请刷新' : !matching ? '提供者或锁定版本不可用，注入时跳过'
          : !valid ? '关联内容变化，注入时跳过；请选择版本查看并重新接受' : '固定版本可用';
        const row = node('div'); row.className = 'plugin-template-binding';
        row.append(node('strong', prompt.name ?? prompt.identifier), node('p', `${ref.providerId ?? '?'} / ${ref.templateId ?? '?'} @ ${ref.templateVersion ?? '?'}`),
          node('p', `${groupIds.has(prompt.identifier) ? '当前顺序表内' : '不在当前顺序表内'} · ${reason}`));
        const saved = node('details'); saved.append(node('summary', '查看已保存的文本快照'));
        const text = node('pre', ref.target === 'marker' ? ref.contentSnapshot ?? '' : prompt.content ?? ''); text.className = 'plugin-template-text'; saved.append(text); row.append(saved);
        const locked = options.isLocked(prompt.identifier);
        row.append(button('定位条目', () => options.onSelect(prompt.identifier)));
        row.append(button(ref.target === 'marker' ? '恢复原标记' : '转为本地副本', () => {
          if (confirm(ref.target === 'marker' ? '解除插件关联并恢复原 marker 的内容来源，位置和开关不变。继续？' : '解除插件关联，保留当前文本快照、位置和开关，之后可编辑正文。继续？')) void mutate({ operation: 'detach', identifier: prompt.identifier });
        }, locked));
        const canUpdate = ready && selected && selected.ref.providerId === ref.providerId && selected.ref.templateId === ref.templateId;
        row.append(button('接受上方所选版本', () => {
          if (!canUpdate) return;
          if (confirm(`将「${prompt.name ?? prompt.identifier}」更新为 ${selected.ref.templateVersion}？请先对照上方正文和已保存快照；位置和开关不变。`)) {
            void mutate({ operation: 'update', identifier: prompt.identifier, ...selected.ref, expectedFingerprint: fingerprint(selected.ref) });
          }
        }, locked || !canUpdate || (selected && fingerprint(selected.ref) === ref.fingerprint && selected.ref.templateVersion === ref.templateVersion)));
        if (locked) row.append(node('p', '此条目已锁定，请先在编辑器解锁。'));
        root.append(row);
      }
    }
    function refresh() {
      if (stopped) return Promise.resolve();
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          const response = await fetch('/preset-enhance/api/templates');
          const value = await response.json();
          if (!response.ok) throw new Error(value.error ?? '模板目录读取失败');
          if (value.contractVersion !== 1) throw new Error('不支持的模板目录版本');
          catalog = value; ready = true; note = '';
        } catch (error) { ready = false; note = error.message; }
        finally { refreshing = null; if (!stopped) { render(); options.onCatalog?.(); } }
      })();
      return refreshing;
    }
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    let timer;
    const start = () => { stopped = false; clearInterval(timer); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000); void refresh(); };
    window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); });
    window.addEventListener('pageshow', start);
    start();
    render(); void refresh();
    return { render, refresh };
  }
  globalThis.PresetPluginTemplates = Object.freeze({ mount, linked, bindings });
})();
