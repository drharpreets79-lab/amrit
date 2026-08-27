import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import i18next from 'eslint-plugin-i18next'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'out/**', 'release/**', 'coverage/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    /**
     * `core/` is the part of this application that has to run on a phone.
     *
     * Phase 17. The extraction is worth nothing if it can be undone by one convenient import:
     * `node:fs` in a domain module compiles, passes every test on a laptop, and fails on iOS
     * where the module does not exist. This rule is what makes "platform-neutral" a property
     * the build checks rather than a claim in a comment.
     *
     * The four seams are the way out. A module under `core/` that needs the filesystem takes
     * an `AssetSource`; one that needs a database takes a `SqlDriver`; one that needs a
     * secret or a directory takes a `SecretStore` or a `PathResolver`. If none of those fit,
     * the code is platform code and belongs in `adapters/`.
     */
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['node:*'], message: 'core/ must not import node:* — take an AssetSource, SqlDriver, SecretStore or PathResolver instead. iOS and Android have no node: modules.' },
          { group: ['fs', 'path', 'os', 'crypto', 'zlib', 'child_process', 'net', 'tls', 'http', 'https'], message: 'core/ must not import a Node built-in — use the platform seam. See src/core/platform.ts.' },
          { group: ['electron', 'electron/*'], message: 'core/ must not import electron — it runs on Capacitor too. Put the Electron code in adapters/electron/.' },
          { group: ['../main/*', '../../main/*', '**/src/main/*'], message: 'core/ must not import from main/ — the dependency runs the other way, or the module belongs in core/.' },
          { group: ['**/adapters/*', '**/adapters/**'], message: 'core/ must not import an adapter — that inverts the seam. Take a Platform, or one of its four members, as a parameter.' }
        ]
      }],
      'no-restricted-globals': ['error',
        { name: 'window', message: 'core/ must not touch the DOM: it runs in a main process too.' },
        { name: 'document', message: 'core/ must not touch the DOM: it runs in a main process too.' },
        { name: 'localStorage', message: 'core/ must not touch the DOM: it runs in a main process too.' },
        { name: '__dirname', message: 'core/ has no filesystem. Take a PathResolver.' },
        { name: '__filename', message: 'core/ has no filesystem. Take a PathResolver.' }
      ]
    }
  },
  {
    /**
     * Every user-visible string in the renderer must come from a catalogue. This is the
     * rule that stops a screen drifting back to hardcoded English one edit at a time —
     * the catalogues themselves cannot detect a string that was never extracted.
     */
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['src/renderer/locales/**', 'src/renderer/i18n/**'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', {
        mode: 'jsx-text-only',
        'should-validate-template': false
      }]
    }
  }
)
