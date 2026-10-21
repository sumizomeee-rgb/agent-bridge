import { loadHostConfig, agentEnvironment } from '../dist/src/config.js';
import { JsonLineProcess, JsonRpcClient } from '../dist/src/agents/process.js';
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('用法：node scripts/probe-codex.mjs [--config 配置路径] [--profile 已启动Profile]；多个 Bot 时必须明确 --profile。仅握手并建立临时原生会话，不提交模型任务。');
  process.exit(0);
}
const host = loadHostConfig(argv, false);
const selected = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : undefined;
if (!selected && host.configs.length !== 1) throw new Error('多个 Bot 的宿主必须用 --profile 明确选择探针身份。');
const config = selected ? host.configs.find(config => config.profile === selected) : host.configs[0];
if (!config) throw new Error('未找到已启动的 Bot Profile。');
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
