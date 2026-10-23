import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'AGENT_PROXY_TARGET');
  const configuredTarget =
    process.env.AGENT_PROXY_TARGET ?? env.AGENT_PROXY_TARGET ?? 'http://127.0.0.1:3002';
  const target = new URL(configuredTarget);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  ) {
    throw new Error('AGENT_PROXY_TARGET 必须是不含凭据、路径和查询参数的 HTTP(S) 服务源');
  }
  const proxy = {
    '/agent-api': {
      target: target.origin,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/agent-api(?=\/|$)/, ''),
    },
  };
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 3003,
      strictPort: true,
      proxy,
      headers: { 'X-Tyde-Dev-Server': 'agent-web' },
    },
    preview: { proxy },
  };
});
