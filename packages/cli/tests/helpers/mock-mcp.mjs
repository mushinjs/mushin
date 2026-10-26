// A tiny MCP server over stdio for tests: echo, add (read-only), fail, and a tool that appears later.
import { createInterface } from 'node:readline'

const tools = [
  { name: 'echo_text', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
]

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
process.stderr.write(`mock MCP server started with ${process.env.MOCK_SECRET ? 'a secret' : 'no secret'}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'mock', version: '1.0.0' } } })
  } else if (message.method === 'tools/list') {
    // Two pages, to exercise the cursor.
    if (!message.params?.cursor) send({ id: message.id, result: { tools: tools.slice(0, 2), nextCursor: 'p2' } })
    else send({ id: message.id, result: { tools: tools.slice(2) } })
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params
    if (name === 'echo_text') send({ id: message.id, result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } })
    else if (name === 'add') send({ id: message.id, result: { content: [{ type: 'text', text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } } })
    else if (name === 'grow') send({ id: message.id, result: { content: [{ type: 'text', text: 'grown' }] } })
    else if (name === 'fail') send({ id: message.id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } })
    if (name === 'echo_text' && args.text === 'grow') {
      tools.push({ name: 'grow', description: 'Appeared later', inputSchema: { type: 'object' } })
      send({ method: 'notifications/tools/list_changed' })
    }
  } else if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: 'unknown method' } })
  }
})
