import { readFileSync } from 'node:fs';

export function dshTemplateUiScript() {
  const code = ['../../lib/macros.mjs', '../../lib/dsh-template-source.mjs', '../../web/dsh-template-editor.js']
    .map(file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')).join('\n');
  return '(() => {\n' + code + '\nglobalThis.renderDshSections = renderDshSections;\n})();\n';
}
