import assert from 'node:assert/strict';
import { shouldHard404ScannerRequest } from '../src/server/traffic-truth-request';

let cases = 0;
for (const path of ['/src/entries/patron.tsx', '/node_modules/.vite/deps/react.js?v=123']) {
  const request = { path, originalUrl: path, method: 'GET', headers: { host: '127.0.0.1:4100' } };
  for (const mode of ['development', 'test']) {
    assert.equal(shouldHard404ScannerRequest(request, { NODE_ENV: mode }), false); cases++;
  }
  assert.equal(shouldHard404ScannerRequest(request, { NODE_ENV: 'production' }), true); cases++;
  assert.equal(shouldHard404ScannerRequest(request, {}), true); cases++;
  assert.equal(shouldHard404ScannerRequest({ ...request, method: 'POST' }, { NODE_ENV: 'test' }), true); cases++;
  for (const host of ['app.sway.tips', 'localhost.evil.invalid', '127.0.0.1.evil.invalid', '']) {
    assert.equal(shouldHard404ScannerRequest({ ...request, headers: { host } }, { NODE_ENV: 'test' }), true); cases++;
  }
}
for (const path of ['/.env', '/src/.env', '/src/secret.pem', '/src/%2e%2e/server.ts', '/.git/config']) {
  assert.equal(shouldHard404ScannerRequest({ path, originalUrl: path, method: 'GET', headers: { host: '127.0.0.1:4100' } }, { NODE_ENV: 'test' }), true); cases++;
}
console.log(`Traffic-truth local-module boundary passed: ${cases} cases; production source blocking remains active.`);
