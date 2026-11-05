import Fastify from 'fastify';
import { createApp, fastifyOptions } from './application.js';
import { readConfig } from './config/index.js';
import { registerWeb } from './plugins/static-web.js';

// Vercel imports this entrypoint; it manages the HTTP listener itself.
// Vercel's framework detection requires a direct fastify import in this file.
const config = readConfig();
const app = Fastify(fastifyOptions(config));
await createApp(config, undefined, app);
await registerWeb(app);
await app.ready();

export default app.server;
