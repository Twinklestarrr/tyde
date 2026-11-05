import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';

export async function registerDocs(app: FastifyInstance, config: Config) {
  // 必须在业务路由之前注册，动态收集路由 schema。
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'tyde API',
        version: '0.1.0',
        description: '大陆手机号认证 API。开发/测试短信验证码为字符串 095270。',
      },
      tags: [
        { name: 'Auth', description: '验证码、注册与会话' },
        { name: 'Files', description: '文件上传、一次性认领凭证与鉴权代理' },
        { name: 'Health', description: '存活与数据库就绪检查' },
      ],
      components: {
        securitySchemes: {
          webSession: {
            type: 'apiKey',
            in: 'cookie',
            name: config.cookieSecure ? '__Host-tyde_session' : 'tyde_session',
            description:
              'Web 与 Electron 页面 fetch 均使用 HttpOnly Cookie。Web 使用 SameSite=Lax；DESKTOP_ORIGINS 精确匹配的桌面页面使用 SameSite=None、Secure，跨源 fetch 须携带 credentials: include。',
          },
          desktopSession: {
            type: 'http',
            scheme: 'bearer',
            description:
              '仅非浏览器 API 客户端使用 accessToken；可声明 X-Tyde-Client: desktop，禁止 Origin、Cookie 和 sec-fetch-*。Electron 页面使用 Cookie，不使用此 Bearer 方案。',
          },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: `${API_PREFIX}/docs`,
    staticCSP: true,
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: false },
  });
}
