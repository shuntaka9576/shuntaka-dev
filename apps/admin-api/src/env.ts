export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

// ローカル dev (http) では __Host- プレフィックスと Secure が使えないため切り替える
export const isInsecureCookies = (): boolean => process.env.DEV_INSECURE_COOKIES === '1';
