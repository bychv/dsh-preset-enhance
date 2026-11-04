// Shared attachment presentation for the two iframe editors.
function enhanceContextAttachment(card: HTMLElement): void {
  card.classList.add('preset-attachment');
  const image = card.querySelector<HTMLImageElement>('img');
  const info = card.querySelector<HTMLElement>('.ctx-card-info, .context-file-info');
  const remove = card.querySelector<HTMLButtonElement>('button');
  card.title = info?.textContent ?? '';
  if (remove) {
    remove.className = 'preset-attachment-remove';
    remove.textContent = '×';
    remove.title = remove.getAttribute('aria-label') ?? '移除附件';
  }
  if (!image) return;
  card.classList.add('preset-attachment-image');
  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'preset-attachment-thumbnail';
  preview.title = '查看原图';
  preview.setAttribute('aria-label', '查看原图 ' + image.alt);
  const media = image.parentElement!;
  preview.append(image);
  media.replaceWith(preview);
  preview.onclick = () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'preset-attachment-lightbox';
    dialog.setAttribute('aria-label', '图片预览');
    const original = document.createElement('img');
    // 原图可能是 8 MiB 级别的 data URL：异步解码，避免打开灯箱时阻塞主线程。
    original.decoding = 'async';
    original.src = image.src;
    original.alt = image.alt;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'preset-attachment-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭图片预览');
    close.onclick = () => dialog.close();
    dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
    dialog.onclose = () => { dialog.remove(); if (preview.isConnected) preview.focus(); };
    dialog.append(original, close);
    document.body.append(dialog);
    dialog.showModal();
    close.focus();
  };
}

(globalThis as typeof globalThis & {
  enhanceContextAttachment?: typeof enhanceContextAttachment;
}).enhanceContextAttachment = enhanceContextAttachment;

export {};
