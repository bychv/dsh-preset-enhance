import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMcpServerName, mcpTabNames } from '../web/tool-labels.js';

test('short MCP server names stay complete and appear before the MCP marker', () => {
  assert.equal(compactMcpServerName('github'), 'github');
  assert.deepEqual(mcpTabNames('github'), {
    display: 'github · MCP',
    full: 'github · MCP',
  });
});

test('long similar MCP names keep distinct prefixes and suffixes with middle ellipsis', () => {
  const primary = 'company_shared_service_prefix_database_primary';
  const secondary = 'company_shared_service_prefix_database_secondary';
  const compactPrimary = compactMcpServerName(primary);
  const compactSecondary = compactMcpServerName(secondary);

  assert.notEqual(compactPrimary, compactSecondary);
  assert.equal(compactPrimary.startsWith('company_shared'), true);
  assert.equal(compactPrimary.endsWith('primary'), true);
  assert.equal(compactSecondary.startsWith('company_shared'), true);
  assert.equal(compactSecondary.endsWith('secondary'), true);
  assert.equal(compactPrimary.includes('…'), true);
  assert.equal(compactSecondary.includes('…'), true);
  assert.equal(Array.from(compactPrimary).length, 28);
  assert.equal(mcpTabNames(primary).display, `${compactPrimary} · MCP`);
  assert.equal(mcpTabNames(primary).full, `${primary} · MCP`);
});
