import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type ICognitoStorage,
} from 'amazon-cognito-identity-js';

export interface SrpTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

// amazon-cognito-identity-js は既定で localStorage にトークンをキャッシュする。
// トークンはサーバ側セッション (HttpOnly Cookie) にのみ持たせる設計のため、
// インメモリ storage を渡して永続化を避ける
class MemoryStorage implements ICognitoStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const requireViteEnv = (name: string, value: string | undefined): string => {
  if (value === undefined || value === '') {
    throw new Error(`${name} が未設定です (.env.local を確認してください)`);
  }
  return value;
};

// USER_SRP_AUTH でログインし、トークン 3 本を返す (パスワードは平文送信されない)
export function srpLogin(username: string, password: string): Promise<SrpTokens> {
  const storage = new MemoryStorage();
  const pool = new CognitoUserPool({
    UserPoolId: requireViteEnv(
      'VITE_COGNITO_USER_POOL_ID',
      import.meta.env.VITE_COGNITO_USER_POOL_ID,
    ),
    ClientId: requireViteEnv('VITE_COGNITO_CLIENT_ID', import.meta.env.VITE_COGNITO_CLIENT_ID),
    Storage: storage,
  });
  const user = new CognitoUser({ Username: username, Pool: pool, Storage: storage });
  return new Promise((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
      onSuccess: (session) => {
        resolve({
          accessToken: session.getAccessToken().getJwtToken(),
          idToken: session.getIdToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
        });
      },
      onFailure: (err: Error) => {
        reject(err);
      },
      newPasswordRequired: () => {
        reject(
          new Error('初回パスワードの変更が必要です。admin-set-user-password を実行してください'),
        );
      },
    });
  });
}
