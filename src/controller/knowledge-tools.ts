import { harnessText } from '../harness.js';
import type { JsonObject } from '../agents/process.js';

const text = (description: string): JsonObject => ({ type: 'string', description });
const object = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: 'object', properties, required, additionalProperties: false });
const ids = { type: 'array', items: { type: 'string' }, maxItems: 30 };
export const knowledgeTools: { name: string; description: string; inputSchema: JsonObject }[] = [
  { name: 'bridge_search_chat_history', description: harnessText('tools.bridge_search_chat_history.description'),
    inputSchema: object({ query: text(harnessText('tools.bridge_search_chat_history.inputSchema.query.description')), startTime: text(harnessText('tools.bridge_search_chat_history.inputSchema.startTime.description')), endTime: text(harnessText('tools.bridge_search_chat_history.inputSchema.endTime.description')), limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }, cursor: text(harnessText('tools.bridge_search_chat_history.inputSchema.cursor.description')) }) },
  { name: 'bridge_read_chat_history', description: harnessText('tools.bridge_read_chat_history.description'),
    inputSchema: object({ messageId: text(harnessText('tools.bridge_read_chat_history.inputSchema.messageId.description')), before: { type: 'integer', minimum: 0, maximum: 5, default: 3 }, after: { type: 'integer', minimum: 0, maximum: 5, default: 5 }, textOffset: { type: 'integer', minimum: 0, description: harnessText('tools.bridge_read_chat_history.inputSchema.textOffset.description') } }, ['messageId']) },
  { name: 'bridge_list_tasks', description: harnessText('tools.bridge_list_tasks.description'),
    inputSchema: object({ id: text(harnessText('tools.bridge_list_tasks.inputSchema.id.description')), includeClosed: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }, cursor: text(harnessText('tools.bridge_list_tasks.inputSchema.cursor.description')) }) },
  { name: 'bridge_update_tasks', description: harnessText('tools.bridge_update_tasks.description'),
    inputSchema: object({ changes: { type: 'array', minItems: 1, maxItems: 10, items: object({ id: text(harnessText('tools.bridge_update_tasks.inputSchema.changes.items.id.description')), expectedVersion: { type: 'integer', minimum: 0 }, title: text(harnessText('tools.bridge_update_tasks.inputSchema.changes.items.title.description')),
      state: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'paused', 'done', 'cancelled', 'superseded'] }, requirements: text(harnessText('tools.bridge_update_tasks.inputSchema.changes.items.requirements.description')), nextStep: text(harnessText('tools.bridge_update_tasks.inputSchema.changes.items.nextStep.description')), remaining: text(harnessText('tools.bridge_update_tasks.inputSchema.changes.items.remaining.description')), evidenceIds: ids, workerIds: ids, jobIds: ids }, ['id', 'expectedVersion']) } }, ['changes']) },
];
