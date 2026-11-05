import { expect, test } from 'vitest';
import { MOCK_CODE, normalizeProfile, validateTransport } from '../../src/modules/auth/security.js';
test('registration profile and mock verification contract', () => {
  expect(MOCK_CODE).toBe('095270');
  expect(normalizeProfile('ALex_01', '小明')).toEqual({ username: 'alex_01', displayName: '小明' });
  expect(() =>
    validateTransport({ 'x-tyde-client': 'desktop', origin: 'https://trusted.test' }, 'POST', [
      'https://trusted.test',
    ]),
  ).toThrow();
});
