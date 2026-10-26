import { platform } from '@tyde/platform';

/** 两端认证、个人中心、组织管理及本人业务操作共用真实 HTTP/Cookie 接口。 */
export const api = platform.auth;
export const isDesktop = platform.isElectron;
export const capabilities = platform.capabilities;
