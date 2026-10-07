import { describe, expect, it } from 'vitest';
import { readLines, readSSE } from './streams';

function stream(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += size));
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const results: T[] = [];
  for await (const value of iterable) results.push(value);
  return results;
}

describe('stream framing', () => {
  it('decodes split multibyte characters, LF, CRLF and CR without losing final line', async () => {
    expect(await collect(readLines(stream('你好\r\n世界\n末尾\r结尾')))).toEqual(['你好', '世界', '末尾', '结尾']);
  });
  it('supports comments, event fields, multiline data and final SSE without blank line', async () => {
    const input = ': keepalive\r\nevent: message\r\ndata: {\r\ndata: "值": "中文"}\r\n\r\ndata: [DONE]';
    expect(await collect(readSSE(stream(input)))).toEqual([
      { event: 'message', data: '{\n"值": "中文"}' }, { event: '', data: '[DONE]' },
    ]);
  });
  it('limits output length and rejects invalid UTF-8', async () => {
    await expect(collect(readLines(stream('12345'), undefined, 4))).rejects.toThrow('长度限制');
    await expect(collect(readLines(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([255])); c.close(); } })))).rejects.toThrow();
  });
  it('cancels a stalled reader when aborted', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const reading = collect(readLines(new ReadableStream({ cancel() { cancelled = true; } }), controller.signal));
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
  it('cancels source after consumers stop early', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('one\ntwo\n')); },
      cancel() { cancelled = true; },
    });
    for await (const _line of readLines(source)) break;
    expect(cancelled).toBe(true);
  });
});
