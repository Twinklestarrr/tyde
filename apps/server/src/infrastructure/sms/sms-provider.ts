export interface SmsProvider {
  readonly mode: 'mock' | 'sms';
  send(phoneE164: string, code: string, requestId: string): Promise<void>;
}
// 唯一 mock 边界：不发送短信。challenge、限流、用户、会话都是真实数据库记录。
export class MockSmsProvider implements SmsProvider {
  readonly mode = 'mock' as const;
  async send(_phoneE164: string, _code: string, _requestId: string): Promise<void> {
    /* intentionally no SMS */
  }
}
