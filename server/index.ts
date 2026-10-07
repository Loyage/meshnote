import 'dotenv/config';
import { createMeshNoteServer } from './app';
import { readConfig } from './config';

try {
  const config = readConfig();
  const server = createMeshNoteServer(config);
  server.on('error', () => {
    console.error('MeshNote 本地服务无法启动，请检查端口是否已被占用。');
    process.exitCode = 1;
  });
  // Never accept an environment-controlled public bind address in this unauthenticated MVP.
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`MeshNote 本地服务：http://127.0.0.1:${config.port} · ${config.apiKey ? 'OpenAI-compatible' : 'Mock 演示模式'}`);
  });
  for (const event of ['SIGINT', 'SIGTERM'] as const) {
    process.once(event, () => {
      server.close();
      server.closeAllConnections();
    });
  }
} catch {
  // Configuration can contain secrets. Do not print values or raw exceptions.
  console.error('MeshNote 配置无效，请检查 .env 的端口、模型、base URL 和超时设置。');
  process.exitCode = 1;
}
