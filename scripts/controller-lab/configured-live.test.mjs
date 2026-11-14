import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineTestSelection } from './configured-live.mjs';

test('baseline guard permits only Luna or explicit authorized Haiku identities without launching an Agent', () => {
  assert.equal(baselineTestSelection({ agent: 'codex' }).model, 'gpt-6-luna');
  for (const controllerModel of ['haiku', 'claude-haiku-5.5']) {
    assert.deepEqual(baselineTestSelection({ agent: 'claude', controllerModel }), { model: controllerModel, effort: 'low', targets: ['local'] });
  }
  for (const [agent, controllerModel] of [['claude', 'opus'], ['claude', 'claude-opus-5.5'], ['codex', 'gpt-6.1-sol'], ['codex', 'claude-haiku-5.5']])
    assert.throws(() => baselineTestSelection({ agent, controllerModel }), /authorized Luna\/Haiku/);
});

test('baseline guard rejects remote targets and stronger effort', () => {
  assert.throws(() => baselineTestSelection({ agent: 'claude', targets: ['office'] }), /local worker/);
  assert.throws(() => baselineTestSelection({ agent: 'codex', controllerEffort: 'xhigh' }), /low/);
});
