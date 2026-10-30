import { createHmac } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { OAuthKeys } from './oauth/index.js';

// 1 つのシークレットから用途ごとの鍵を作る。用途ごとに別の鍵にしておけば、
// たとえば暗号鍵からアクセストークンの署名鍵を推測されることはない
export const deriveKeys = (secret: string): OAuthKeys => {
  const derive = (label: string) => createHmac('sha256', secret).update(label).digest();
  return {
    accessTokenKey: derive('mcp-oauth/access-token'),
    refreshTokenKey: derive('mcp-oauth/refresh-token'),
    encryptionKey: derive('mcp-oauth/upstream-refresh-token'),
  };
};

export const getSecretString = async (region: string, secretId: string): Promise<string> => {
  const { SecretString } = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!SecretString) {
    throw new Error(`Secret ${secretId} has no string value`);
  }
  return SecretString;
};

/** Cognito のクライアントシークレットは CloudFormation の出力や環境変数に載せず、起動時に読む */
export const getCognitoClientSecret = async (input: {
  region: string;
  userPoolId: string;
  clientId: string;
}): Promise<string> => {
  const { UserPoolClient } = await new CognitoIdentityProviderClient({
    region: input.region,
  }).send(
    new DescribeUserPoolClientCommand({ UserPoolId: input.userPoolId, ClientId: input.clientId }),
  );
  if (!UserPoolClient?.ClientSecret) {
    throw new Error(`Cognito app client ${input.clientId} has no client secret`);
  }
  return UserPoolClient.ClientSecret;
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};
