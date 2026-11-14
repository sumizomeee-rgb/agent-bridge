import assert from 'node:assert/strict';
import test from 'node:test';
import { ControllerHistoryService, type HistoryCaller, type HistoryEndpoint } from '../src/controller/history.js';

test('history authorization stays identical across ports and cannot grant another owner or a forged scope', () => {
  let reads = 0;
  const target: HistoryEndpoint = { controllerId: 'target', principalId: 'owner', platform: 'feishu',
    userId: 'principal:owner', authorized: true,
    routes: [{ userId: 'other', channelId: 'other-dm', private: true },
      { userId: 'principal:owner', channelId: 'owner-dm', private: true },
      { userId: 'principal:owner', channelId: 'group', private: false }],
    query(scope, name, input) { reads++; assert.equal(scope.userId, 'principal:owner'); assert.equal(scope.channelId, 'owner-dm');
      assert.equal(scope.historyBotId, 'target'); return { name, input }; } };
  const service = new ControllerHistoryService(id => id === 'target' ? target : undefined);
  const caller: HistoryCaller = { controllerId: 'client', principalId: 'owner' };
  const own = (input: Record<string, unknown>) => ({ own: input });
  assert.deepEqual(service.query(caller, 'bridge_search_chat_history', { query: 'self' }, own), { own: { query: 'self' } });
  assert.deepEqual(service.query(caller, 'bridge_search_chat_history', { targetBotId: 'client' }, own), { own: {} });
  const result = service.query(caller, 'bridge_search_chat_history', { targetBotId: 'target', query: 'saved' }, own) as any;
  assert.equal(result.targetBotId, 'target'); assert.equal(result.input.query, 'saved'); assert.equal(reads, 1);
  assert.throws(() => service.query({ ...caller, principalId: 'other' }, 'bridge_search_chat_history', { targetBotId: 'target' }, own), /目标须/);
  assert.throws(() => service.query({ ...caller, platform: 'discord' }, 'bridge_read_chat_history', { targetBotId: 'target' }, own), /同平台/);
  assert.throws(() => service.query(caller, 'bridge_update_tasks', { targetBotId: 'target' }, own), /只读/);
  target.authorized = false;
  assert.throws(() => service.query(caller, 'bridge_search_chat_history', { targetBotId: 'target' }, own), /目标须/);
  assert.equal(reads, 1);
});
