import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import type { AuthService } from '../modules/auth/auth.service.js';
import type { FileRegistryService } from '../modules/files/file-registry.service.js';

/** 仅供应用装配使用；业务模块不通过它查找其他模块的实现。 */
export interface ModuleContext {
  app: FastifyInstance;
  db: PrismaClient;
  config: Config;
  auth: AuthService;
  files: FileRegistryService;
}
