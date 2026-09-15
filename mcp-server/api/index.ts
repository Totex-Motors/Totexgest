// Ponto de entrada na Vercel: expõe o app Express como função serverless.
// O vercel.json reescreve TODAS as rotas (/mcp, /.well-known/*, /healthz) pra cá.
import { readConfig } from '../src/auth.js';
import { createApp } from '../src/app.js';

export default createApp(readConfig(process.env));
