import assert from 'node:assert/strict';

/** Real controller and worker generations; only the remote roster is an isolated fixture. */
export async function runWorkerSelectionLive({ agent, model, checkpoints, send, finished, wait, receipt, getRuntime, getStore, getConversationId, reopen, save }) {
  const prefix = '这是已授权的隔离主控派工测试；只有本地接收器，没有真实用户或远端业务操作。';
  await checkpoints('one grouped discovery and initial local follow dispatch', async () => {
    const start = receipt.tools.length;
    await send('selection-follow', prefix + '只调用一次 bridge_list_targets 获取全部电脑及助手清单。在 local 上使用默认助手派工一次；子任务禁止工具，仅计算17+25并输出 LAB_SELECTION_42。派工后最终回复 LAB_SELECTION_DISPATCHED；以后每次收到该助手结果，用 LAB_SELECTION_RESULT 加上真实结果汇报，不要再派工。');
    await finished('selection-follow');
    await wait(() => receipt.workerRuns[0]?.finishedAt && getRuntime().isIdle() && receipt.deliveries.some(v => v.text.includes('LAB_SELECTION_RESULT')), 'selection worker result');
    assert.equal(receipt.tools.slice(start).filter(v => v.name === 'bridge_list_targets').length, 1);
    assert.equal(receipt.workerRuns.length, 1); assert.match(receipt.workerRuns[0].result, /LAB_SELECTION_42/);
    assert.equal(receipt.selectionDispatches[0].model, model); assert.equal(receipt.selectionDispatches[0].effort, 'xhigh');
    assert(receipt.groupedOverview.computers.some(v => v.targetId === 'local' && v.defaultAssistant.kind === 'follow'));
    assert(receipt.groupedOverview.computers.some(v => v.targetId === 'lab-remote' && v.defaultAssistant === null));
  });
  const initialNative = getStore().getConversation(getConversationId()).nativeId;
  await checkpoints('unconfigured remote default rejects without worker or controller death', async () => {
    const before = getRuntime().store.workers().length;
    await send('selection-unset', prefix + '只做一个预期失败的参数检查：调用 bridge_start_worker，targetId=lab-remote，assistant={kind:"default"}，title="默认未设置检查"，prompt="不执行，仅测试拒绝"。该电脑尚未设置默认，收到错误后不要重新派工或改选，直接回复 LAB_REMOTE_DEFAULT_UNSET 和真实错误。');
    await finished('selection-unset'); assert.equal(getRuntime().store.workers().length, before);
    assert(receipt.selectionRejections.some(v => v.includes('尚未设置默认助手')));
    assert(receipt.deliveries.some(v => v.text.includes('LAB_REMOTE_DEFAULT_UNSET')));
    assert.equal(getStore().getConversation(getConversationId()).nativeId, initialNative);
  });
  await checkpoints('slash settings persist through restart, existing worker remains unchanged', async () => {
    await send('selection-setting', `/default agentworker local ${agent} ${model} xhigh`);
    assert.equal(getRuntime().store.workerDefault('local').kind, 'ordinary');
    const old = getRuntime().store.workers()[0];
    await reopen();
    assert.deepEqual(getRuntime().store.workerDefault('local'), { kind: 'ordinary', agent, model, effort: 'xhigh' });
    assert.equal(getRuntime().store.getWorker(old.id).nativeId, old.nativeId);
    assert.equal(getStore().getConversation(getConversationId()).nativeId, initialNative);
  });
  await checkpoints('real controller uses saved ordinary default after restart', async () => {
    const priorResults = receipt.deliveries.filter(v => v.text.includes('LAB_SELECTION_RESULT')).length;
    await send('selection-fixed', prefix + 'local 的默认助手已经由用户设置。请使用 local 的默认助手新派工一次，不要自行填写模型或后端；任务禁止工具，仅计算17+25并输出 LAB_SELECTION_42。派工后最终回复 LAB_FIXED_DISPATCHED；后续结果用 LAB_SELECTION_RESULT 汇报。');
    await finished('selection-fixed');
    await wait(() => receipt.workerRuns[1]?.finishedAt && getRuntime().isIdle() && receipt.deliveries.filter(v => v.text.includes('LAB_SELECTION_RESULT')).length > priorResults, 'saved default result');
    assert.equal(receipt.workerRuns.length, 2); assert.match(receipt.workerRuns[1].result, /LAB_SELECTION_42/);
    assert.equal(receipt.selectionDispatches[1].model, model); assert.equal(receipt.selectionDispatches[1].effort, 'xhigh');
    assert.equal(getStore().getConversation(getConversationId()).nativeId, initialNative);
  });
  await checkpoints('foreign engine rejected and next independent input still replies', async () => {
    const before = getRuntime().store.workers().length;
    await send('selection-foreign', prefix + `这是一次预期失败的电脑归属检查：只调用一次 bridge_start_worker，targetId=lab-remote，assistant={kind:"ordinary",agent:"${agent}",model:"${model}"}。title="引擎归属检查"，prompt="不执行，仅测试拒绝"。该电脑没有登记这个引擎；收到错误后不改选，回复 LAB_FOREIGN_REJECTED 和真实原因。`);
    await finished('selection-foreign'); assert.equal(getRuntime().store.workers().length, before);
    assert(receipt.selectionRejections.some(v => v.includes('未登记')));
    await send('selection-alive', prefix + '不使用工具，只回复 LAB_SELECTION_STILL_ALIVE。'); await finished('selection-alive');
    assert(receipt.deliveries.some(v => v.text.includes('LAB_SELECTION_STILL_ALIVE')));
  });
  await checkpoints('workers hides finished assistants and history retains them', async () => {
    const before = receipt.deliveries.length;
    await send('selection-workers', '/workers'); await send('selection-history', '/workers history');
    const replies = receipt.deliveries.slice(before);
    assert(replies[0].text.includes('运行0个')); assert(!replies[0].text.includes('LAB_SELECTION_42'));
    assert(replies[1].text.includes('历史')); assert.equal(receipt.workerRuns.length, 2);
  });
  receipt.selectionStatus = 'passed'; save();
}
