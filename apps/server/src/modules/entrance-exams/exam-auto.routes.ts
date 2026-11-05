import type { FastifyInstance } from 'fastify';
import { AppError } from '../../common/errors.js';
import type { Config } from '../../config/index.js';
import { autoCallbackPath, verifyAutoCallback } from './exam-auto-signature.js';
import { autoCallbackSchema } from './exam-auto.schema.js';
import type { AutoCallbackInput } from './exam-auto.types.js';
import type { ExamGradingCommandService } from './exam-grading-command.service.js';
export async function examAutoCallbackRoutes(
  parent: FastifyInstance,
  service: ExamGradingCommandService,
  config: Config,
) {
  await parent.register(async (app) => {
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 4 * 1024 * 1024 },
      (req, body, done) => {
        try {
          verifyAutoCallback(
            config.autoGradingSecret,
            req.headers['x-agent-timestamp'],
            req.headers['x-agent-signature'],
            body as Buffer,
          );
          done(null, JSON.parse((body as Buffer).toString('utf8')));
        } catch (error) {
          done(
            error instanceof SyntaxError
              ? new AppError(400, 'VALIDATION_ERROR', '回调JSON格式错误')
              : (error as Error),
          );
        }
      },
    );
    app.post<{ Body: AutoCallbackInput }>(
      autoCallbackPath,
      { schema: autoCallbackSchema, bodyLimit: 4 * 1024 * 1024 },
      async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { code: 200, message: '操作成功', data: await service.callback(req.body) };
      },
    );
  });
}
