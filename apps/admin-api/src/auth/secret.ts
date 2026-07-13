import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { requireEnv } from '../env.js';

let cached: string | undefined;

// Cookie 暗号鍵。本番は Secrets Manager (COOKIE_SECRET_ID) から取得してメモ化する。
// ローカル dev は COOKIE_SECRET で直接渡せる
export const getCookieSecret = async (): Promise<string> => {
  if (cached !== undefined) return cached;
  const secret = process.env.COOKIE_SECRET ?? (await fetchFromSecretsManager());
  if (secret.length < 32) {
    throw new Error('cookie secret must be at least 32 characters');
  }
  cached = secret;
  return cached;
};

const fetchFromSecretsManager = async (): Promise<string> => {
  const client = new SecretsManagerClient({});
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: requireEnv('COOKIE_SECRET_ID') }),
  );
  return out.SecretString ?? '';
};
