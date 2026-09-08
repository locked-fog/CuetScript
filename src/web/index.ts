#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { networkInterfaces, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWebServer } from './server.js';
const command = new Command()
  .name('cuet-web')
  .option('--stories-dir <path>', '故事仓库父目录', './stories')
  .option('--host <address>', '监听地址；局域网访问使用 0.0.0.0', '127.0.0.1')
  .option('--port <number>', '端口', '3210')
  .option('--deepseek-key-file <path>')
  .option('--siliconflow-key-file <path>')
  .option('--agy-auth-dir <path>');
command.parse();
const opts = command.opts();
const port = Number(opts.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid port');
function localDefault(relative: string) {
  const path = join(homedir(), '.config', relative);
  return existsSync(path) ? path : undefined;
}
const app = createWebServer({
  directory: resolve(opts.storiesDir),
  deepseekKeyFile:
    opts.deepseekKeyFile ??
    process.env.CUET_DEEPSEEK_KEY_FILE ??
    localDefault('llm-api-keys/deepseek-api-key'),
  siliconflowKeyFile:
    opts.siliconflowKeyFile ??
    process.env.CUET_SILICONFLOW_KEY_FILE ??
    localDefault('llm-api-keys/siliconflow-api-key'),
  agyAuthDir:
    opts.agyAuthDir ?? process.env.CUET_AGY_AUTH_DIR ?? localDefault('cuetscript/antigravity'),
  token: process.env.CUET_WEB_TOKEN,
});
app.server.on('error', () => {
  console.error('无法启动 Web 服务，请检查监听地址和端口。');
  process.exitCode = 1;
});
app.server.listen(port, opts.host, () => {
  const address = app.server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(`CuetScript: http://127.0.0.1:${actual}/#token=${app.token}`);
  if (opts.host === '0.0.0.0')
    for (const interfaces of Object.values(networkInterfaces()))
      for (const i of interfaces ?? [])
        if (i.family === 'IPv4' && !i.internal)
          console.log(`局域网: http://${i.address}:${actual}/`);
  console.log(`访问口令: ${app.token}`);
});
process.once('SIGINT', () => app.close());
process.once('SIGTERM', () => app.close());
