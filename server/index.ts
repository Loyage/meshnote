import 'dotenv/config';
import { createMeshNoteServer } from './app';
import { readConfig, readPort, readSettingsFile } from './config';
import { initialLLMSettings, loadLLMSettings } from './llmSettings';

try {
  const settingsFile = readSettingsFile();
  const settings = await loadLLMSettings(settingsFile, () => initialLLMSettings(readConfig()));
  const config = { ...settings, port: readPort() };
  const server = createMeshNoteServer(config, { settings, settingsFile });
  server.on('error', () => {
    console.error('MeshNote 本地服务无法启动，请检查端口是否已被占用。');
    process.exitCode = 1;
  });
  // Never accept an environment-controlled public bind address in this unauthenticated MVP.
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`MeshNote 本地服务：http://127.0.0.1:${config.port} · ${settings.mode === 'openai-compatible' ? 'OpenAI-compatible' : 'Mock 演示模式'}`);
  });
  for (const event of ['SIGINT', 'SIGTERM'] as const) {
    process.once(event, () => {
      server.close();
      server.closeAllConnections();
    });
  }
} catch {
  // Configuration can contain secrets. Do not print values or raw exceptions.
  console.error('MeshNote 配置无效，请检查模型设置文件（默认 .meshnote/llm-settings.json）或 .env 的路径、端口、模型、base URL 和超时设置。');
  process.exitCode = 1;
}
