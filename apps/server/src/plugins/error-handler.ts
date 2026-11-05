import { Prisma } from '@prisma/client';
import { API_PREFIX } from '@tyde/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../common/errors.js';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const legacy =
      req.url.startsWith(`${API_PREFIX}/auth/`) ||
      req.url.startsWith(`${API_PREFIX}/files`) ||
      req.url.startsWith(`${API_PREFIX}/users/`) ||
      req.url.startsWith(`${API_PREFIX}/organizations`) ||
      req.url.startsWith(`${API_PREFIX}/project-categories`) ||
      req.url.startsWith(`${API_PREFIX}/project-requesters`) ||
      req.url.startsWith(`${API_PREFIX}/projects/`) ||
      req.url.startsWith(`${API_PREFIX}/expert-assignments/`) ||
      req.url.startsWith(`${API_PREFIX}/project-personnel/`) ||
      req.url.startsWith(`${API_PREFIX}/production-tasks/`) ||
      req.url.startsWith(`${API_PREFIX}/entrance-exams/`) ||
      req.url.startsWith(`${API_PREFIX}/integrations/agents/entrance-exam-grading/`);
    const failure = (status: number, code: string, message: string) =>
      legacy
        ? { code: status === 429 ? 4292 : status, message, data: null }
        : { code, message, requestId: req.id };
    if (error instanceof AppError) {
      if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
      return reply.code(error.status).send(failure(error.status, error.code, error.message));
    }
    if (error.validation || error.statusCode === 400 || error.statusCode === 413)
      return reply
        .code(error.statusCode === 413 ? 413 : 400)
        .send(
          failure(error.statusCode === 413 ? 413 : 400, 'VALIDATION_ERROR', '请求字段或格式不正确'),
        );
    const unavailable =
      error instanceof Prisma.PrismaClientInitializationError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(error.code));
    // 不记录错误 message / SQL / 请求体，避免其中夹带验证码和数据库连接串。
    req.log.error(
      { errorType: error.name, errorCode: 'code' in error ? error.code : undefined },
      'request failed',
    );
    return reply
      .code(unavailable ? 503 : 500)
      .send(
        failure(
          unavailable ? 503 : 500,
          unavailable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
          unavailable ? '服务暂不可用，请稍后重试' : '操作失败，请稍后重试',
        ),
      );
  });
}
