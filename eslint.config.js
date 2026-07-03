import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // React-Compiler-readiness rules (eslint-plugin-react-hooks v7). mtape does
      // not run the React Compiler; these flag idiomatic create-once /
      // latest-value-in-ref / refs-in-memo patterns rather than runtime bugs.
      // Kept as warnings so the signal stays visible without blocking. Core
      // correctness rules (rules-of-hooks, exhaustive-deps) stay errors.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
  {
    // AudioWorklet processors run in the worklet global scope.
    files: ['**/*.worklet.ts', 'src/audio/worklets/**/*.ts'],
    languageOptions: {
      globals: { ...globals.worker, sampleRate: 'readonly', currentTime: 'readonly', currentFrame: 'readonly', registerProcessor: 'readonly', AudioWorkletProcessor: 'readonly' },
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
