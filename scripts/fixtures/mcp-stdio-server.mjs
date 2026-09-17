#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [sdkRoot, serverName, marker] = process.argv.slice(2);
if (!sdkRoot || !serverName || !marker) {
  console.error('usage: mcp-stdio-server.mjs <sdk-root> <server-name> <marker>');
  process.exit(2);
}

const fromSdk = relative => pathToFileURL(path.join(sdkRoot, 'dist', 'esm', ...relative.split('/'))).href;
const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
  import(fromSdk('server/index.js')),
  import(fromSdk('server/stdio.js')),
  import(fromSdk('types.js')),
]);

const server = new Server(
  { name: serverName, version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: `Echo from ${serverName}`,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  }],
}));

server.setRequestHandler(types.CallToolRequestSchema, async request => ({
  content: [{ type: 'text', text: `${marker}:${request.params.arguments?.text ?? ''}` }],
}));

await server.connect(new StdioServerTransport());
