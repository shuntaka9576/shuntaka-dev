import { describe, expect, it } from 'bun:test';
import { canBypassAuth } from './middleware.js';

const localEnv = {
  DEV_AUTH_BYPASS: '1',
  DEV_INSECURE_COOKIES: '1',
} as NodeJS.ProcessEnv;

describe('canBypassAuth', () => {
  it('明示設定された localhost だけを許可する', () => {
    expect(canBypassAuth('http://localhost:43001/api/me', localEnv)).toBe(true);
    expect(canBypassAuth('http://127.0.0.1:43001/api/me', localEnv)).toBe(true);
    expect(canBypassAuth('https://admin.example.com/api/me', localEnv)).toBe(false);
  });

  it('Lambda 環境では設定されていても許可しない', () => {
    expect(
      canBypassAuth('http://localhost:43001/api/me', {
        ...localEnv,
        AWS_LAMBDA_FUNCTION_NAME: 'admin-api',
      }),
    ).toBe(false);
  });
});
