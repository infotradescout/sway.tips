'use strict';

const CANONICAL_ORIGIN = 'https://app.sway.tips';
const PUBLIC_INFORMATION_PATHS = new Set(['/about', '/faq']);
function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function visibleText(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#39);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'"
  }[entity])).replace(/\s+/g, ' ').trim();
}

/** Only the two existing authored public documents; never a publication policy. */
function buildPublicInformationMetadata(path, title, description, content) {
  if (!PUBLIC_INFORMATION_PATHS.has(path)) throw new Error('Unknown public information path');
  for (const value of [title, description, content]) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Public information text is required');
  }
  const canonical = CANONICAL_ORIGIN + path;
  const schema = {
    '@context': 'https://schema.org', '@type': path === '/faq' ? 'FAQPage' : 'AboutPage',
    '@id': canonical + '#webpage', url: canonical, name: title, description, inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: 'Sway', url: CANONICAL_ORIGIN + '/' }
  };
  if (path === '/faq') {
    // The source is trusted authored markup, not user input. Derive answers
    // from the same visible details so schema cannot advertise a second FAQ.
    const details = [...content.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)];
    if (!details.length) throw new Error('FAQ metadata requires visible questions');
    schema.mainEntity = details.map(([, detail]) => {
      const question = detail.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
      const name = question ? visibleText(question[1]) : '';
      const answer = question ? visibleText(detail.replace(question[0], '')) : '';
      if (!name || !answer) throw new Error('Each visible FAQ requires a question and answer');
      return { '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text: answer } };
    });
  }
  const tags = [
    `<title>${escapeAttribute(title)}</title>`,
    `<meta name="description" content="${escapeAttribute(description)}">`,
    `<link rel="canonical" href="${canonical}">`,
    ...[['og:type', 'website'], ['og:site_name', 'Sway'], ['og:title', title], ['og:description', description], ['og:url', canonical]]
      .map(([property, value]) => `<meta property="${property}" content="${escapeAttribute(value)}">`),
    ...[['twitter:card', 'summary'], ['twitter:title', title], ['twitter:description', description]]
      .map(([name, value]) => `<meta name="${name}" content="${escapeAttribute(value)}">`),
    `<script type="application/ld+json" data-sway-public-information="true">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`
  ];
  return tags.join('');
}
module.exports = { buildPublicInformationMetadata };
