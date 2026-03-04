const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const net = require('net');
const { MessageBus } = require('./message-bus');
const { SessionRegistry } = require('./session-registry');

// Parse CLI args
const args = process.argv.slice(2);
const sessionIdIdx = args.indexOf('--session-id');
const SESSION_ID = sessionIdIdx !== -1 ? args[sessionIdIdx + 1] : 'unknown';
const IPC_PATH = process.env.NEXUS_IPC_PATH || '\\\\.\\pipe\\claude-nexus-ipc';

// Shared state (connected to main process via IPC)
const messageBus = new MessageBus();
const registry = new SessionRegistry();

// Connect to main Electron process for shared state
let ipcClient;

function connectToMainProcess() {
  ipcClient = net.createConnection(IPC_PATH, () => {
    // Register this session
    sendIpc({ type: 'register', sessionId: SESSION_ID });
  });

  ipcClient.on('data', (data) => {
    try {
      const messages = data.toString().split('\n').filter(Boolean);
      for (const msg of messages) {
        const parsed = JSON.parse(msg);
        handleIpcMessage(parsed);
      }
    } catch (e) {
      process.stderr.write(`IPC parse error: ${e.message}\n`);
    }
  });

  ipcClient.on('error', (err) => {
    process.stderr.write(`IPC connection error: ${err.message}\n`);
  });
}

function sendIpc(data) {
  if (ipcClient && !ipcClient.destroyed) {
    ipcClient.write(JSON.stringify(data) + '\n');
  }
}

function handleIpcMessage(msg) {
  // Handle responses from main process
  if (msg.type === 'sessions') {
    // Update local registry from main process
    msg.sessions.forEach(s => registry.register(s.id, s));
  }
  if (msg.type === 'message') {
    messageBus.send(msg.from, SESSION_ID, msg.message, msg.priority);
  }
}

// Create MCP server
const server = new McpServer({
  name: 'claude-nexus',
  version: '0.1.0',
});

// --- Core Communication Tools ---

server.tool(
  'list_sessions',
  'List all active Claude Code sessions in the Nexus terminal',
  {},
  async () => {
    sendIpc({ type: 'list_sessions' });
    // Wait briefly for response
    await new Promise(r => setTimeout(r, 100));
    const sessions = registry.list();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(sessions, null, 2),
      }],
    };
  }
);

server.tool(
  'send_message',
  'Send a message to another Claude session',
  {
    target_session_id: z.string().describe('ID of the target session'),
    message: z.string().describe('Message content'),
    priority: z.enum(['normal', 'urgent']).default('normal').describe('Message priority'),
  },
  async ({ target_session_id, message, priority }) => {
    sendIpc({
      type: 'send_message',
      from: SESSION_ID,
      to: target_session_id,
      message,
      priority,
    });
    return {
      content: [{ type: 'text', text: `Message sent to ${target_session_id}` }],
    };
  }
);

server.tool(
  'read_messages',
  'Read incoming messages from other sessions',
  {
    since_timestamp: z.number().optional().describe('Only messages after this Unix timestamp (ms)'),
    limit: z.number().default(50).describe('Max messages to return'),
  },
  async ({ since_timestamp, limit }) => {
    sendIpc({ type: 'read_messages', sessionId: SESSION_ID, since_timestamp, limit });
    await new Promise(r => setTimeout(r, 100));
    const messages = messageBus.read(SESSION_ID, { sinceTimestamp: since_timestamp, limit });
    return {
      content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
    };
  }
);

server.tool(
  'broadcast',
  'Send a message to all other sessions',
  {
    message: z.string().describe('Message to broadcast'),
  },
  async ({ message }) => {
    sendIpc({ type: 'broadcast', from: SESSION_ID, message });
    return {
      content: [{ type: 'text', text: 'Message broadcast to all sessions' }],
    };
  }
);

// --- Session Management Tools ---

server.tool(
  'spawn_session',
  'Spawn a new Claude Code session in a new tab',
  {
    working_directory: z.string().describe('Working directory for the new session'),
    initial_prompt: z.string().describe('Initial task/prompt for the new session'),
    label: z.string().optional().describe('Tab label'),
    template: z.enum(['implementer', 'researcher', 'reviewer', 'explorer']).default('implementer')
      .describe('Session template restricting available capabilities'),
  },
  async ({ working_directory, initial_prompt, label, template }) => {
    sendIpc({
      type: 'spawn_session',
      from: SESSION_ID,
      working_directory,
      initial_prompt,
      label: label || 'Worker',
      template,
    });
    await new Promise(r => setTimeout(r, 500));
    return {
      content: [{ type: 'text', text: `Session spawned: ${label || 'Worker'} in ${working_directory}` }],
    };
  }
);

server.tool(
  'get_session_status',
  'Check the status of a session',
  {
    session_id: z.string().describe('ID of the session to check'),
  },
  async ({ session_id }) => {
    sendIpc({ type: 'get_session_status', sessionId: session_id });
    await new Promise(r => setTimeout(r, 100));
    const session = registry.get(session_id);
    const result = messageBus.getResult(session_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ session, result }, null, 2),
      }],
    };
  }
);

