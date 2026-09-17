const DEFAULT_MCP_NAME_LIMIT = 28;

/** Keep both ends of a long MCP server name because either end may distinguish it. */
export function compactMcpServerName(value, limit = DEFAULT_MCP_NAME_LIMIT) {
  const characters = Array.from(String(value ?? '').trim());
  if (!Number.isInteger(limit) || limit < 5) throw new RangeError('MCP server name limit must be an integer of at least 5');
  if (characters.length <= limit) return characters.join('');
  const visible = limit - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return `${characters.slice(0, head).join('')}…${characters.slice(-tail).join('')}`;
}

export function mcpTabNames(serverName) {
  const fullServerName = String(serverName ?? '').trim();
  return {
    display: `${compactMcpServerName(fullServerName)} · MCP`,
    full: `${fullServerName} · MCP`,
  };
}
