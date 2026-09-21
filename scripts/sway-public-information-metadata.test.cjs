'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPublicInformationMetadata: build } = require('./sway-public-information-metadata.cjs');
const structured = html => JSON.parse(html.match(/<script[^>]*data-sway-public-information="true"[^>]*>([\s\S]*?)<\/script>/)[1]);
test('About uses a unique canonical and matching search/social/schema descriptions', () => {
  const html = build('/about', 'About Sway', 'Your music & live rooms', '<h1>About Sway</h1>');
  const schema = structured(html);
  assert.equal(schema['@type'], 'AboutPage');
  assert.equal(schema.url, 'https://app.sway.tips/about');
  assert.equal(schema.description, 'Your music & live rooms');
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  for (const field of ['og:title','og:description','og:url','twitter:title','twitter:description']) assert(html.includes(field));
  assert(!html.includes('mainEntity')); assert(!html.includes('sameAs')); assert(!html.includes('og:image'));
});
test('FAQ schema comes from exactly the visible questions, links and answers', () => {
  const html = build('/faq', 'Sway FAQ', 'Questions', '<details><summary>Can I join?</summary><p>Open <a href="/home">the room</a> &amp; check its name.</p></details><details><summary>Is music public?</summary><p>No. A private file remains private.</p></details>');
  const schema = structured(html);
  assert.equal(schema['@type'], 'FAQPage'); assert.equal(schema.mainEntity.length, 2);
  assert.equal(schema.mainEntity[0].acceptedAnswer.text, 'Open the room & check its name.');
  assert.equal(schema.mainEntity[1].name, 'Is music public?');
});
test('HTML attributes and script terminators are escaped without changing schema text', () => {
  const title = 'Sway "name" <test> & music';
  const description = '</script><script>alert(1)</script>';
  const html = build('/about', title, description, '<h1>About</h1>');
  assert.equal((html.match(/<script\b/g) || []).length, 1);
  assert(html.includes('&quot;name&quot;')); assert(html.includes('\\u003c/script>'));
  assert.equal(structured(html).description, description);
});
test('private routes, query strings and malformed FAQs cannot acquire public schema', () => {
  for (const path of ['/talent', '/admin', '/about?draft=1', '//about', '/about/', '__proto__']) assert.throws(() => build(path, 'title', 'description', 'content'), /Unknown/);
  assert.throws(() => build('/faq', 'title', 'description', '<h1>FAQ</h1>'), /visible questions/);
  assert.throws(() => build('/faq', 'title', 'description', '<details><summary>Missing answer?</summary></details>'), /question and answer/);
  assert.throws(() => build('/about', '', 'description', 'content'), /required/);
});
const pages = require('./sway-dj-beta-about-preload.cjs');
for (const [path, html] of [['/about', pages.ABOUT_PAGE_HTML], ['/faq', pages.FAQ_PAGE_HTML]]) {
  test(`${path}: actual production document has one matching metadata set and truthful schema`, () => {
    const schema = structured(html);
    assert.equal(schema.url, 'https://app.sway.tips' + path);
    assert.equal((html.match(/<title\b/g) || []).length, 1);
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
    assert.equal((html.match(/name="description"/g) || []).length, 1);
    assert.equal((html.match(/data-sway-public-information="true"/g) || []).length, 1);
    for (const field of ['og:title','og:description','og:url','twitter:title','twitter:description']) assert(html.includes(field));
    if (path === '/faq') {
      const questions = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map(match => match[1]);
      assert.equal(questions.length, 11); assert.deepEqual(schema.mainEntity.map(item => item.name), questions);
      assert(schema.mainEntity.some(item => item.acceptedAnswer.text.includes('not available in the current release')));
      assert(schema.mainEntity.some(item => item.acceptedAnswer.text.includes('performer chooses')));
    } else assert.equal(schema.mainEntity, undefined);
    assert(html.includes('href="/account/signup?intent=performer"'));
  });
}
