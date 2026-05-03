import tseslint from 'typescript-eslint'
import eslintReact from '@eslint-react/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'apps/api/prisma/**',
    ],
  },

  // TypeScript rules for all source files
  {
    files: ['**/*.{ts,tsx}'],
    extends: tseslint.configs.recommended,
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // React rules — web app only
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [
      eslintReact.configs['recommended-typescript'],
      reactHooks.configs.flat['recommended-latest'],
    ],
    plugins: {
      'react-refresh': reactRefresh,
    },
    settings: {
      'react-x': { version: 'detect' },
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // react-hooks/set-state-in-effect: pattern is valid in controlled sync effects
      'react-hooks/set-state-in-effect': 'off',
      // react-hooks/use-memo: non-inline callbacks are fine when extracted for readability
      'react-hooks/use-memo': 'off',
    },
  },
)
