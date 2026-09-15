// Execução local (dev): sobe o servidor num host/porta. Em produção, use a Vercel
// (api/index.ts). Rode: npm run build && npm start
import { readConfig } from './auth.js';
import { createApp } from './app.js';

const config = readConfig(process.env);
const server = createApp(config).listen(config.port, config.host, () => {
  console.log(`Segundo Cérebro (MCP) em ${config.host}:${config.port} — público: ${config.publicUrl}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
