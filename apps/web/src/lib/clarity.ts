export const CLARITY_PROJECT_ID = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || '';

export const isClarityEnabled = (): boolean => {
  return CLARITY_PROJECT_ID !== '';
};
