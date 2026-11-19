import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'drizzle/', 'website/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ['src/**/*.ts'] })),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      curly: ['error', 'all'],
      'no-lonely-if': 'error',
      'no-else-return': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-eval': 'error',
    },
  },
];
