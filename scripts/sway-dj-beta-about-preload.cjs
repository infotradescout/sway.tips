'use strict';

// Retain this entry point for existing NODE_OPTIONS configuration. About and
// FAQ have different jobs; neither may reduce Sway to an opening DJ beta.
const styles = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f8f8ff;background:#05050b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 520px at 12% -8%,rgba(240,75,216,.13),transparent 62%),#05050b;line-height:1.65}a{color:#b9edff;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #42d9ff;outline-offset:4px}.page{width:min(960px,calc(100% - 32px));margin:auto;padding:16px 0 40px}.topbar,.links,.actions,footer{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px}.topbar{justify-content:space-between;border-bottom:1px solid #ffffff20;padding-bottom:16px}.brand{font-size:24px;font-weight:900;color:#f8f8ff;text-decoration:none}.links a,footer a{padding:8px 0}.hero{padding:32px 0 24px}h1{font-size:clamp(32px,6vw,52px);line-height:1.12;letter-spacing:-.035em;margin:0 0 16px}h2{font-size:25px;line-height:1.25;margin:0 0 12px}h3{font-size:20px;line-height:1.35;margin:0 0 10px}p{margin:0 0 14px;color:#c8cada}.intro{max-width:760px;font-size:18px}.actions{margin-top:20px}.action{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 18px;border:1px solid #ffffff35;border-radius:12px;font-weight:800;text-align:center;text-decoration:none;color:#fff}.primary{background:#a21caf;border-color:#d946ef}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card,.note,details{border:1px solid #ffffff20;background:#11121fe0;border-radius:16px}.card{padding:22px}.card a{display:inline-block;padding:6px 0}.note{padding:22px;margin-top:24px}section.content{margin:28px 0}details{margin:10px 0;padding:0 18px}summary{cursor:pointer;min-height:52px;padding:15px 0;font-size:17px;font-weight:750;line-height:1.5}details p{padding:2px 0 8px}.topics{margin-bottom:24px}.topics a{display:inline-block;padding:8px 0;margin-right:18px}footer{margin-top:36px;padding-top:18px;border-top:1px solid #ffffff20;font-size:14px}h1,h2,h3,p,a,summary{overflow-wrap:anywhere}section{scroll-margin-top:20px}.skip{position:absolute;left:16px;top:-100px;padding:10px 16px;background:#05050b;z-index:2}.skip:focus{top:8px}@media(max-width:640px){.grid{grid-template-columns:1fr}.hero{padding-top:26px}.actions{align-items:stretch;flex-direction:column}.action{width:100%}.links{gap:8px 16px}.card,.note{padding:18px}}
`;
const footer = `<footer aria-label="Sway help and terms"><a href="/about">About Sway</a><a href="/faq">FAQ</a><a href="/support">Support</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a><a href="/privacy/data-deletion">Data deletion</a><a href="/legal/payments">Payment terms</a><a href="/legal/payouts">Payout terms</a><a href="/legal/tickets">Ticket terms</a></footer>`;
function renderPage(path, title, description, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#05050b"><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="https://app.sway.tips${path}"><style>${styles}</style></head><body><a class="skip" href="#main">Skip to content</a><div class="page"><nav class="topbar" aria-label="Sway navigation"><a class="brand" href="/">Sway</a><div class="links"><a href="/discover">Discover</a><a href="/home">Join a room</a><a href="/account/login">Log in</a></div></nav><main id="main">${content}</main>${footer}</div></body></html>`;
}
const ABOUT_PAGE_HTML = renderPage('/about', 'About Sway | Every Way to Play', 'Your performer page, live rooms, music projects, and release work in one Sway account.', `
<header class="hero"><h1>About Sway</h1><p class="intro">Sway connects your performer page, live audience, music projects, and release work in one account. Fans, DJs, musicians, songwriters, and collaborators use different parts of the same platform.</p><div class="actions"><a class="action primary" href="/account/signup?intent=performer">Create your performer page</a><a class="action" href="/home">Join a live room</a></div></header>
<section class="content" aria-labelledby="parts"><h2 id="parts">Find what you came to do</h2><div class="grid">
<article class="card"><h3>Your public page</h3><p>Share your name, story, featured media, booking details, and links. Choose whether your page is Public, Unlisted, or Draft.</p><a href="/talent/profile">Open Profile</a></article>
<article class="card"><h3>Your live rooms and shows</h3><p>Share a room link or QR code, review requests, manage the queue, and keep the recap when a room ends. Manage upcoming events in Shows. A request never takes control away from the performer.</p><a href="/talent/gigs">Open Live Rooms</a> · <a href="/talent/shows">Open Shows</a></article>
<article class="card"><h3>Your music and collaborators</h3><p>Keep original recordings and works in progress in Catalog. Share selected work with collaborators by permission. Private files do not become public just because they are uploaded.</p><a href="/talent/files">Open Catalog</a></article>
<article class="card"><h3>Your release work</h3><p>Prepare singles, EPs, and albums with track order, artwork, credits, and rights information. Saving a release draft does not send it to music stores.</p><a href="/talent/files">Open music projects</a></article>
</div></section>
<section class="note" aria-labelledby="listening"><h2 id="listening">sway.dio and music distribution</h2><p>sway.dio is the original-music listening part of Sway being developed alongside these tools. Complete external distribution, royalty accounting, collaborator split payouts, and transfers from another distributor are not available in the current release.</p><p>Keep an existing distribution service in place until Sway can confirm delivery and continuity for your music.</p></section>
<section class="content" aria-labelledby="control"><h2 id="control">Your work stays yours</h2><p>Uploading music or preparing a release does not transfer your music ownership to Sway. Performers decide what to approve and play. Paid requests, tips, and cash-outs are available only when the required account and payment setup is ready.</p><p>Check the <a href="/legal/payments">payment terms</a> and <a href="/legal/payouts">cash-out terms</a> before authorizing money. For practical questions, open the <a href="/faq">Sway FAQ</a>.</p></section>`);
const FAQ_PAGE_HTML = renderPage('/faq', 'Sway FAQ | Accounts, rooms, music, and earnings', 'Answers about Sway accounts, performer pages, live rooms, music projects, releases, and cash-outs.', `
<header class="hero"><h1>Sway FAQ</h1><p class="intro">Answers about accounts, live rooms, music, and earnings.</p></header>
<nav class="topics" aria-label="FAQ topics"><a href="#getting-started">Getting started</a><a href="#live-rooms">Live rooms</a><a href="#music">Music and releases</a><a href="#money">Payments and help</a></nav>
<section id="getting-started" class="content" aria-labelledby="getting-started-heading"><h2 id="getting-started-heading">Getting started</h2>
<details><summary>Do I need to download an app?</summary><p>No. Open Sway in your phone or computer browser. A performer’s shared room link or QR code takes you to their room.</p></details>
<details><summary>How do I create my performer page?</summary><p>Choose <a href="/account/signup?intent=performer">Create your performer page</a>, create your account, and verify your email. Continue through performer setup in the same account. Already registered? <a href="/account/login?next=%2Faccount%3Fintent%3Dperformer">Log in to continue performer setup</a>.</p></details>
<details><summary>What do Public, Unlisted, and Draft mean?</summary><p>Public pages can appear in discovery. Unlisted pages can be opened with their direct link but are not listed in discovery. Draft pages are not published. Change this in your <a href="/talent/profile">Profile</a> and wait for the saved setting to be confirmed.</p></details>
</section>
<section id="live-rooms" class="content" aria-labelledby="live-rooms-heading"><h2 id="live-rooms-heading">Live rooms</h2>
<details><summary>How do I join the right room?</summary><p>Open the performer’s room link or scan their Sway QR code. You can also <a href="/home">join with a room link or ID</a>. Check the performer and room before sending a request or authorizing a payment.</p></details>
<details><summary>Does a paid request guarantee a song will be played?</summary><p>No. The performer chooses which requests to approve and play. A Boost applies to an already-approved request; it does not buy approval. Check your private request status and the <a href="/legal/payments">payment and refund terms</a> for the recorded outcome.</p></details>
<details><summary>What happens when I end a room?</summary><p>The room stops taking new requests and opens its recap. Start a new room for a new session rather than overwriting the previous room’s history. Wait for the close to finish before leaving the screen.</p></details>
</section>
<section id="music" class="content" aria-labelledby="music-heading"><h2 id="music-heading">Music and releases</h2>
<details><summary>Are my Catalog files public?</summary><p>No. Catalog holds private music projects and files. Sharing selected work with a collaborator is separate from publishing it. Review who has access before sharing and use <a href="/talent/files">Catalog</a> to manage your projects.</p></details>
<details><summary>Does a release draft put my music on streaming services?</summary><p>No. A draft prepares the tracks, artwork, credits, and rights information. It is not confirmation of delivery to Spotify, Apple Music, or another service. Complete external distribution and royalty accounting are not available in the current release.</p></details>
<details><summary>What is sway.dio?</summary><p>sway.dio is the original-music listening part of Sway. It is being developed alongside performer pages, live rooms, Catalog, collaboration, and release preparation. Read <a href="/about">About Sway</a> for the wider product and current limits.</p></details>
</section>
<section id="money" class="content" aria-labelledby="money-heading"><h2 id="money-heading">Payments and help</h2>
<details><summary>Why is a payment or cash-out unavailable?</summary><p>Payment and cash-out options depend on the required account and payment setup. A saved PayPal or Venmo destination alone does not mean withdrawals are enabled. Review the availability shown in your account and the <a href="/legal/payouts">cash-out terms</a>. No cash-out is complete until payment is confirmed.</p></details>
<details><summary>What should I do when a save or payment is interrupted?</summary><p>Keep the page open and check its status before submitting again. A lost connection does not always mean the first attempt failed. Keep your room, order, or payment reference. The <a href="/support">Support page</a> lists current help options; do not post passwords, payment details, or private links publicly.</p></details>
</section>`);

function installDjBetaAboutSurface() {
  let express;
  try { express = require('express'); }
  catch (error) { if (error && error.code === 'MODULE_NOT_FOUND') return; throw error; }
  const flag = Symbol.for('sway.djBetaAboutSurface.v1');
  if (express.application[flag]) return;
  const originalGet = express.application.get;
  express.application.get = function swayPublicInformationGet(path, ...handlers) {
    if ((path === '/about' || path === '/faq') && handlers.length > 0) {
      const html = path === '/faq' ? FAQ_PAGE_HTML : ABOUT_PAGE_HTML;
      return originalGet.call(this, path, (_req, res) => {
        res.set('Cache-Control', 'no-store');
        res.status(200).type('html').send(html);
      });
    }
    return originalGet.call(this, path, ...handlers);
  };
  Object.defineProperty(express.application, flag, { value: true, configurable: false, enumerable: false, writable: false });
}
installDjBetaAboutSurface();
module.exports = { ABOUT_PAGE_HTML, FAQ_PAGE_HTML, DJ_BETA_ABOUT_HTML: ABOUT_PAGE_HTML, installDjBetaAboutSurface };
