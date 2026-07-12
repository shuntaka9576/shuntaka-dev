interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_IMAGES_BASE_URL?: string;
  readonly VITE_PREVIEW_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
