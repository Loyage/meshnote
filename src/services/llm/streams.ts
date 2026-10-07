/** Decode UTF-8 incrementally, including CRLF split across transport chunks. */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  maxCharacters = 2_000_000,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let characters = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      characters += text.length;
      if (characters > maxCharacters) throw new Error('模型输出超过长度限制');
      buffer += text;
      // A trailing CR is retained until the next chunk determines whether it is CRLF.
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const character = buffer[i];
        if (character !== '\n' && character !== '\r') continue;
        if (character === '\r' && i === buffer.length - 1 && !done) break;
        yield buffer.slice(start, i);
        if (character === '\r' && buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (done) {
        if (buffer) yield buffer;
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** SSE framing, including comments, multiple data lines, and a final un-delimited event. */
export async function* readSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  let data: string[] = [];
  let event = '';
  for await (const line of readLines(stream, signal)) {
    if (!line) {
      if (data.length) yield { event, data: data.join('\n') };
      data = [];
      event = '';
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    if (field === 'event') event = value;
  }
  if (data.length) yield { event, data: data.join('\n') };
}

export function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Whitelist messages only: upstream errors may echo credentials or private response bodies. */
export function safeModelError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError' ? '模型请求超时，请稍后重试' : '已停止生成';
  }
  return '模型请求失败，请检查本地服务的模型配置或稍后重试';
}
