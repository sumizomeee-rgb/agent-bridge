import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessText } from './harness.js';
import type { BridgeConfig, DiscordAttachment, IncomingDM } from './types.js';

export interface IncomingFile { filename: string; path: string; size: number; contentType: string }
export interface IncomingFileLimits { maxFileBytes: number; maxTotalBytes: number; maxAttachments: number }
const defaults: IncomingFileLimits = { maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxAttachments: 10 };
export function incomingFileLimits(value?: unknown): IncomingFileLimits {
  if (value == null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('incomingAttachmentLimitsByPlatform 配置无效。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new Error('收件附件限制包含未知字段。');
  const result = { ...defaults, ...input } as IncomingFileLimits;
  if (Object.values(result).some(n => !Number.isSafeInteger(n) || n <= 0) || result.maxFileBytes > result.maxTotalBytes || result.maxAttachments > 100)
    throw new Error('收件附件限制须为正整数，单文件不超过合计，数量不超过100。');
  return result;
}
export function incomingImage(item: DiscordAttachment): boolean {
  if (item.resourceKey) return item.content_type === 'image/unknown';
  return !!item.content_type?.toLowerCase().startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(item.filename);
}
interface DownloadResponse {
  ok: boolean; status: number; headers: { get(name: string): string | null };
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array>; cancel(): Promise<void> } | null;
}
/** Save bytes, never parse or execute user files. Signed URLs and API tokens stay out of the manifest. */
export async function receiveIncomingFiles(config: BridgeConfig, message: IncomingDM, imagePaths: string[],
  download: (item: DiscordAttachment) => Promise<DownloadResponse>): Promise<IncomingFile[]> {
  const limits = incomingFileLimits(config.incomingAttachmentLimits);
  if (message.attachments.length > limits.maxAttachments) throw new Error('附件接收失败：单条消息附件数量超过上限。');
  let total = 0;
  for (const path of imagePaths) total += (await stat(path)).size;
  const files: IncomingFile[] = [];
  try {
    for (const item of message.attachments.filter(item => !incomingImage(item))) {
      if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > limits.maxFileBytes || total + item.size > limits.maxTotalBytes)
        throw new Error('附件接收失败：文件声明大小超过收件限制或无效。');
      await mkdir(config.attachmentsDir, { recursive: true });
      const response = await download(item);
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error(`附件接收失败：下载 HTTP ${response.status}。`); }
      const limit = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > limit) { await response.body.cancel().catch(() => {}); throw new Error('附件接收失败：文件实际大小超过收件限制。'); }
      const suffix = /\.([a-zA-Z0-9]{1,16})$/.exec(item.filename)?.[1]?.toLowerCase();
      const path = join(config.attachmentsDir, randomUUID() + (suffix ? '.' + suffix : '.bin')), temporary = path + '.part';
      let file: Awaited<ReturnType<typeof open>> | undefined, bytes = 0, complete = false;
      const reader = response.body.getReader();
      try {
        file = await open(temporary, 'wx', 0o600);
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.length;
          if (bytes > limit) throw new Error('附件接收失败：文件实际大小超过收件限制。');
          await file.writeFile(part.value);
        }
        await file.close(); file = undefined;
        await rename(temporary, path); complete = true; total += bytes;
        files.push({ path, size: bytes, filename: item.filename.slice(0, 512), contentType: (item.content_type ?? 'application/octet-stream').slice(0, 255) });
      } finally {
        await reader.cancel().catch(() => {}); reader.releaseLock(); await file?.close().catch(() => {});
        if (!complete) await unlink(temporary).catch(() => {});
      }
    }
    if (total > limits.maxTotalBytes) throw new Error('附件接收失败：消息附件合计超过收件限制。');
    return files;
  } catch (error) {
    await Promise.all(files.map(file => unlink(file.path).catch(() => {})));
    if (error instanceof Error && error.message.startsWith('附件接收失败：')) throw error;
    throw new Error('附件接收失败：下载或保存文件失败。');
  }
}
export function incomingFileManifest(files: IncomingFile[]): string {
  return files.length ? harnessText('incoming.files_manifest', { files: JSON.stringify(files) }) : '';
}
