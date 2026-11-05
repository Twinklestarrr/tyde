import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { registerBrowserTransport } from './browser-transport.js';
import { registerDocs } from './swagger.js';

export async function registerHttpPlugins(app: FastifyInstance, config: Config) {
  await app.register(cookie);
  registerBrowserTransport(app, config);
  await registerDocs(app, config);
}
