import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Run the actual full editor with the repository's installed React dependencies.
// HTTP, icons, and the visibility child are controlled. This is component-state
// proof, not layout, real-account authorization, persistence, or payment proof.
const root = fileURLToPath(new URL('../', import.meta.url));
const editor = resolve(root, 'src/components/PerformerPublicProfileEditor.tsx');
const icons = ['ArrowDown', 'ArrowUp', 'BadgeCheck', 'Eye', 'EyeOff', 'ExternalLink', 'Link2', 'Plus', 'Save', 'Trash2'];
const stubs = {
  'lucide-react': icons.map(name => `export const ${name}=()=>null;`).join('\n'),
  './PerformerVisibilityControl': `import React from 'react';
    export const PerformerVisibilityControl=()=>React.createElement('div',{'data-visibility-stub':'true'});`
};
const entry = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Editor from './src/components/PerformerPublicProfileEditor.tsx';
import { runProfileEditorCases, createProfileEditorFixtureFactory } from './scripts/sway-profile-editor.cases.mjs';
window.__reactVersion = React.version;
window.fetch = () => { throw new Error('Unexpected unmocked HTTP request'); };
window.__runProfileEditorCases = () => runProfileEditorCases({
  createFixture: createProfileEditorFixtureFactory({ React, createRoot, flushSync, Editor, window })
});`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'profile-editor-test-entry.js', loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'isolate-profile-editor', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args =>
      resolve(args.importer) === editor && Object.hasOwn(stubs, args.path)
        ? { path: args.path, namespace: 'profile-editor-stub' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'profile-editor-stub' }, args => ({
      contents: stubs[args.path], loader: 'js', resolveDir: root
    }));
  } }]
});
const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('jsdomError', error => errors.push(String(error.message || error)));
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://sway.test/talent/profile', runScripts: 'outside-only', virtualConsole
});
const channels = [];
dom.window.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
dom.window.addEventListener('error', event => errors.push(event.message));
try {
  dom.window.eval(bundled.outputFiles[0].text);
  const results = await dom.window.__runProfileEditorCases();
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': ' + result.error : ''}`);
  }
  const failed = results.filter(result => !result.passed);
  console.log(`Profile editor: ${results.length - failed.length} passed, ${failed.length} failed; React ${dom.window.__reactVersion}.`);
  assert.equal(results.length, 26, 'Every permanent editor scenario must execute.');
  assert.deepEqual(errors, [], 'The editor produced uncaught rendering errors.');
  assert.equal(failed.length, 0, 'Profile-editor regressions failed.');
} finally {
  dom.window.close();
  for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
}
