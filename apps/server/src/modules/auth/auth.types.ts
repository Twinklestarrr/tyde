import type { BusinessRole } from '@tyde/shared';
export type ClientType = 'web' | 'desktop';
export interface AuthPrincipal {
  userId: string;
  uid: string;
  sessionId: string;
  role: BusinessRole;
  clientType: ClientType;
}
