import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutgoingFile, OutgoingImage } from './types.js';
import { DeliveryPreparationError } from './delivery-errors.js';

const MAX_IMAGES = 10;
const DEFAULT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface CollectedImages { text: string; images: OutgoingImage[] }
export interface CollectedAttachments extends CollectedImages { files: OutgoingFile[] }
interface ImageMarker { start: number; end: number; destination: string; description: string; image: boolean }
type CodeContainer = { kind: 'quote' } | { kind: 'list'; width: number };

/** Local preparation failed before any attachment bytes were submitted for delivery. */
export class AttachmentPreparationError extends DeliveryPreparationError {}
class ArtifactReadError extends Error {}
function failed(reason: string): Error { return new ArtifactReadError(reason); }

/** Check every component, including Windows junctions, without following a directory listing. */
async function directoryChain(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw failed('产物目录包含链接或不是普通目录。');
  }
}

function stripContainers(line: string): { content: string; containers: CodeContainer[] } {
  let content = line;
  const containers: CodeContainer[] = [];
  for (;;) {
    const quote = /^ {0,3}>[ \t]?/.exec(content);
    if (quote) { content = content.slice(quote[0].length); containers.push({ kind: 'quote' }); continue; }
    const list = /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/.exec(content);
    if (!list) break;
    content = content.slice(list[0].length);
    containers.push({ kind: 'list', width: list[0].length });
  }
  return { content, containers };
}

function containerContinuation(line: string, containers: CodeContainer[]): string | undefined {
  let content = line;
  for (const container of containers) {
    if (container.kind === 'quote') {
      const quote = /^ {0,3}>[ \t]?/.exec(content);
      if (!quote) return undefined;
      content = content.slice(quote[0].length);
    } else {
      const indentation = /^[ \t]*/.exec(content)![0];
      if (indentation.length < container.width) return undefined;
      content = content.slice(container.width);
    }
  }
  return content;
}

function maskCode(text: string): string {
  const masked = text.split('');
  const hide = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };
  let fence: { character: string; length: number; containers: CodeContainer[] } | undefined;
  let offset = 0;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const value = line[0];
    if (!value) continue;
    const inside = fence ? containerContinuation(value, fence.containers) : undefined;
    if (fence && (inside !== undefined || !value.trim())) {
      hide(offset, offset + value.length);
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(inside ?? value);
      if (closing && closing[1]![0] === fence.character && closing[1]!.length >= fence.length) fence = undefined;
    } else {
      // A quoted/list-contained fence ends when that container ends. Prefixes are
      // removed only for syntax detection; masking retains offsets in the original reply.
      fence = undefined;
      const { content, containers } = stripContainers(value);
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(content);
      if (opening) {
        fence = { character: opening[1]![0]!, length: opening[1]!.length, containers };
        hide(offset, offset + value.length);
      } else if (/^(?: {4}|\t)/.test(content)) hide(offset, offset + value.length);
    }
    offset += value.length;
  }
  let source = masked.join('');
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== '`') continue;
    let length = 1;
    while (source[index + length] === '`') length++;
    const delimiter = '`'.repeat(length);
    let end = source.indexOf(delimiter, index + length);
    while (end !== -1 && (source[end - 1] === '`' || source[end + length] === '`')) end = source.indexOf(delimiter, end + length);
    if (end !== -1) { hide(index, end + length); index = end + length - 1; }
    else index += length - 1;
  }
  source = masked.join('');
  return source;
}

function escaped(text: string, index: number): boolean {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) count++;
  return count % 2 === 1;
}

