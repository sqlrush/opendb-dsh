// Bundle the browser half as a classic script wrapped in __ModuleLoader__.load (dsh client contract).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const PKG = '@opendb-dsh/ui-harness';
// 产品版本唯一来源 = 根 package.json（版本管理规则见 CLAUDE.md）；打进欢迎页角标
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
];

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: EXTERNALS,
  define: { __OPENDB_VERSION__: JSON.stringify(VERSION) },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(PKG)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: `return module.exports;}});` },
  outfile: 'lib/client.js',
  logLevel: 'silent',
});
console.log('client bundle written: lib/client.js');
