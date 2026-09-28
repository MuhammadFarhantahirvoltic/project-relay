import { McpServer } from '@modelcontextprotocol/server';
import { PROTOCOL_VERSION } from './store.js';
import { AGENT_INSTRUCTIONS, dispatch, TOOLS } from './tools.js';
import { errorBody } from './errors.js';
export function createMcpServer(store, token, signal) {
    store.authenticate(token);
    return createBoundMcpServer(() => ({ store, token }), signal);
}
// A plugin can expose its tools before enrollment. The resolver binds once,
// after explicit CLI setup; tool arguments can never change that connection.
export function createBoundMcpServer(connection, signal) {
    const server = new McpServer({ name: 'project-relay', version: '0.3.0' }, { instructions: AGENT_INSTRUCTIONS });
    for (const tool of TOOLS) {
        server.registerTool(tool.name, {
            description: tool.description,
            inputSchema: tool.schema,
            annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
        }, async (input, context) => {
            try {
                const { store, token } = connection();
                const result = await dispatch(store, token, tool.name, input, signal ? AbortSignal.any([signal, context.mcpReq.signal]) : context.mcpReq.signal);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
            }
            catch (error) {
                const result = { protocolVersion: PROTOCOL_VERSION, ok: false, error: errorBody(error) };
                return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
            }
        });
    }
    server.registerResource('coordination-guide', 'relay://guide', { mimeType: 'text/plain', description: 'How to coordinate across agents safely and recover from interruptions.' }, async (uri) => {
        const { store, token } = connection();
        store.authenticate(token);
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: AGENT_INSTRUCTIONS }] };
    });
    return server;
}
