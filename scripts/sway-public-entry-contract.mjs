import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source checks only: this does not substitute for rendered browser or account-flow proof.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(process.env.SWAY_LANDING_SOURCE || resolve(root, 'shells/public.html'), 'utf8');
const rules = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...html.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`, 'g'))].map(match => match[1]);
};
const firstRule = selector => { const found = rules(selector)[0]; assert(found, `Missing ${selector}`); return found; };
const checks = [
  ['creator is the first entry action', () => {
    const nav = html.match(/<nav class="cta-stack"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert(nav);
    const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.equal(links[0]?.[1], '/account/signup?intent=performer');
    assert.equal(links.filter(link => link[1] === '/account/signup?intent=performer').length, 1);
    assert.match(links[0][2], /Create your performer page/);
  }],
  ['audience, discovery and ordinary accounts remain separate', () => {
    for (const path of ['/home', '/discover', '/account/signup', '/account/login', '/about']) assert(html.includes(`href="${path}"`));
  }],
  ['buttons are available without the reveal script', () => {
    const rule = firstRule('.btn');
    assert.match(rule, /opacity:\s*1\s*;/);
    assert.match(rule, /pointer-events:\s*auto\s*;/);
    assert.doesNotMatch(rule, /opacity\s+[\d.]+s/);
  }],
  ['about link does not start hidden or blurred', () => {
    const rule = firstRule('.tagline');
    assert.match(rule, /opacity:\s*1\s*;/);
    assert.match(rule, /filter:\s*blur\(0\)/);
    assert.match(rule, /pointer-events:\s*auto\s*;/);
  }],
  ['footer is visible and participates in document flow', () => {
    const rule = firstRule('footer');
    assert.match(rule, /position:\s*relative\s*;/);
    assert.match(rule, /opacity:\s*1\s*;/);
    assert.match(rule, /pointer-events:\s*auto\s*;/);
    assert.doesNotMatch(rule, /position:\s*(fixed|absolute)/);
    assert.match(firstRule('main'), /min-height:\s*0\s*;/);
  }],
  ['desktop introduction does not depend on the reveal script', () => {
    const desktop = rules('.desktop-copy').find(rule => /display:\s*block/.test(rule));
    assert(desktop);
    assert.match(desktop, /opacity:\s*1\s*;/);
  }],
  ['entry text may wrap and keyboard focus is visible', () => {
    assert.match(firstRule('.btn'), /line-height:\s*1\.3\s*;/);
    assert.match(firstRule('.btn'), /padding:\s*12px 20px\s*;/);
    assert(html.includes('.cta-stack a:focus-visible,'));
    assert(html.includes('footer a:focus-visible {'));
    assert(html.includes('outline-offset: 4px;'));
  }],
  ['existing approved artwork and trust links remain', () => {
    assert(html.includes('src="/assets/sway-neon-background.png"'));
    for (const path of ['/privacy', '/terms', '/about', '/faq', '/support', '/privacy/data-deletion']) assert(html.includes(`href="${path}"`));
    assert(html.includes('sway to play'));
    assert(html.includes('prefers-reduced-motion: reduce'));
    assert(html.includes('id="public-install-prompt"'));
  }]
];
const results = checks.map(([name, check]) => {
  try { check(); return { name, status: 'PASS' }; }
  catch (error) { return { name, status: 'FAIL', error: error.message }; }
});
const report = {
  sourceSha256: createHash('sha256').update(html).digest('hex'),
  scope: 'Static source contract only; not browser, artwork, signup, payment or production proof.',
  passed: results.filter(row => row.status === 'PASS').length,
  failed: results.filter(row => row.status === 'FAIL').length, results
};
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