function markers(text: string, includeFiles = false): ImageMarker[] {
  const source = maskCode(text);
  const result: ImageMarker[] = [];
  for (let start = 0; start < source.length - 3; start++) {
    const image = source[start] === '!' && source[start + 1] === '[' && !escaped(source, start);
    const file = includeFiles && source[start] === '[' && !escaped(source, start) && source[start - 1] !== '!';
    if (!image && !file) continue;
    const labelStart = start + (image ? 2 : 1);
    let cursor = labelStart;
    let depth = 1;
    for (; cursor < source.length && depth; cursor++) {
      if (escaped(source, cursor)) continue;
      if (source[cursor] === '[') depth++;
      if (source[cursor] === ']') depth--;
    }
    if (depth || source[cursor] !== '(') continue;
    const description = text.slice(labelStart, cursor - 1).replace(/\\([\[\]\\])/g, '$1').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 1024);
    cursor++;
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    let destination = '';
    const bracketed = source[cursor] === '<';
    if (bracketed) {
      const begin = ++cursor;
      while (cursor < source.length && (source[cursor] !== '>' || escaped(source, cursor))) cursor++;
      if (cursor >= source.length) continue;
      destination = text.slice(begin, cursor++);
    } else {
      const begin = cursor;
      let parentheses = 0;
      for (; cursor < source.length; cursor++) {
        const character = source[cursor]!;
        if (escaped(source, cursor)) continue;
        if (character === '(') parentheses++;
        if (character === ')') { if (!parentheses) break; parentheses--; }
        if (/\s/.test(character) && !parentheses) break;
      }
      if (parentheses) continue;
      destination = text.slice(begin, cursor).replace(/\\([ ()<>])/g, '$1');
    }
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    if (source[cursor] === '"' || source[cursor] === "'") {
      const quote = source[cursor++]!;
      while (cursor < source.length && (source[cursor] !== quote || escaped(source, cursor))) cursor++;
      if (cursor >= source.length) continue;
      cursor++;
      while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    }
    if (!destination || source[cursor] !== ')') continue;
    if (!image && !bracketed) { start = cursor; continue; }
    result.push({ start, end: cursor + 1, destination, description, image });
    start = cursor;
  }
  return result;
}

