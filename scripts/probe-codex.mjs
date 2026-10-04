import { loadConfig, agentEnvironment } from '../dist/src/config.js';
import { JsonLineProcess, JsonRpcClient } from '../dist/src/agents/process.js';
const config = loadConfig([]);
const transport = new JsonLineProcess(config.commands.codex, ['app-server', '--listen', 'stdio://'], config.workspace, agentEnvironment(config));
const rpc = new JsonRpcClient(transport);
try {
  await rpc.request('initialize', { clientInfo: { name: 'bridge_protocol_probe', version: '0.1.0' }, capabilities: { experimentalApi: false } });
  rpc.notify('initialized');
  const result = await rpc.request('thread/start', { cwd: config.workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  if (!result.thread?.id) throw new Error('No native thread returned');
  console.log(JSON.stringify({ codexProtocol: 'ok', nativeThreadCreated: true, modelProvider: result.modelProvider, credentialsPrinted: false, modelTurnSubmitted: false }));
} finally {
  await transport.stop(true);
  rpc.close();
}
