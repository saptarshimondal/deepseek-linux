import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      // Add custom rules here
    },
  },
  {
    // The preload runs in a sandboxed renderer as CommonJS with browser APIs.
    files: ['src/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        window: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        MutationObserver: 'readonly',
        NodeFilter: 'readonly',
        Node: 'readonly',
        Range: 'readonly',
        CSS: 'readonly',
        Highlight: 'readonly',
      },
    },
  },
];
