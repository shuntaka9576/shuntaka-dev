import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: [
      '.claude',
      '.legacy',
      '**/.venv',
      '**/cdk.out',
      '**/dist',
      '**/docs/build',
      '.turbo',
      '**/routeTree.gen.ts',
      '**/.next',
      '**/out',
      '**/target',
      '**/next-env.d.ts',
      '**/storybook-static',
    ],
    options: {
      typeAware: true,
    },
    rules: {
      'no-unused-vars': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/await-thenable': 'error',
    },
  },
  fmt: {
    ignorePatterns: [
      '**/*.json',
      '**/*.yaml',
      '.claude',
      '.legacy',
      '**/.venv',
      '**/cdk.out',
      '**/dist',
      '**/docs/build',
      '.turbo',
      '**/routeTree.gen.ts',
      '**/.next',
      '**/out',
      '**/target',
      '**/next-env.d.ts',
      '**/node_modules/**',
      '**/storybook-static',
    ],
    singleQuote: true,
  },
});
