import { crc32, inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// 内部品牌对象避免将文件正文、助手输出或普通 JSON 误当作图片协议。
export class ControllerImageResult {
  constructor(readonly metadata: Record<string, unknown>, readonly data: string) {}
}

export function pngImage(bytes: Buffer): { width: number; height: number } | undefined {
  if (!bytes.subarray(0, 8).equals(signature)) return undefined;
  const bad = () => new Error('PNG 损坏或格式不受支持；仅支持非交错、8 位灰度/RGB/RGBA PNG。');
  let offset = 8, width = 0, height = 0, channels = 0, ended = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw bad();
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) throw bad();
    const name = bytes.toString('ascii', offset + 4, offset + 8), payload = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(name) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw bad();
    if (offset === 8 && name !== 'IHDR') throw bad();
    if (name === 'IHDR') {
      if (offset !== 8 || size !== 13) throw bad();
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('PNG 尺寸超过边长 8192 或 1600 万像素上限。');
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[payload[9]!] ?? 0;
      if (payload[8] !== 8 || !channels || payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0) throw bad();
    } else if (name === 'IDAT') {
      if (dataEnded) throw bad();
      compressed.push(payload);
    } else if (name === 'IEND') {
      if (size || !compressed.length || end !== bytes.length) throw bad();
      ended = true;
    } else {
      if (compressed.length) dataEnded = true;
      // 不支持调色板、动画及影响渲染的扩展，拒绝未知关键块。
      // 只接收有界的颜色和分辨率信息，不传入文本、EXIF 或压缩配置块。
      if (!(name === 'sRGB' && size === 1 && payload[0]! <= 3
        || name === 'gAMA' && size === 4 && payload.readUInt32BE(0) > 0
        || name === 'pHYs' && size === 9 && payload[8]! <= 1)) throw bad();
    }
    offset = end;
  }
  if (!ended) throw bad();
  const rowBytes = width * channels + 1, expected = rowBytes * height;
  let pixels: Buffer;
  const packed = Buffer.concat(compressed);
  try {
    const decoded = inflateSync(packed, { maxOutputLength: expected, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (decoded.engine.bytesWritten !== packed.length) throw bad();
    pixels = decoded.buffer;
  } catch { throw bad(); }
  if (pixels.length !== expected) throw bad();
  for (let row = 0; row < height; row++) if (pixels[row * rowBytes]! > 4) throw bad();
  return { width, height };
}

export function codexToolContent(value: unknown) {
  return value instanceof ControllerImageResult
    ? [{ type: 'inputText', text: JSON.stringify(value.metadata) }, { type: 'inputImage', imageUrl: `data:image/png;base64,${value.data}` }]
    : [{ type: 'inputText', text: JSON.stringify(value ?? null) }];
}

export function mcpToolContent(value: unknown) {
  return value instanceof ControllerImageResult
    ? [{ type: 'text', text: JSON.stringify(value.metadata) }, { type: 'image', mimeType: 'image/png', data: value.data }]
    : [{ type: 'text', text: JSON.stringify(value) }];
}
