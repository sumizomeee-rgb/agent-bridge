/** 核心只描述内容和语义；颜色、卡片结构、分页属于平台展示。 */
export interface BridgePresentation {
  title: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  purpose?: 'overview' | 'reply' | 'status' | 'help' | 'lifecycle';
  blocks: Array<{ kind: 'text' | 'entry'; text: string }>;
  footer?: string;
}
export const presentationText = (view: BridgePresentation): string =>
  [view.tone === 'error' && !view.title.startsWith('❌') ? '❌ ' + view.title : view.title,
    ...view.blocks.map(block => block.text), ...(view.footer ? [view.footer] : [])].join('\n\n');
export function mapPresentation(view: BridgePresentation, transform: (text: string) => string): BridgePresentation {
  return { ...view, title: transform(view.title), blocks: view.blocks.map(block => ({ ...block, text: transform(block.text) })),
    ...(view.footer ? { footer: transform(view.footer) } : {}) };
}
const titleText = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/`/g, 'ˋ').slice(0, 160);
export function discordPresentationPages(view: BridgePresentation, limit = 2000): string[] {
  const color = view.purpose === 'overview' && view.tone === 'info' ? 33 : { info: 36, success: 32, warning: 33, error: 31 }[view.tone];
  const heading = '```ansi\n\u001b[' + color + 'm' + titleText(view.title) + '\u001b[0m\n```';
  const blocks = [...view.blocks.map(block => block.kind === 'entry' ? '```\n' + block.text + '\n```' : block.text),
    ...(view.footer ? [view.footer] : [])];
  const pages: string[] = []; let page = heading;
  for (const block of blocks) {
    if (heading.length + 2 + block.length > limit) {
      if (page !== heading) { pages.push(page); page = heading; }
      // 大段正文拆页；总览条目在核心中已有长度上限。
      const size = limit - heading.length - 2;
      for (let offset = 0; offset < block.length;) {
        let end = Math.min(offset + size, block.length);
        if (end < block.length && /[\uD800-\uDBFF]/.test(block[end - 1]!)) end--;
        pages.push(heading + '\n\n' + block.slice(offset, end)); offset = end;
      }
    } else if (page.length + 2 + block.length > limit) { pages.push(page); page = heading + '\n\n' + block; }
    else page += '\n\n' + block;
  }
  if (page !== heading || !pages.length) pages.push(page);
  return pages;
}
export function discordPresentationText(view: BridgePresentation): string {
  return discordPresentationPages(view, Number.MAX_SAFE_INTEGER)[0]!;
}
const safeMarkdown = (text: string): string => text.replace(/<(\/?(?:at|person|font|text_tag|number_tag)\b[^>]*>)/gi, '&lt;$1');
/** 正文分片时关闭并续开代码围栏，保留可复制的代码展示。 */
export function markdownParts(text: string, maxBytes = 8000): string[] {
  const parts: string[] = []; let part = '', fence = '', size = 0;
  const flush = () => {
    if (!part) return;
    parts.push(part + (fence ? '\n' + fence.match(/^(`{3,}|~{3,})/)![1] : ''));
    part = fence ? fence + '\n' : ''; size = Buffer.byteLength(part);
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^\s*(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (size + Buffer.byteLength(line) > maxBytes && part) flush();
    if (Buffer.byteLength(line) <= maxBytes - size) { part += line; size += Buffer.byteLength(line); }
    else for (const char of line) {
      const bytes = Buffer.byteLength(char);
      if (size + bytes > maxBytes) flush();
      part += char; size += bytes;
    }
    if (marker) {
      if (!fence) fence = marker[1]! + marker[2]!.trimEnd().slice(0, 120);
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.match(/^(`{3,}|~{3,})/)![1]!.length && !marker[2]!.trim()) fence = '';
    }
  }
  if (part) parts.push(part + (fence ? '\n' + fence.match(/^(`{3,}|~{3,})/)![1] : ''));
  return parts;
}
export function feishuPresentationCards(view: BridgePresentation): Record<string, unknown>[] {
  const template = view.tone === 'error' ? 'red' : view.tone === 'warning' ? 'orange' : view.purpose === 'reply' ? 'green' : 'orange';
  const make = (elements: unknown[], index?: number): Record<string, unknown> => ({ schema: '2.0', config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: titleText(view.title) + (index ? ` · ${index}` : '') } }, body: { elements } });
  const cards: Record<string, unknown>[] = []; let elements: unknown[] = [];
  const blocks = [...view.blocks, ...(view.footer ? [{ kind: 'text' as const, text: view.footer }] : [])];
  for (const block of blocks) for (const content of markdownParts(block.kind === 'entry' ? block.text : safeMarkdown(block.text))) {
    const element = block.kind === 'entry' ? { tag: 'div', text: { tag: 'plain_text', content } } : { tag: 'markdown', content };
    const next = [...elements, ...(elements.length ? [{ tag: 'hr' }] : []), element];
    if (elements.length && (Buffer.byteLength(JSON.stringify(make(next))) > 24 * 1024 || next.length > 40)) {
      cards.push(make(elements)); elements = [element];
    } else elements = next;
  }
  cards.push(make(elements.length ? elements : [{ tag: 'markdown', content: '已完成。' }]));
  return cards.map((card, i) => cards.length > 1 ? { ...card, header: (make([], i + 1)).header } : card);
}
