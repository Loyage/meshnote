import { type Server } from 'node:http';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing');
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function collectText(stream: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const text of stream) result += text;
  return result;
}
