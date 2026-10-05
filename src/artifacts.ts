import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutgoingImage } from './types.js';

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface CollectedImages { text: string; images: OutgoingImage[] }
interface ImageMarker { start: number; end: number; destination: string; description: string }
type CodeContainer = { kind: 'quote' } | { kind: 'list'; width: number };

function failed(reason: string): Error { return new Error(`图片回传失败：${reason}`); }
function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

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

function markers(text: string): ImageMarker[] {
  const source = maskCode(text);
  const result: ImageMarker[] = [];
  for (let start = 0; start < source.length - 3; start++) {
    if (source[start] !== '!' || source[start + 1] !== '[' || escaped(source, start)) continue;
    let cursor = start + 2;
    let depth = 1;
    for (; cursor < source.length && depth; cursor++) {
      if (escaped(source, cursor)) continue;
      if (source[cursor] === '[') depth++;
      if (source[cursor] === ']') depth--;
    }
    if (depth || source[cursor] !== '(') continue;
    const description = text.slice(start + 2, cursor - 1).replace(/\\([\[\]\\])/g, '$1').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 1024);
    cursor++;
    while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
    let destination = '';
    if (source[cursor] === '<') {
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
    result.push({ start, end: cursor + 1, destination, description });
    start = cursor;
  }
  return result;
}

function localPath(destination: string): string | null {
  if (/^https?:\/\//i.test(destination)) return null;
  let path = destination;
  if (/^file:/i.test(path)) {
    try { path = fileURLToPath(path); } catch { throw failed('图片的本地文件 URL 无效。'); }
  }
  // Codex desktop Markdown sometimes adds a slash before an otherwise absolute Windows drive path.
  if (/^\/[A-Za-z]:[\/\\]/.test(path)) path = path.slice(1);
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw failed('本地图片必须使用允许目录内的绝对文件路径。');
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

/** Only explicitly declared final-reply images are read; unrelated files are never enumerated. */
async function collect(finalText: string, rootDirectory: string | string[], maxImageBytes: number,
  signal?: AbortSignal): Promise<CollectedImages> {
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes <= 0) throw failed('图片大小上限配置无效。');
  signal?.throwIfAborted();
  const declared = markers(finalText).map(marker => ({ marker, path: localPath(marker.destination) })).filter(item => item.path !== null);
  if (!declared.length) return { text: finalText, images: [] };
  signal?.throwIfAborted();
  const roots = [...new Set((Array.isArray(rootDirectory) ? rootDirectory : [rootDirectory]).map(root => resolve(root)))];
  const actualRoots = new Map<string, string>();
  const images: OutgoingImage[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  let total = 0;
  const limit = Math.min(maxImageBytes, MAX_IMAGE_BYTES);
  for (const { marker, path } of declared) {
    signal?.throwIfAborted();
    const root = path ? roots.find(candidate => contained(candidate, path)) : undefined;
    if (!root) throw failed('声明的图片不在允许的工作目录或历史产物目录内，未上传任何图片。');
    let actualRoot = actualRoots.get(root);
    if (!actualRoot) {
      // Only validate a root used by this declaration. A missing legacy output
      // directory must not obstruct plain replies or images in an existing cwd.
      await directoryChain(root);
      actualRoot = await realpath(root);
      actualRoots.set(root, actualRoot);
    }
    if (!path) throw failed('图片路径无效。');
    await directoryChain(dirname(path));
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw failed('图片必须是普通文件，不能使用链接或目录。');
    const actual = await realpath(path);
    if (!contained(actualRoot, actual)) throw failed('图片真实路径越过允许的目录。');
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual;
    if (seen.has(key)) continue;
    if (images.length >= MAX_IMAGES) throw failed('本轮最多回传 10 张图片。');
    if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > limit || total + before.size > MAX_TOTAL_BYTES) {
      throw failed(`${basename(path)} 超过图片大小上限（单图最多 ${limit} 字节，每轮最多 100 MiB）。`);
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink > 1 || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw failed('读取前图片文件发生变化。');
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
        || final.dev !== info.dev || final.ino !== info.ino || final.nlink > 1 || !contained(actualRoot, await realpath(path))) {
        throw failed('读取期间图片文件或路径发生变化，未上传任何图片。');
      }
      data = bounded.subarray(0, bytes);
    } finally { await file.close(); }
    signal?.throwIfAborted();
    const contentType = imageType(path, data.subarray(0, 12));
    const extension = contentType === 'image/jpeg' ? '.jpg' : `.${contentType.slice(6)}`;
    let filename = `${basename(path, extname(path))}${extension}`;
    if (names.has(filename.toLowerCase())) filename = `${images.length + 1}-${filename}`;
    names.add(filename.toLowerCase());
    images.push({ filename, contentType, data, ...(marker.description ? { description: marker.description } : {}) });
    seen.add(key);
    total += data.length;
  }
  let text = finalText;
  for (let index = declared.length - 1; index >= 0; index--) {
    const marker = declared[index]!.marker;
    text = text.slice(0, marker.start) + text.slice(marker.end);
  }
  return { text: text.trim(), images };
}

export async function collectOutgoingImages(finalText: string, rootDirectory: string | string[], maxImageBytes: number,
  signal?: AbortSignal): Promise<CollectedImages> {
  try { return await collect(finalText, rootDirectory, maxImageBytes, signal); }
  catch (error) {
    if (signal?.aborted || (error instanceof Error && error.message.startsWith('图片回传失败：'))) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '未知文件错误';
    throw failed(`无法读取明确声明的图片（${code}），未上传任何图片。请确认文件已保存到允许目录。`);
  }
}
