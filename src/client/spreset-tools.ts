interface SPresetDocument { dsh_spreset_tools_enabled?: boolean; extensions?: { SPreset?: Record<string, unknown> } }
export function renderSPresetTools(preset: SPresetDocument): void {
  const control = document.getElementById('spreset-tools-enabled') as HTMLInputElement | null;
  if (control) control.checked = preset.dsh_spreset_tools_enabled === true;
  const notice = document.getElementById('spreset-tools-status');
  if (notice) {
    const settings = preset.extensions?.SPreset;
    const unsupported = (settings?.FinalRequestProcessing as { enabled?: boolean })?.enabled;
    notice.textContent = unsupported ? '此预设还包含最终请求脚本，本实验暂不执行该部分。' : '脚本仅支持纯 JavaScript；调用消费开启时跳过工具执行。';
  }
}
export function bindSPresetTools(read: () => SPresetDocument, changed: () => void): void {
  document.getElementById('spreset-tools-enabled')?.addEventListener('change', event => {
    read().dsh_spreset_tools_enabled = (event.target as HTMLInputElement).checked;
    changed();
  });
}
