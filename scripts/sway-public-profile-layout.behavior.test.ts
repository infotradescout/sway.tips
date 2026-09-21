import assert from 'node:assert/strict';
import {
  PUBLIC_PERFORMER_PRIMARY_ROLES,
  PUBLIC_PROFILE_SECTION_IDS,
  isPublicProfileSectionOrder,
  mergePublicProfileMetadata,
  readPublicProfileLayout,
  resolvePublicProfileSectionOrder,
  shouldShowPublicProfilePartnerBadge
} from '../src/server/public-profile';

try {
  for (const handle of ['dj3x', 'DJ3X', ' dj3x ']) {
    assert.equal(shouldShowPublicProfilePartnerBadge(handle, true), true);
    assert.equal(shouldShowPublicProfilePartnerBadge(handle, false), false);
  }
  for (const handle of ['bubbakhain', 'calliehines', 'coreymack', 'drewmaze', 'new-partner', 'dj3x-other', '', null, undefined]) {
    assert.equal(shouldShowPublicProfilePartnerBadge(handle, true), false, `Public badge stays hidden for ${handle}`);
  }
  const musicOrder = ['identity', 'releases', 'links', 'media', 'live', 'events', 'about', 'booking', 'social'];
  const djOrder = ['identity', 'live', 'media', 'events', 'booking', 'links', 'releases', 'about', 'social'];
  const stageOrder = ['identity', 'media', 'events', 'booking', 'live', 'about', 'links', 'releases', 'social'];
  assert.deepEqual(resolvePublicProfileSectionOrder({ roles: ['musician', 'producer'] }), musicOrder);
  assert.deepEqual(resolvePublicProfileSectionOrder({ primaryRole: 'producer' }), musicOrder);
  assert.deepEqual(resolvePublicProfileSectionOrder({ roles: ['DJ', 'musician'] }), djOrder);
  assert.deepEqual(resolvePublicProfileSectionOrder({ roles: ['comedian', 'musician', 'dj', 'host'] }), stageOrder);
  for (const role of ['host', 'speaker', 'dancer', 'magician']) {
    assert.deepEqual(resolvePublicProfileSectionOrder({ roles: [role] }), stageOrder);
  }
  for (const role of [...PUBLIC_PERFORMER_PRIMARY_ROLES.map((role) => role.id), 'unknown', null]) {
    const order = resolvePublicProfileSectionOrder({ primaryRole: role });
    assert.equal(order[0], 'identity');
    assert.deepEqual([...order].sort(), [...PUBLIC_PROFILE_SECTION_IDS].sort());
  }
  const reversed = [...PUBLIC_PROFILE_SECTION_IDS].reverse();
  assert.deepEqual(resolvePublicProfileSectionOrder({ roles: ['musician'], sectionOrder: reversed }), reversed);
  assert.deepEqual(resolvePublicProfileSectionOrder({ roles: ['musician'], sectionOrder: ['social', 'identity'] }), [
    'social', 'identity', 'releases', 'links', 'media', 'live', 'events', 'about', 'booking'
  ]);
  for (const invalid of [null, undefined, [], Array(1), 'media', ['media', 'media'], ['bogus'], ['identity', 1], { 0: 'media' }]) {
    assert.equal(isPublicProfileSectionOrder(invalid), false);
    assert.deepEqual(resolvePublicProfileSectionOrder({ roles: ['musician'], sectionOrder: invalid }), musicOrder);
  }
  const persisted = {
    roles: ['musician', 'producer'], primaryRole: 'musician', stageName: 'Explicit stage name',
    unrelated: { untouched: ['original', 1] }, publicProfileLayout: { sectionOrder: reversed, revision: 3 }
  };
  assert.deepEqual(readPublicProfileLayout(persisted), { sectionOrder: reversed, customized: true, revision: 3 });
  const contentEdit = mergePublicProfileMetadata(persisted, { roles: ['dj'] });
  assert.deepEqual(readPublicProfileLayout(contentEdit), { sectionOrder: reversed, customized: true, revision: 3 });
  assert.deepEqual(contentEdit?.unrelated, persisted.unrelated);
  assert.deepEqual(readPublicProfileLayout({ ...contentEdit, publicProfileLayout: { sectionOrder: null, revision: 4 } }), {
    sectionOrder: djOrder, customized: false, revision: 4
  });
  assert.deepEqual(readPublicProfileLayout({ roles: ['musician'], publicProfileLayout: { sectionOrder: ['bad'], revision: -1 } }), {
    sectionOrder: musicOrder, customized: false, revision: 0
  });
  assert.deepEqual(readPublicProfileLayout(null, ['musician'], 'dj'), { sectionOrder: musicOrder, customized: false, revision: 0 });
  console.log('Public profile layout behavior: role defaults, owner overrides, legacy fallback, reset, and metadata preservation passed.');
} catch (error) {
  console.error('Public profile layout behavior failed:', error);
  process.exit(1);
}
