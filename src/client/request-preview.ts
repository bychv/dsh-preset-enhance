type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface PreviewMessage { role: string; previewHistory?: boolean; prefix?: boolean; content?: {type:string; text?:string; [key:string]:unknown}[] }
interface PreviewData { raw?:string; unavailable?:string; displayMessages?:PreviewMessage[]; messages?:PreviewMessage[]; source?:string; at?:string; status?:string; error?:string; id?:string; warnings?:string[]; promptRegex?:{enabled:boolean;rules:number;applied:string[]}; choices?:{id:string;at?:string;requestNo?:number;attempt?:number;status?:string}[] }
interface PreviewMount { output:HTMLElement; warnings:HTMLElement; raw:HTMLElement; rawButton:HTMLButtonElement; copyButton:HTMLButtonElement; note:HTMLElement; choices:HTMLSelectElement; onChoose:(id:string)=>void; onStatus:(text:string,error?:boolean)=>void }
/* Both views read one immutable request snapshot. Opening Raw/history never prepares a request. */
(() => {
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const out = document.createElement(tag); if (text !== undefined) out.textContent = text; return out; };
  const numberTokens = new WeakMap<object, string>();
  const parseJson = (text: string): Json => JSON.parse(text, (_key: string, value: Json, context?: {source?:string}) => {
    if (typeof value !== 'number' || !context?.source) return value;
    const token = {}; numberTokens.set(token, context.source); return token;
  });
  // Each opened branch is bounded; expanding a level never materializes the entire request.
  function jsonTree(value: Json, key?: string | number, depth = 0, budget = { branches: 40 }): HTMLElement {
    const label = key === undefined ? '' : `${typeof key === 'number' ? '[' + key + ']' : JSON.stringify(key)}: `;
    const numeric = value !== null && typeof value === 'object' ? numberTokens.get(value) : undefined;
    const container = value !== null && typeof value === 'object' && numeric === undefined;
    if (!container) {
      const row = node('div'); row.className = 'json-leaf';
      row.append(node('span', label));
      const text = node('span', numeric ?? JSON.stringify(value));
      text.className = `json-value json-${numeric !== undefined ? 'number' : value === null ? 'null' : typeof value}`;
      if (typeof value === 'string' && value.length > 300) {
        let full = false; const toggle = node('button', '展开'); toggle.type = 'button'; toggle.className = 'json-more';
        const draw = () => { text.textContent = full ? value : value.slice(0,180) + '…'; toggle.textContent = full ? '收起' : `展开 ${value.length} 字符`; };
        toggle.onclick = () => { full = !full; draw(); }; draw(); row.append(text,toggle);
      } else row.append(text);
      return row;
    }
    const object = value as Record<string, Json>, array = Array.isArray(value), keys = Object.keys(object), count = keys.length;
    if (!count) { const row = node('div', label + (array ? '[]' : '{}')); row.className = 'json-leaf'; return row; }
    const hint = !array ? [object.role, object.name, typeof object.function === 'object' && object.function !== null ? (object.function as Record<string,Json>).name : null].filter(v=>typeof v === 'string').join(' · ').slice(0,120) : '';
    const details = node('details'); details.className = 'json-branch';
    details.append(node('summary', `${label}${array ? '[' : '{'} ${count} ${hint ? '· '+hint+' ' : ''}${array ? ']' : '}'}`));
    let expanded = false;
    const render = () => {
      if (details.open === expanded) return;
      expanded = details.open;
      while (details.children.length > 1) details.removeChild(details.lastChild!);
      if (!expanded) return;
      const children = node('div'); children.className = 'json-children'; details.append(children);
      let cursor = 0, more: HTMLButtonElement | undefined;
      const batch = () => {
        if (!details.open) return;
        if (more) children.removeChild(more);
        const stop = Math.min(cursor + 50, count);
        while (cursor < stop) { const childKey = keys[cursor++]; children.append(jsonTree(object[childKey], array ? Number(childKey) : childKey, depth + 1, budget)); }
        if (cursor < count) { more = node('button', `再显示 ${Math.min(50,count-cursor)} 项（剩余 ${count-cursor}）`); more.type='button'; more.className='json-more'; more.onclick=batch; children.append(more); }
      };
      batch(); children.append(node('div', array ? ']' : '}'));
    };
    details.ontoggle = render;
    if (depth <= 2 && budget.branches-- > 0) { details.open = true; render(); }
    return details;
  }
  function toolsSummary(value: Json): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const tools = Array.isArray(value.tools) ? `原生工具 ${value.tools.length} 个` : 'tools 未发送';
    const controls = ['tool_choice','parallel_tool_calls'].map(key => `${key} ${Object.hasOwn(value,key) ? '已发送' : '未发送'}`);
    // This is a text observation, not proof that the bridge converted the request.
    const messages = Array.isArray(value.messages) ? value.messages : [];
    const dsml = messages.some(message => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
      const content = message.content;
      return typeof content === 'string' ? content.includes('DSML') : Array.isArray(content) && content.some(block => block && typeof block === 'object' && !Array.isArray(block) && typeof block.text === 'string' && block.text.includes('DSML'));
    }) ? '消息含 DSML 文本' : '';
    return [tools,...controls,dsml].filter(Boolean).join(' · ');
  }
  function mount({ output, warnings, raw, rawButton, copyButton, note, choices, onChoose, onStatus }: PreviewMount) {
    let current: PreviewData | null = null; let rawMode = false, generation = 0;
    function card(message: PreviewMessage) {
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
      const messages = current!.displayMessages ?? current!.messages ?? [];
      const history = messages.map((m, i) => m.previewHistory ? i : -1).filter(i => i >= 0);
      const recent = new Set(history.slice(-2)), groups: HTMLDetailsElement[] = [];
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
          while (details.children.length > 1) details.removeChild(details.lastChild!);
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
          try {
            const parsed = parseJson(current.raw), tree = jsonTree(parsed);
            const toolbar = node('div'); toolbar.className = 'json-toolbar';
            const expand = node('button','展开一层'), collapse = node('button','收起全部'); expand.type=collapse.type='button';
            expand.onclick = () => { const branches = [tree, ...tree.querySelectorAll('details')].filter((item): item is HTMLDetailsElement => item.tagName === 'DETAILS' && !(item as HTMLDetailsElement).open); for (const item of branches.slice(0,50)) item.open=true; };
            collapse.onclick = () => { for(const item of [tree,...tree.querySelectorAll('details')]) if(item.tagName==='DETAILS') (item as HTMLDetailsElement).open=false; };
            toolbar.append(expand,collapse);raw.append(toolbar,node('p',toolsSummary(parsed)),tree);
          }
          catch { raw.append(node('p', '无法解析 JSON，显示原文'), node('pre', current.raw)); }
        }
      }
      copyButton.disabled = !current?.raw;
    }
    rawButton.disabled = true;
    rawButton.onclick = () => { if (!current) return; rawMode = !rawMode; mode(); };
    copyButton.onclick = async () => {
      try { if (!current?.raw) throw new Error('原文不可用'); await navigator.clipboard.writeText(current.raw); onStatus('已复制原始请求'); }
      catch (error) { onStatus(error instanceof Error ? error.message : String(error), true); }
    };
    choices.onchange = () => onChoose(choices.value);
    return {
      show(result: PreviewData) {
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
  (globalThis as unknown as {PresetRequestPreview: {mount: typeof mount}}).PresetRequestPreview = Object.freeze({ mount });
})();
