import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { requireEnv } from '../env.js';

const userPoolId = (): string => requireEnv('COGNITO_USER_POOL_ID');
const clientId = (): string => requireEnv('COGNITO_CLIENT_ID');
// user pool ID は "<region>_<id>" 形式
const region = (): string => userPoolId().split('_')[0];
const issuer = (): string => `https://cognito-idp.${region()}.amazonaws.com/${userPoolId()}`;

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cognito: CognitoIdentityProviderClient | undefined;

const getJwks = (): ReturnType<typeof createRemoteJWKSet> => {
  jwks ??= createRemoteJWKSet(new URL(`${issuer()}/.well-known/jwks.json`));
  return jwks;
};

const getCognito = (): CognitoIdentityProviderClient => {
  cognito ??= new CognitoIdentityProviderClient({ region: region() });
  return cognito;
};

// access token の署名 / issuer / token_use / client_id を検証する
export const verifyAccessToken = async (token: string): Promise<JWTPayload> => {
  const { payload } = await jwtVerify(token, getJwks(), { issuer: issuer() });
  if (payload.token_use !== 'access') {
    throw new Error('token_use must be access');
  }
  if (payload.client_id !== clientId()) {
    throw new Error('client_id mismatch');
  }
  return payload;
};

export interface RefreshedTokens {
  accessToken: string;
  idToken: string;
}

export const refreshTokens = async (refreshToken: string): Promise<RefreshedTokens> => {
  const out = await getCognito().send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId(),
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );
  const result = out.AuthenticationResult;
  if (result?.AccessToken === undefined || result.IdToken === undefined) {
    throw new Error('refresh failed: no tokens returned');
  }
  return { accessToken: result.AccessToken, idToken: result.IdToken };
};

export const revokeRefreshToken = async (refreshToken: string): Promise<void> => {
  await getCognito().send(new RevokeTokenCommand({ ClientId: clientId(), Token: refreshToken }));
};
