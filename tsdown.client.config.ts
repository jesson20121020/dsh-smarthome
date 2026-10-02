import { defineConfig } from 'tsdown'

/**
 * Browser half of the bundle: emits `lib/client.js` in the Web Client's
 * module-loader format (closure factory + externals resolved from the loader
 * module table). Type-only `@deepseek-ai/*` imports are erased by the TS
 * transform, so the only runtime external is react (a platform module).
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-conversation/client',
    '@deepseek-ai/dsh-client-ui-chat/client',
    '@deepseek-ai/dsh-client-ui-renderer/client',
    '@deepseek-ai/dsh-client-web-react',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-smarthome", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