server.tool(
  'report_result',
  'Report task completion result back to the lead session',
  {
    result: z.string().describe('Result description or data'),
    status: z.enum(['success', 'failure']).describe('Whether the task succeeded or failed'),
  },
  async ({ result, status }) => {
    sendIpc({
      type: 'report_result',
      sessionId: SESSION_ID,
      result,
      status,
    });
    return {
      content: [{ type: 'text', text: `Result reported: ${status}` }],
    };
  }
);

// --- Shared Scratchpad Tools ---

server.tool(
  'scratchpad_set',
  'Store a value in the shared scratchpad (visible to all sessions)',
  {
    key: z.string().describe('Key to store under'),
    value: z.string().describe('Value to store'),
    namespace: z.string().optional().describe('Optional namespace for organization'),
  },
  async ({ key, value, namespace }) => {
    sendIpc({ type: 'scratchpad_set', key, value, namespace, from: SESSION_ID });
    return {
      content: [{ type: 'text', text: `Stored: ${namespace ? namespace + '.' : ''}${key}` }],
    };
  }
);

server.tool(
  'scratchpad_get',
  'Retrieve a value from the shared scratchpad',
  {
    key: z.string().describe('Key to retrieve'),
    namespace: z.string().optional().describe('Optional namespace'),
  },
  async ({ key, namespace }) => {
    sendIpc({ type: 'scratchpad_get', key, namespace });
    await new Promise(r => setTimeout(r, 100));
    return {
      content: [{ type: 'text', text: '(value will be returned via IPC)' }],
    };
  }
);

server.tool(
  'scratchpad_list',
  'List all keys in the shared scratchpad',
  {
    namespace: z.string().optional().describe('Optional namespace filter'),
  },
  async ({ namespace }) => {
    sendIpc({ type: 'scratchpad_list', namespace });
    await new Promise(r => setTimeout(r, 100));
    return {
      content: [{ type: 'text', text: '(keys will be returned via IPC)' }],
    };
  }
);

// --- Cross-Session Intelligence Tools ---

server.tool(
  'read_session_history',
  'Read terminal output from another session',
  {
    session_id: z.string().describe('Session to read from'),
    last_n_lines: z.number().default(100).describe('Number of recent lines to return'),
  },
  async ({ session_id, last_n_lines }) => {
    sendIpc({ type: 'read_session_history', targetSessionId: session_id, lastNLines: last_n_lines });
    await new Promise(r => setTimeout(r, 200));
    return {
      content: [{ type: 'text', text: '(history will be returned via IPC)' }],
    };
  }
);

server.tool(
  'search_across_sessions',
  'Search through all sessions output for a pattern',
  {
    pattern: z.string().describe('Search pattern (regex supported)'),
    session_ids: z.array(z.string()).optional().describe('Specific sessions to search (default: all)'),
  },
  async ({ pattern, session_ids }) => {
    sendIpc({ type: 'search_sessions', pattern, sessionIds: session_ids });
    await new Promise(r => setTimeout(r, 300));
    return {
      content: [{ type: 'text', text: '(search results will be returned via IPC)' }],
    };
  }
);

server.tool(
  'spawn_explorer',
  'Spawn a read-only explorer session that can cross-reference other sessions',
  {
    task_description: z.string().describe('What to analyze across sessions'),
    session_ids_to_review: z.array(z.string()).describe('Which sessions to review'),
  },
  async ({ task_description, session_ids_to_review }) => {
    sendIpc({
      type: 'spawn_session',
      from: SESSION_ID,
      working_directory: process.cwd(),
      initial_prompt: `You are an explorer session. Your task: ${task_description}. Review sessions: ${session_ids_to_review.join(', ')}`,
      label: 'Explorer',
      template: 'explorer',
    });
    return {
      content: [{ type: 'text', text: `Explorer session spawned to analyze: ${task_description}` }],
    };
  }
);

// --- Context Management Tools ---

server.tool(
  'reset_session',
  'Reset a session with auto-summary (clears context, preserves progress)',
  {
    session_id: z.string().describe('Session to reset'),
    preserve_summary: z.boolean().default(true).describe('Inject summary into fresh session'),
  },
  async ({ session_id, preserve_summary }) => {
    sendIpc({ type: 'reset_session', sessionId: session_id, preserveSummary: preserve_summary });
    return {
      content: [{ type: 'text', text: `Reset requested for session ${session_id}` }],
    };
  }
);

server.tool(
  'save_checkpoint',
  'Save current session state as a named checkpoint',
  {
    label: z.string().optional().describe('Checkpoint label'),
  },
  async ({ label }) => {
    sendIpc({ type: 'save_checkpoint', sessionId: SESSION_ID, label });
    return {
      content: [{ type: 'text', text: `Checkpoint saved${label ? ': ' + label : ''}` }],
    };
  }
);

// Start server
async function main() {
  try {
    connectToMainProcess();
  } catch (e) {
    process.stderr.write(`Failed to connect to main process: ${e.message}\n`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Nexus MCP server started for session ${SESSION_ID}\n`);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
