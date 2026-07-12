export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

// ローカル dev (http) では __Host- プレフィックスと Secure が使えないため切り替える
export const isInsecureCookies = (): boolean => process.env.DEV_INSECURE_COOKIES === '1';

// ローカル dev 限定: Cognito 未構築でも CRUD を疎通できるよう認証・CSRF を素通しする
export const isDevAuthBypass = (): boolean => process.env.DEV_AUTH_BYPASS === '1';

// DEV_AUTH_BYPASS 時に成り代わる users.name (本番の認証は Cognito username → users.name)
export const devAuthBypassUser = (): string => process.env.DEV_AUTH_BYPASS_USER ?? 'shuntaka';
