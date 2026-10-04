/* Both views read one immutable request snapshot. Opening Raw/history never prepares a request. */
(() => {
  const node = (tag, text) => { const out = document.createElement(tag); if (text !== undefined) out.textContent = text; return out; };
  const numberTokens = new WeakMap();
  const parseJson = text => JSON.parse(text, (_key, value, context) => {
    if (typeof value !== 'number' || !context?.source) return value;
    const token = {}; numberTokens.set(token, context.source); return token;
  });
  // Render only the opened branch; large objects/arrays reveal 50 entries at a time.
  function jsonTree(value, key, root = false) {
    const label = key === undefined ? '' : `${typeof key === 'number' ? '[' + key + ']' : JSON.stringify(key)}: `;
    const numberToken = value !== null && typeof value === 'object' ? numberTokens.get(value) : undefined;
    const container = value !== null && typeof value === 'object' && numberToken === undefined;
    const longText = typeof value === 'string' && (value.length > 300 || value.includes('\n'));
    if (!container && !longText) {
      const row = node('div'); row.className = 'json-leaf';
      if (label) { const name = node('span', label); name.className = 'json-key'; row.append(name); }
      const text = node('span', numberToken ?? JSON.stringify(value));
      text.className = `json-value json-${numberToken !== undefined ? 'number' : value === null ? 'null' : typeof value}`; row.append(text);
      return row;
    }
    const array = Array.isArray(value), keys = container && !array ? Object.keys(value) : null;
    const count = container ? array ? value.length : keys.length : value.length;
    if (container && count === 0) {
      const row = node('div', label + (array ? '[]' : '{}')); row.className = 'json-leaf'; return row;
    }
    const details = node('details'); details.className = 'json-branch';
    details.append(node('summary', `${label}${container ? (array ? `数组 [${count}]` : `对象 {${count}}`) : `字符串 · ${count} 字符`}`));
    let expanded = false;
    const render = () => {
      if (details.open === expanded) return;
      expanded = details.open;
      while (details.children.length > 1) details.removeChild(details.lastChild);
      if (!expanded) return;
      if (longText) { const text = node('pre', value); text.className = 'json-text'; details.append(text); return; }
      const children = node('div'); children.className = 'json-children'; details.append(children);
      let cursor = 0, more;
      const batch = () => {
        if (!details.open) return;
        if (more) children.removeChild(more);
        const stop = Math.min(cursor + 50, count);
        while (cursor < stop) {
          const childKey = array ? cursor : keys[cursor];
          children.append(jsonTree(value[childKey], childKey)); cursor++;
        }
        if (cursor < count) {
          more = node('button', `再显示 ${Math.min(50, count - cursor)} 项（剩余 ${count - cursor}）`); more.type = 'button';
          more.className = 'json-more'; more.onclick = batch; children.append(more);
        }
      };
      batch();
    };
    details.ontoggle = render;
    if (root) { details.open = true; render(); }
    return details;
  }
  function mount({ output, warnings, raw, rawButton, copyButton, note, choices, onChoose, onStatus }) {
    let current = null, rawMode = false, generation = 0;
    function card(message) {
      const box = node('div'); box.className = 'message';
      box.append(node('b', `${message.role} · ${message.previewHistory ? '聊天记录' : '请求内容'}${message.prefix ? ' · Assistant Prefix' : ''}`));
      for (const block of message.content ?? []) {
        if (block.type === 'text') box.append(node('pre', block.text ?? ''));
        else {
          const details = node('details'); details.append(node('summary', block.type));
          details.ontoggle = () => {
            if (details.open && details.children.length === 1) details.append(node('pre', block.type === 'wire-fields' ? block.text : JSON.stringify(block, null, 2)));
          };
          box.append(details);
        }
      }
      return box;
    }
    function renderMessages() {
      const token = ++generation;
      output.replaceChildren();
      const messages = current.displayMessages ?? current.messages ?? [];
      const history = messages.map((m, i) => m.previewHistory ? i : -1).filter(i => i >= 0);
      const recent = new Set(history.slice(-2)), groups = [];
      if (history.length > 2) {
        const head = node('div'); head.className = 'row';
        head.append(node('span', `聊天记录 ${history.length} 条，默认显示最近 2 条`));
        const button = node('button', '展开全部'); button.type = 'button';
        button.onclick = () => { const open = groups.some(group => !group.open); for (const group of groups) group.open = open; button.textContent = open ? '收起早期记录' : '展开全部'; };
        head.append(button); output.append(head);
      }
      for (let i = 0; i < messages.length;) {
        if (!messages[i].previewHistory || recent.has(i)) { output.append(card(messages[i++])); continue; }
        const start = i;
        while (i < messages.length && messages[i].previewHistory && !recent.has(i)) i++;
        const end = i, details = node('details'); details.className = 'preview-history';
        details.append(node('summary', `早期聊天记录 ${end - start} 条`));
        let run = 0;
        details.ontoggle = () => {
          const task = ++run;
          while (details.children.length > 1) details.removeChild(details.lastChild);
          if (!details.open) return;
          let cursor = start;
          const batch = () => {
            if (!details.open || task !== run || token !== generation) return;
            const stop = Math.min(cursor + 50, end);
            while (cursor < stop) details.append(card(messages[cursor++]));
            if (cursor < end) setTimeout(batch, 0);
          };
          batch();
        };
        groups.push(details); output.append(details);
      }
    }
    function mode() {
      output.hidden = rawMode; raw.hidden = !rawMode; copyButton.hidden = !rawMode;
      rawButton.textContent = rawMode ? '返回消息预览' : '原始消息（Raw）';
      raw.replaceChildren();
      if (rawMode) {
        if (typeof current?.raw !== 'string') raw.append(node('p', current?.unavailable ?? '原始请求不可用'));
        else {
          try { raw.append(jsonTree(parseJson(current.raw), undefined, true)); }
          catch { raw.append(node('p', '无法解析 JSON，显示原文'), node('pre', current.raw)); }
        }
      }
      copyButton.disabled = !current?.raw;
    }
    rawButton.disabled = true;
    rawButton.onclick = () => { if (!current) return; rawMode = !rawMode; mode(); };
    copyButton.onclick = async () => {
      try { if (!current?.raw) throw new Error('原文不可用'); await navigator.clipboard.writeText(current.raw); onStatus('已复制原始请求'); }
      catch (error) { onStatus(error.message, true); }
    };
    choices.onchange = () => onChoose(choices.value);
    return {
      show(result) {
        current = result;
        const source = result.source === 'wire' ? '实际请求' : result.source === 'draft-wire' ? '草稿预览 · 未发送' : '适配器输入 · 最终出站尚未确认';
        note.textContent = [source, result.at, result.status, result.error, result.unavailable].filter(Boolean).join(' · ');
        const regex = result.promptRegex;
        const regexNote = regex ? `提示词正则：${regex.enabled ? '已启用' : '未启用'} · 规则 ${regex.rules} 条 · 本次命中：${regex.applied.join('、') || '（无）'}` : '';
        warnings.textContent = [regexNote, ...(result.warnings ?? [])].filter(Boolean).join('\n');
        choices.replaceChildren();
        for (const choice of result.choices ?? []) { const option = node('option', `${choice.at} · 请求 ${choice.requestNo} / 尝试 ${choice.attempt} · ${choice.status}`); option.value = choice.id; choices.append(option); }
        choices.hidden = !result.choices?.length; choices.value = result.id ?? '';
        rawButton.disabled = false; renderMessages(); mode();
      },
      stale() { if (current && current.source !== 'wire') note.textContent = '当前草稿或设置已变化，请重新解析'; },
      clear() { current = null; ++generation; output.replaceChildren(); raw.replaceChildren(); note.textContent = ''; choices.hidden = true; rawButton.disabled = true; },
    };
  }
  globalThis.PresetRequestPreview = Object.freeze({ mount });
})();
