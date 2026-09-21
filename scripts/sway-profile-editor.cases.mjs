// Shared by the repository dependency runner and the isolated browser probe.
// Render the actual editor; only its visibility child, icons, and HTTP are controlled.
export async function runProfileEditorCases({ createFixture }) {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const profile = (name, partner = {}) => ({ profile: {
    handle: name.toLowerCase(), roles: ['dj'], stageName: name,
    headline: `${name} headline`, bio: `${name} private draft`,
    booking: { email: `${name.toLowerCase()}@example.test`, phone: '5555550100' },
    socialLinks: {}, specialties: [], links: [], partner
  } });
  const pendingPartner = {
    granted: true, active: false, accepted: false, suspended: false,
    acceptanceRequired: true, termsVersion: 'test-v1', termsHash: 'test-hash',
    termsText: 'Fixture terms only. No real acceptance.'
  };
  const test = async (name, execute) => {
    const f = await createFixture();
    try { await execute(f); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error.message || error) }); }
    finally { await f.destroy(); }
  };

  await test('same performer rerender preserves unsaved edits', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.fill('Headline', 'Unsaved alpha edit');
    const count = f.gets().length; await f.render('alpha');
    check(f.value('Headline') === 'Unsaved alpha edit', 'same-scope edits were reset');
    check(f.gets().length === count, 'same-scope render refetched the profile');
  });
  await test('performer switch clears private fields and starts a fresh read', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    const count = f.gets().length; await f.render('beta');
    check(f.value('Headline') === '', 'previous performer headline remained');
    check(f.value('Public booking email') === '', 'previous performer contact remained');
    check(f.gets().length > count, 'new performer did not reload');
    check(f.saveDisabled(), 'save remained enabled during the new read');
    await f.reply(f.gets().at(-1), profile('Beta'));
    check(f.value('Headline') === 'Beta headline', 'new performer did not populate');
  });
  await test('superseded profile response cannot populate a new performer', async f => {
    await f.render('alpha'); const old = f.gets().at(-1); await f.render('beta');
    await f.reply(old, profile('Alpha'));
    check(f.value('Headline') === '', 'old read populated the new performer');
    check(f.saveDisabled(), 'old read enabled saving');
  });
  await test('returning to the same handle does not revive its old read', async f => {
    await f.render('alpha'); const first = f.gets().at(-1);
    await f.render('beta'); await f.render('alpha');
    const latest = f.gets().at(-1);
    check(latest !== first, 'returning performer reused the old read');
    await f.reply(latest, profile('Current Alpha')); await f.reply(first, profile('Old Alpha'));
    check(f.value('Headline') === 'Current Alpha headline', 'old same-handle response won');
  });
  await test('late save cannot report success or refresh another performer', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(); const save = f.posts().at(-1); await f.render('beta');
    await f.reply(save, {});
    check(!f.text().includes('Public page saved.'), 'old save showed success');
    check(f.events() === 0, 'old save dispatched a current-profile refresh');
  });
  await test('same-tick repeated saves produce only one write', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(2);
    check(f.posts().length === 1, 'duplicate profile writes were submitted');
  });
  await test('failed initial read cannot replace the saved profile with empty fields', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), { error: 'Read unavailable' }, 503);
    check(f.saveDisabled(), 'failed read enabled an empty profile save');
    check(f.fieldsetDisabled(), 'failed read enabled editing before a complete read');
    check(f.hasButton('Reload profile'), 'failed read has no recovery control');
    await f.click('Reload profile'); await f.reply(f.gets().at(-1), profile('Alpha'));
    check(f.value('Headline') === 'Alpha headline', 'retry did not load saved data');
    check(!f.saveDisabled(), 'successful retry did not enable editing');
  });
  await test('successful save preserves fields and emits one refresh', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.fill('Headline', 'New headline'); await f.submit();
    const save = f.posts().at(-1);
    check(JSON.parse(save.options.body).headline === 'New headline', 'save missed current edits');
    await f.reply(save, {});
    check(f.text().includes('Public page saved.'), 'success feedback missing');
    check(f.events() === 1, 'successful save did not refresh exactly once');
    check(f.value('Headline') === 'New headline', 'save reset edited fields');
  });
  await test('save failure retains edits and supports an explicit retry', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.fill('Headline', 'Keep this edit'); await f.submit();
    await f.reply(f.posts().at(-1), { error: 'Save unavailable' }, 503);
    check(f.value('Headline') === 'Keep this edit', 'failure lost unsaved edits');
    check(!f.saveDisabled(), 'failure blocked the explicit retry');
    await f.submit(); check(f.posts().length === 2, 'explicit retry was not submitted');
  });
  await test('partner acceptance still requires deliberate consent', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    check(f.buttonDisabled('Accept exact Brand Partner terms'), 'consent was preselected');
    check(f.posts().length === 0, 'terms were accepted without an action');
  });
  await test('same-tick partner acceptance produces only one receipt request', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    await f.consent(); await f.click('Accept exact Brand Partner terms', 2);
    check(f.posts().length === 1, 'duplicate terms-acceptance writes were submitted');
    const body = JSON.parse(f.posts()[0].options.body);
    check(body.accepted === true && body.termsVersion === 'test-v1' && body.termsHash === 'test-hash', 'exact terms binding changed');
  });
  await test('late partner acceptance cannot change a new performer', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    await f.consent(); await f.click('Accept exact Brand Partner terms');
    const acceptance = f.posts().at(-1); await f.render('beta');
    await f.reply(acceptance, {});
    check(!f.text().includes('terms accepted.'), 'previous performer acceptance leaked');
    check(!f.text().includes('grandfathered'), 'old terms completion activated the new performer');
  });
  await test('preview mode does not retain a previous live profile draft', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.render('alpha', true);
    check(f.value('Headline') === '', 'live draft leaked into preview mode');
    check(f.saveDisabled(), 'preview allowed profile writes');
    const count = f.posts().length; await f.submit();
    check(f.posts().length === count, 'preview submitted a write');
  });
  await test('unmounted editor ignores save completion', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(); const save = f.posts().at(-1); await f.unmount();
    await f.reply(save, {}); check(f.events() === 0, 'unmounted editor emitted a refresh');
  });
  await test('late save failure cannot replace the new performer state', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(); const save = f.posts().at(-1); await f.render('beta');
    await f.reply(f.gets().at(-1), profile('Beta'));
    await f.reply(save, { error: 'Old performer error' }, 503);
    check(!f.text().includes('Old performer error'), 'old error replaced current feedback');
    check(f.value('Headline') === 'Beta headline', 'old failure changed current form');
  });
  await test('access loss clears private drafts and requires a fresh read', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(); await f.reply(f.posts().at(-1), { error: 'Access expired' }, 401);
    check(f.value('Public booking email') === '', 'private contact remained after access loss');
    check(f.saveDisabled(), 'access loss allowed another stale save');
    check(f.hasButton('Reload profile'), 'access loss has no deliberate reload');
  });
  await test('delayed profile JSON cannot restore the previous performer', async f => {
    await f.render('alpha'); const release = await f.headers(f.gets().at(-1));
    await f.render('beta'); await f.reply(f.gets().at(-1), profile('Beta'));
    await release(profile('Alpha'));
    check(f.value('Headline') === 'Beta headline', 'delayed profile JSON replaced current data');
  });
  await test('delayed save JSON cannot dispatch a refresh after switching', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(); const release = await f.headers(f.posts().at(-1));
    await f.render('beta'); await release({});
    check(f.events() === 0, 'delayed save JSON dispatched a stale refresh');
    check(!f.text().includes('Public page saved.'), 'delayed save JSON changed feedback');
  });
  await test('terms denial invalidates an overlapping profile save', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    await f.consent(); await f.click('Accept exact Brand Partner terms');
    const terms = f.posts().at(-1); await f.submit(); const save = f.posts().at(-1);
    await f.reply(terms, { error: 'Access expired' }, 403); await f.reply(save, {});
    check(f.events() === 0, 'save succeeded locally after terms access denial');
    check(f.value('Public booking email') === '', 'terms denial retained private data');
    check(f.saveDisabled(), 'terms denial allowed stale edits');
    check(!f.hasVisibility(), 'private visibility control remained after access loss');
  });
  await test('profile denial invalidates overlapping partner acceptance', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    await f.consent(); await f.click('Accept exact Brand Partner terms');
    const terms = f.posts().at(-1); await f.submit(); const save = f.posts().at(-1);
    await f.reply(save, { error: 'Access expired' }, 401); await f.reply(terms, {});
    check(!f.text().includes('terms accepted.'), 'terms activated after profile denial');
    check(!f.text().includes('grandfathered'), 'partner pricing appeared active after denial');
    check(f.saveDisabled(), 'profile denial allowed stale edits');
  });
  await test('reload after access loss cannot be disturbed by old work', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    await f.consent(); await f.click('Accept exact Brand Partner terms');
    const oldTerms = f.posts().at(-1); await f.submit();
    await f.reply(f.posts().at(-1), {}, 401);
    await f.click('Reload profile'); await f.reply(f.gets().at(-1), profile('Reloaded', pendingPartner));
    await f.reply(oldTerms, {});
    check(f.value('Headline') === 'Reloaded headline', 'old work changed reloaded data');
    check(f.buttonDisabled('Accept exact Brand Partner terms'), 'old consent survived reload');
    check(!f.text().includes('terms accepted.'), 'old acceptance crossed the reload boundary');
    check(!f.saveDisabled(), 'old work blocked the fresh form');
  });
  await test('access denial does not wait for its response body', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.submit(); await f.headers(f.posts().at(-1), 403);
    check(f.value('Public booking email') === '', 'access denial waited on delayed JSON');
    check(f.saveDisabled(), 'access denial left saving enabled');
  });
  await test('network failure retains edits without automatic write retries', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    await f.fill('Headline', 'Keep after disconnect'); await f.submit();
    await f.reject(f.posts().at(-1));
    check(f.value('Headline') === 'Keep after disconnect', 'network failure lost edits');
    check(f.posts().length === 1, 'network failure retried a write automatically');
    check(!f.saveDisabled(), 'network failure prevented deliberate retry');
    await f.submit(); await f.reply(f.posts().at(-1), {});
    check(f.events() === 1, 'recovery did not complete exactly once');
  });
  await test('changing performer aborts pending writes and clears consent', async f => {
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha', pendingPartner));
    await f.consent(); await f.click('Accept exact Brand Partner terms');
    const old = f.posts().at(-1); await f.render('beta');
    check(old.options.signal?.aborted === true, 'old write did not receive cancellation');
    await f.reply(f.gets().at(-1), profile('Beta', pendingPartner));
    check(f.buttonDisabled('Accept exact Brand Partner terms'), 'consent crossed performers');
  });
  await test('a submitted event cannot bypass loading and failed-read guards', async f => {
    await f.render('alpha'); await f.submit();
    check(f.posts().length === 0, 'loading form submitted a write');
    await f.reply(f.gets().at(-1), { error: 'Read unavailable' }, 503);
    await f.submit(); check(f.posts().length === 0, 'failed read submitted a write');
    check(!f.hasVisibility(), 'failed profile read exposed the visibility editor');
  });
  await test('returning from preview reloads the real saved profile', async f => {
    await f.render('alpha', true);
    check(f.gets().length === 0, 'preview initiated a private read');
    await f.render('alpha'); await f.reply(f.gets().at(-1), profile('Alpha'));
    check(f.value('Headline') === 'Alpha headline', 'live profile did not reload');
    check(!f.saveDisabled(), 'live editor remained disabled');
  });
  return results;
}

