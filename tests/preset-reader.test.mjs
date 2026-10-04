import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetReader, PRESET_READ_BASE } from '../lib/preset-reader.mjs';
function fixture() {
 const agent = { session: { id: 's' } }; let current = agent;
 const state = { revision: 4, selectedPresetId: 'p', presets: [{ id: 'p', name: 'Example', preset: { prompts: [{ identifier: 'main', content: 'saved' }] } }], global: { secret: 'no' }, sessions: { s: { raw: 'no' } } };
 const reader = createPresetReader({ agents: { get: id => id === 's' ? current : undefined } }, async () => state, () => ({ enabled: true, presetId: 'p' }));
 return { reader, agent, state, remove: () => { current = undefined; }, async http(path, token, method = 'GET') {
  let status, body;
  await reader.handler({ method, url: PRESET_READ_BASE + path, headers: { authorization: token ? 'Bearer ' + token : undefined, 'x-agent-id': 's' } }, { writeHead: s => { status = s; }, end: s => { body = JSON.parse(s); } });
  return { status, body };
 } };
}
test('read API returns paginated summaries, exact saved content and current state without side effects', async () => {
 const f=fixture(); try {
 const token=f.reader.service.issueHttpAccess(f.agent).token;
 const list=await f.http('/presets?limit=1',token); assert.equal(list.status,200); assert.equal(list.body.items[0].promptCount,1); assert.equal(list.body.items[0].content,undefined);
 const detail=await f.http('/presets/p',token); assert.equal(detail.body.preset.content.prompts[0].content,'saved');
 const current=await f.http('/current',token); assert.equal(current.body.enabled,true); assert.equal(current.body.global,undefined); assert.equal(current.body.sessions,undefined);
 const direct=await f.reader.service.read(f.agent,{action:'get',id:'p'}); direct.preset.content.prompts[0].content='changed'; assert.equal(f.state.presets[0].preset.prompts[0].content,'saved');
 assert.equal(JSON.parse(await f.reader.tool.execute({action:'current'},{agent:f.agent})).presetId,'p');
 } finally { f.reader.close(); }
});
test('HTTP and tool reads reject forged identity, writes, cross-session input and stale credentials', async () => {
 const f=fixture();
 assert.equal((await f.http('/presets')).status,401);
 assert.throws(()=>f.reader.service.issueHttpAccess({session:{id:'s'}}),/身份/);
 const first=f.reader.service.issueHttpAccess(f.agent).token;
 const second=f.reader.service.issueHttpAccess(f.agent).token;
 assert.equal((await f.http('/presets',first)).status,401);
 assert.equal((await f.http('/presets',second,'POST')).status,405);
 assert.equal((await f.http('/current?sessionId=other',second)).status,400);
 assert.equal((await f.http('/presets?limit=999',second)).status,400);
 assert.equal((await f.http('/presets/missing',second)).status,404);
 await assert.rejects(f.reader.tool.execute({action:'current'},{agent:{session:{id:'s'}}}),/身份/);
 f.remove(); assert.equal((await f.http('/presets',second)).status,403);
 f.reader.close(); assert.equal((await f.http('/presets',second)).status,401);
});
