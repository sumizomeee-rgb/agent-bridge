import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isObject, safeError, type JsonObject } from '../../../agents/process.js';
import { controllerEntryTools } from '../../tools/entry.js';
import { mcpToolContent } from '../../image-content.js';

interface ClaudeMcpOptions {
  dataDir: string;
  internalBotCommunicationEnabled?: boolean;
  invoke: (name: string, args: JsonObject, matched: () => void) => Promise<unknown>;
}

/** A per-controller loopback endpoint; its caller owns listening and shutdown. */
export function createClaudeMcpServer(options: ClaudeMcpOptions) {
    const token = randomUUID();
    const diagnosticPath = join(options.dataDir, 'mcp-diagnostic.jsonl');
    const diagnostic = (value: JsonObject): void => {
      try { appendFileSync(diagnosticPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); } catch { /* 诊断失败不影响工具执行。 */ }
    };
    const server = createServer(async (req, res) => {
      // This loopback JSON endpoint needs no persistent connection. Fresh sockets
      // avoid stale pooled connections in the Claude CLI between model responses;
      // never retry a tool here, since it may already have performed a side effect.
      res.setHeader('Connection', 'close');
      const started = Date.now(), requestKey = randomUUID();
      let method: string | undefined, name: string | undefined, phase = 'received';
      let requestId: string | number | null = null;
      diagnostic({ requestKey, event: 'received', httpMethod: req.method, bytes: req.headers['content-length'] ?? null });
      req.once('aborted', () => diagnostic({ requestKey, event: 'aborted', phase }));
      res.once('close', () => diagnostic({ requestKey, event: 'closed', phase, method, name, status: res.statusCode, complete: res.writableFinished, ms: Date.now() - started }));
      if (req.url !== `/${token}` || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      try {
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error('MCP 请求超过限制。'); chunks.push(chunk as Buffer); }
        const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObject(request)) throw new Error('MCP 请求格式无效。');
        requestId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
        method = typeof request.method === 'string' ? request.method : undefined;
        phase = 'parsed';
        if (request.id == null) { res.writeHead(202); res.end(); return; }
        let result: unknown;
        if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bridge_controller', version: '1' } };
        else if (request.method === 'tools/list') result = { tools: controllerEntryTools };
        else if (request.method === 'tools/call') {
          const params = isObject(request.params) ? request.params : {};
          name = typeof params.name === 'string' ? params.name : undefined; phase = 'tool-matching';
          if (typeof params.name !== 'string' || !isObject(params.arguments)) throw new Error('没有当前主控轮次或参数无效。');
          result = { content: mcpToolContent(await options.invoke(params.name, params.arguments, () => { phase = 'invoking'; })) };
          phase = 'invoked';
        } else result = {};
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      } catch (error) {
        diagnostic({ requestKey, event: 'error', phase, method, name, errorType: error instanceof Error ? error.name : 'unknown' });
        const message = safeError(error instanceof Error ? error.message : error, 'MCP 请求失败');
        // 工具失败是可供模型处理的结果，不能伪装成 HTTP 传输失败。
        const toolError = method === 'tools/call' && requestId !== null;
        res.writeHead(toolError ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: requestId, ...(toolError
          ? { result: { isError: true, content: [{ type: 'text', text: message }] } }
          : { error: { code: error instanceof SyntaxError ? -32700 : -32600, message } }) }));
      }
    });
    server.on('clientError', (error, socket) => { diagnostic({ event: 'client-error', errorType: error.name, code: (error as NodeJS.ErrnoException).code ?? null }); socket.destroy(); });
    return { server, token };
}