function localPath(destination: string, image = true): string | null {
  if (/^https?:\/\//i.test(destination)) return null;
  // Source-location references are navigation, not file-transfer declarations.
  if (!image && (/:\d+(?::\d+)?$/.test(destination)
    || /#(?:L\d+(?:C\d+)?(?:-L?\d+)?|line=\d+)$/i.test(destination))) return null;
  let path = destination;
  if (/^file:/i.test(path)) {
    try { path = fileURLToPath(path); } catch { throw failed('图片的本地文件 URL 无效。'); }
  }
  // Codex desktop Markdown sometimes adds a slash before an otherwise absolute Windows drive path.
  if (/^\/[A-Za-z]:[\/\\]/.test(path)) path = path.slice(1);
  if (!image && !isAbsolute(path)) return null; // Relative links and other URL schemes remain ordinary text.
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw failed('本地产物必须使用绝对文件路径。');
  return resolve(path);
}

function imageType(path: string, header: Buffer): OutgoingImage['contentType'] {
  const extension = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) throw failed(`${basename(path)} 必须使用 PNG/JPG/WebP/GIF 图片扩展名。`);
  // Some capture APIs save JPEG bytes using a .png name. The signature determines
  // the transmitted type/name; disk files and encoded image bytes remain untouched.
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw failed(`${basename(path)} 的文件内容不是 PNG/JPG/WebP/GIF 图片。`);
}

function fileType(path: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown',
    '.csv': 'text/csv', '.json': 'application/json', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Only explicitly declared final-reply attachments are read; unrelated files are never enumerated. */
async function collect(finalText: string, _rootDirectory: string | string[], maxImageBytes: number,
  signal?: AbortSignal, maxFileBytes?: number, declarations?: ImageMarker[]): Promise<CollectedAttachments> {
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes <= 0) throw failed('图片大小上限配置无效。');
  if (maxFileBytes !== undefined && (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0 || maxFileBytes > MAX_FILE_BYTES)) {
    throw failed('文件大小上限必须是 1–25165824 的整数。');
  }
  signal?.throwIfAborted();
  const declared = (declarations ?? markers(finalText, maxFileBytes !== undefined)).map(marker => ({ marker,
    path: declarations ? resolve(marker.destination) : localPath(marker.destination, marker.image) })).filter(item => item.path !== null);
  if (!declared.length) return { text: finalText, images: [], files: [] };
  signal?.throwIfAborted();
  const images: OutgoingImage[] = [];
  const files: OutgoingFile[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  let total = 0;
  const limit = Math.min(maxImageBytes, MAX_IMAGE_BYTES);
  for (const { marker, path } of declared) {
    signal?.throwIfAborted();
    if (!path) throw failed('附件路径无效。');
    await directoryChain(dirname(path));
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) throw failed('附件必须是普通文件，不能使用链接或目录。');
    const actual = await realpath(path);
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (seen.has(key)) continue;
    if (images.length + files.length >= MAX_IMAGES) {
      throw failed(maxFileBytes === undefined ? '本轮最多回传 10 张图片。' : '本轮图片和文件合计最多回传 10 个附件。');
    }
    const byteLimit = marker.image ? limit : maxFileBytes!;
    if (!Number.isSafeInteger(before.size) || before.size < 0 || (marker.image && before.size === 0)
      || before.size > byteLimit || total + before.size > MAX_TOTAL_BYTES) {
      throw failed(`${basename(path)} 超过${marker.image ? '图片' : '文件'}大小上限（${marker.image ? '单图' : '单个文件'}最多 ${byteLimit} 字节，每轮最多 100 MiB）。`);
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw failed('读取前附件文件发生变化。');
      // One extra byte detects growth, while allocations and reads remain bounded by the prior size limit.
      const bounded = Buffer.alloc(info.size + 1);
      let bytes = 0;
      while (bytes < bounded.length) {
        signal?.throwIfAborted();
        const part = await file.read(bounded, bytes, bounded.length - bytes, null);
        if (!part.bytesRead) break;
        bytes += part.bytesRead;
      }
      const after = await file.stat();
      await directoryChain(dirname(path));
      const final = await lstat(path);
      if (bytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || final.isSymbolicLink()
        || final.dev !== info.dev || final.ino !== info.ino || await realpath(path) !== actual) {
        throw failed('读取期间附件文件或路径发生变化，未上传任何附件。');
      }
      data = bounded.subarray(0, bytes);
    } finally { await file.close(); }
    signal?.throwIfAborted();
    const contentType = marker.image ? imageType(path, data.subarray(0, 12)) : fileType(path);
    const extension = marker.image ? (contentType === 'image/jpeg' ? '.jpg' : `.${contentType.slice(6)}`) : extname(path);
    const originalName = `${basename(path, extname(path))}${extension}`;
    let filename = originalName;
    let number = images.length + files.length + 1;
    while (names.has(filename.toLowerCase())) filename = `${number++}-${originalName}`;
    names.add(filename.toLowerCase());
    const attachment = { filename, contentType, data, ...(marker.description ? { description: marker.description } : {}) };
    if (marker.image) images.push(attachment as OutgoingImage);
    else files.push(attachment);
    seen.add(key);
    total += data.length;
  }
  let text = finalText;
  for (let index = declared.length - 1; index >= 0; index--) {
    const marker = declared[index]!.marker;
    text = text.slice(0, marker.start) + text.slice(marker.end);
  }
  return { text: text.trim(), images, files };
}

export async function collectOutgoingImages(finalText: string, rootDirectory: string | string[], maxImageBytes: number,
  signal?: AbortSignal): Promise<CollectedImages> {
  try {
    const { text, images } = await collect(finalText, rootDirectory, maxImageBytes, signal);
    return { text, images };
  } catch (error) { return attachmentFailure(error, signal, '图片回传失败'); }
}

function attachmentFailure(error: unknown, signal: AbortSignal | undefined, label: string): never {
  if (signal?.aborted) throw error;
  if (error instanceof ArtifactReadError) throw new AttachmentPreparationError(`${label}：${error.message}`);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '未知文件错误';
  throw new AttachmentPreparationError(`${label}：无法读取明确声明的附件（${code}），未上传任何附件。请确认绝对路径指向本机可读取的物理文件。`);
}

/** Controller attachments are explicit tool arguments, never inferred from message prose. */
export async function collectOutgoingPaths(paths: string[], rootDirectory: string | string[], maxImageBytes: number,
  maxFileBytes = DEFAULT_FILE_BYTES, signal?: AbortSignal): Promise<CollectedAttachments> {
  try {
    if (!Array.isArray(paths) || paths.length > MAX_IMAGES || paths.some(path => typeof path !== 'string'
      || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) throw failed('附件必须是明确指定的本机绝对文件路径，最多 10 个。');
    const declarations = paths.map(destination => ({ start: 0, end: 0, destination, description: '',
      image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(destination).toLowerCase()) }));
    return await collect('', rootDirectory, maxImageBytes, signal, maxFileBytes, declarations);
  } catch (error) { return attachmentFailure(error, signal, '附件回传失败'); }
}

export async function collectOutgoingAttachments(finalText: string, rootDirectory: string | string[], maxImageBytes: number,
  maxFileBytes = DEFAULT_FILE_BYTES, signal?: AbortSignal): Promise<CollectedAttachments> {
  try { return await collect(finalText, rootDirectory, maxImageBytes, signal, maxFileBytes); }
  catch (error) {
    const filesDeclared = markers(finalText, true).some(marker => !marker.image
      && (/^file:/i.test(marker.destination) || isAbsolute(marker.destination) || /^\/[A-Za-z]:[\/\\]/.test(marker.destination)));
    return attachmentFailure(error, signal, filesDeclared ? '文件回传失败' : '图片回传失败');
  }
}
