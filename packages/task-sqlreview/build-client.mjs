import { build } from 'esbuild';
const PKG = '@opendb-dsh/task-sqlreview';
const EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment', '@deepseek-ai/dsh-client-schema-form'];
await build({
  entryPoints: ['src/client/index.tsx'], bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic',
  external: EXTERNALS,
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(PKG)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: `return module.exports;}});` },
  outfile: 'lib/client.js', logLevel: 'silent',
});