export function createProfileEditorFixtureFactory({ React, createRoot, flushSync, Editor, window }) {
  const settle = async () => {
    await Promise.resolve(); await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    flushSync(() => {});
  };
  return async () => {
    const document = window.document;
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const requests = [];
    let refreshes = 0; let mounted = true;
    const onRefresh = () => { refreshes++; };
    window.addEventListener('sway:performer-profile-updated', onRefresh);
    const oldFetch = globalThis.fetch;
    const oldWindowFetch = window.fetch;
    const fakeFetch = (url, options = {}) => new Promise((resolve, reject) => {
      requests.push({ url: String(url), options, resolve, reject });
    });
    globalThis.fetch = fakeFetch; window.fetch = fakeFetch;
    const input = label => {
      const wrapper = [...host.querySelectorAll('label')].find(node =>
        [...node.querySelectorAll('span')].some(span => span.textContent === label));
      const field = wrapper?.querySelector('input,textarea,select');
      if (!field) throw new Error(`Missing field: ${label}`);
      return field;
    };
    const button = label => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === label);
    return {
      async render(handle, previewMode = false) {
        flushSync(() => root.render(React.createElement(React.StrictMode, null,
          React.createElement(Editor, { performerHandle: handle, previewMode }))));
        await settle();
      },
      gets: () => requests.filter(r => !r.options.method || r.options.method === 'GET'),
      posts: () => requests.filter(r => r.options.method === 'POST'),
      async reply(request, data, status = 200) {
        if (!request) throw new Error('Expected request is missing');
        request.resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
        await settle();
      },
      async headers(request, status = 200) {
        if (!request) throw new Error('Expected request is missing');
        let resolveBody;
        const body = new Promise(resolve => { resolveBody = resolve; });
        request.resolve({ ok: status >= 200 && status < 300, status, json: () => body });
        await settle();
        return async data => { resolveBody(data); await settle(); };
      },
      async reject(request) {
        if (!request) throw new Error('Expected request is missing');
        request.reject(new Error('Synthetic network failure')); await settle();
      },
      hasVisibility: () => Boolean(host.querySelector('[data-visibility-stub]')),
      async fill(label, value) {
        const field = input(label);
        const prototype = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
        flushSync(() => field.dispatchEvent(new window.Event('input', { bubbles: true })));
        await settle();
      },
      async submit(count = 1) {
        const form = host.querySelector('form');
        if (!form) throw new Error('Missing editor form');
        flushSync(() => {
          for (let i = 0; i < count; i++) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        });
        await settle();
      },
      async click(label, count = 1) {
        const target = button(label); if (!target) throw new Error(`Missing button: ${label}`);
        flushSync(() => { for (let i = 0; i < count; i++) target.click(); });
        await settle();
      },
      async consent() {
        const target = [...host.querySelectorAll('label')].find(node => node.textContent.includes('authenticated owner'))?.querySelector('input');
        if (!target) throw new Error('Missing owner consent');
        flushSync(() => target.click()); await settle();
      },
      value: label => input(label).value,
      text: () => host.textContent,
      events: () => refreshes,
      saveDisabled: () => host.querySelector('button[type="submit"]').disabled,
      fieldsetDisabled: () => host.querySelector('fieldset').disabled,
      hasButton: label => Boolean(button(label)),
      buttonDisabled: label => button(label)?.disabled === true,
      async unmount() { if (mounted) { flushSync(() => root.unmount()); mounted = false; } await settle(); },
      async destroy() {
        if (mounted) { flushSync(() => root.unmount()); mounted = false; }
        await settle(); host.remove(); window.removeEventListener('sway:performer-profile-updated', onRefresh);
        globalThis.fetch = oldFetch; window.fetch = oldWindowFetch;
      }
    };
  };
}
