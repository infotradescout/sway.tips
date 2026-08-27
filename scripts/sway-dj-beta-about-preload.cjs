'use strict';

/**
 * Opening DJ beta About/FAQ surface.
 *
 * This file is loaded with NODE_OPTIONS in production so the existing
 * /about and /faq registrations serve the focused live-room explanation
 * without changing Request, Tip, Boost, payment, queue, or account behavior.
 */

const DJ_BETA_ABOUT_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#05050b" />
    <title>Sway for DJs | Run the crowd without stopping the set</title>
    <meta
      name="description"
      content="Sway gives DJs and live performers one room for Requests, Tips, and Boosts. Share a QR code or link, manage the queue, and keep control of what gets approved and played."
    />
    <style>
      :root {
        color-scheme: dark;
        --bg: #05050b;
        --panel: rgba(17, 18, 31, 0.88);
        --panel-strong: rgba(22, 23, 39, 0.96);
        --line: rgba(255, 255, 255, 0.11);
        --text: #f8f8ff;
        --muted: #b7b8ca;
        --pink: #f04bd8;
        --purple: #9f6dff;
        --cyan: #42d9ff;
        --green: #65e6b3;
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
      }

      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        min-width: 320px;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(900px 520px at 12% -8%, rgba(240, 75, 216, 0.18), transparent 62%),
          radial-gradient(840px 520px at 96% 4%, rgba(66, 217, 255, 0.14), transparent 58%),
          linear-gradient(180deg, #070712 0%, var(--bg) 42%, #030308 100%);
      }

      a { color: inherit; }
      a:focus-visible,
      button:focus-visible {
        outline: 3px solid var(--cyan);
        outline-offset: 3px;
      }

      .page {
        width: min(1120px, calc(100% - 28px));
        margin: 0 auto;
        padding: 18px 0 64px;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 58px;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        text-decoration: none;
        font-size: 20px;
        font-weight: 900;
        letter-spacing: -0.03em;
      }

      .brand-mark {
        display: grid;
        width: 34px;
        height: 34px;
        place-items: center;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        background: linear-gradient(135deg, rgba(240, 75, 216, 0.95), rgba(66, 217, 255, 0.9));
        box-shadow: 0 0 30px rgba(240, 75, 216, 0.27);
        color: #fff;
        font-size: 18px;
      }

      .top-link {
        color: var(--muted);
        font-size: 14px;
        font-weight: 800;
        text-decoration: none;
      }

      .top-link:hover { color: var(--text); }

      .hero {
        position: relative;
        overflow: hidden;
        margin-top: 14px;
        padding: clamp(28px, 7vw, 68px);
        border: 1px solid var(--line);
        border-radius: 28px;
        background:
          linear-gradient(145deg, rgba(22, 18, 39, 0.96), rgba(8, 10, 21, 0.92)),
          var(--panel-strong);
        box-shadow: var(--shadow);
      }

      .hero::after {
        content: "";
        position: absolute;
        width: 330px;
        height: 330px;
        right: -120px;
        top: -150px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(66, 217, 255, 0.2), transparent 68%);
        pointer-events: none;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        color: #f8c9ff;
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .eyebrow::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--green);
        box-shadow: 0 0 18px rgba(101, 230, 179, 0.75);
      }

      h1 {
        max-width: 850px;
        margin: 18px 0 0;
        font-size: clamp(42px, 8vw, 84px);
        line-height: 0.98;
        letter-spacing: -0.055em;
      }

      .hero-copy {
        max-width: 760px;
        margin: 22px 0 0;
        color: #d9d9e8;
        font-size: clamp(17px, 2.5vw, 21px);
        line-height: 1.58;
      }

      .setup-note {
        max-width: 800px;
        margin: 20px 0 0;
        padding: 15px 17px;
        border: 1px solid rgba(66, 217, 255, 0.2);
        border-radius: 14px;
        background: rgba(66, 217, 255, 0.07);
        color: #dff8ff;
        font-size: 15px;
        line-height: 1.58;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 11px;
        margin-top: 28px;
      }

      .action {
        display: inline-flex;
        min-height: 48px;
        align-items: center;
        justify-content: center;
        padding: 0 18px;
        border: 1px solid var(--line);
        border-radius: 13px;
        background: rgba(255, 255, 255, 0.04);
        color: var(--text);
        font-size: 14px;
        font-weight: 900;
        text-decoration: none;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
      }

      .action:hover {
        transform: translateY(-1px);
        border-color: rgba(255, 255, 255, 0.25);
      }

      .action.primary {
        border-color: rgba(240, 75, 216, 0.55);
        background: linear-gradient(100deg, var(--pink), var(--purple) 58%, #6a9dff);
        box-shadow: 0 12px 38px rgba(159, 109, 255, 0.28);
      }

      section.content {
        margin-top: 44px;
      }

      .section-heading {
        max-width: 760px;
        margin-bottom: 18px;
      }

      h2 {
        margin: 0;
        font-size: clamp(28px, 4.5vw, 44px);
        line-height: 1.08;
        letter-spacing: -0.035em;
      }

      .section-heading p {
        margin: 10px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.62;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }

      .card,
      .step,
      .control-panel,
      .beta-panel {
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
        backdrop-filter: blur(18px);
      }

      .card {
        min-height: 170px;
        padding: 22px;
        border-radius: 18px;
      }

      .card-number {
        display: grid;
        width: 32px;
        height: 32px;
        place-items: center;
        border-radius: 11px;
        background: linear-gradient(135deg, rgba(240, 75, 216, 0.18), rgba(66, 217, 255, 0.14));
        color: #f7c5ff;
        font-size: 13px;
        font-weight: 900;
      }

      h3 {
        margin: 16px 0 0;
        font-size: 19px;
        letter-spacing: -0.02em;
      }

      .card p,
      .step p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.62;
      }

      .steps {
        display: grid;
        gap: 11px;
      }

      .step {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        gap: 14px;
        align-items: start;
        padding: 17px;
        border-radius: 16px;
      }

      .step-index {
        display: grid;
        width: 42px;
        height: 42px;
        place-items: center;
        border-radius: 14px;
        background: linear-gradient(135deg, rgba(240, 75, 216, 0.9), rgba(159, 109, 255, 0.9));
        color: #fff;
        font-size: 14px;
        font-weight: 900;
      }

      .step h3 { margin: 2px 0 0; }

      .truth-note {
        margin-top: 13px;
        padding: 17px 18px;
        border-left: 3px solid var(--cyan);
        border-radius: 0 14px 14px 0;
        background: rgba(66, 217, 255, 0.07);
        color: #e4faff;
        font-size: 15px;
        line-height: 1.62;
      }

      .control-panel,
      .beta-panel {
        padding: clamp(20px, 4vw, 30px);
        border-radius: 20px;
      }

      .control-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px 22px;
        margin: 18px 0 0;
        padding: 0;
        list-style: none;
      }

      .control-list li {
        position: relative;
        padding-left: 25px;
        color: #d9d9e7;
        font-size: 15px;
        line-height: 1.55;
      }

      .control-list li::before {
        content: "✓";
        position: absolute;
        left: 0;
        top: 0;
        color: var(--green);
        font-weight: 900;
      }

      .beta-panel {
        border-color: rgba(240, 75, 216, 0.23);
        background:
          linear-gradient(135deg, rgba(240, 75, 216, 0.09), rgba(66, 217, 255, 0.06)),
          var(--panel);
      }

      .beta-panel p {
        max-width: 820px;
        margin: 12px 0 0;
        color: #dbdbea;
        font-size: 16px;
        line-height: 1.65;
      }

      .final-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .final-actions .action {
        width: 100%;
        min-height: 54px;
      }

      footer {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 18px;
        align-items: center;
        justify-content: center;
        margin-top: 42px;
        padding: 24px 0 0;
        border-top: 1px solid var(--line);
      }

      footer a {
        color: #999bad;
        font-size: 12px;
        font-weight: 750;
        text-decoration: none;
      }

      footer a:hover { color: var(--text); }

      @media (max-width: 760px) {
        .page { width: min(100% - 20px, 1120px); padding-top: 8px; }
        .topbar { min-height: 54px; }
        .hero { border-radius: 22px; }
        .actions { display: grid; grid-template-columns: 1fr; }
        .action { width: 100%; }
        section.content { margin-top: 34px; }
        .grid,
        .control-list,
        .final-actions { grid-template-columns: 1fr; }
        .card { min-height: 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
        .action { transition: none; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <nav class="topbar" aria-label="Sway navigation">
        <a class="brand" href="/">
          <span class="brand-mark" aria-hidden="true">S</span>
          <span>Sway</span>
        </a>
        <a class="top-link" href="/home">Join a live room</a>
      </nav>

      <header class="hero">
        <p class="eyebrow">Sway live rooms</p>
        <h1>Run the crowd without stopping the set.</h1>
        <p class="hero-copy">Sway gives DJs and live performers one room for Requests, Tips, and Boosts. Start a room, share the QR code or link, manage the queue, and keep control of what gets approved and played.</p>
        <p class="setup-note"><strong>Sway works alongside your existing DJ setup.</strong> Keep using Serato, Rekordbox, VirtualDJ, Tidal, USB drives, or your normal deck workflow. Sway handles the audience interaction around it. No patron app download is required for the web experience.</p>
        <div class="actions" aria-label="Get started with Sway">
          <a class="action primary" href="/account/signup">Create your DJ account</a>
          <a class="action" href="/account/login">Log in and start</a>
          <a class="action" href="/home">Join a live room</a>
        </div>
      </header>

      <section class="content" aria-labelledby="handles-heading">
        <div class="section-heading">
          <h2 id="handles-heading">What Sway handles</h2>
          <p>The crowd gets one clear place to interact. You get one queue instead of shouted requests, messages, screenshots, and paper notes.</p>
        </div>
        <div class="grid">
          <article class="card">
            <span class="card-number">01</span>
            <h3>Requests in one queue</h3>
            <p>Collect song requests and custom requests inside one performer-controlled live room.</p>
          </article>
          <article class="card">
            <span class="card-number">02</span>
            <h3>Tips in the same room</h3>
            <p>When paid actions are available for the performer, patrons can send direct support without leaving the room.</p>
          </article>
          <article class="card">
            <span class="card-number">03</span>
            <h3>Approved boosts</h3>
            <p>Patrons can Boost an already-approved Request. A Boost never forces approval and never takes control away from the DJ.</p>
          </article>
          <article class="card">
            <span class="card-number">04</span>
            <h3>Clear status</h3>
            <p>Patrons can follow what happened to their action instead of repeatedly asking whether you saw it.</p>
          </article>
        </div>
      </section>

      <section class="content" aria-labelledby="patron-heading">
        <div class="section-heading">
          <h2 id="patron-heading">How patrons use Sway</h2>
          <p>The crowd can enter from a phone browser and finish the action without learning your equipment or interrupting the set.</p>
        </div>
        <div class="steps">
          <article class="step"><span class="step-index">1</span><div><h3>Enter the right room</h3><p>Scan the DJ’s Sway QR code or open the shared room link.</p></div></article>
          <article class="step"><span class="step-index">2</span><div><h3>Choose an action</h3><p>Send a Request, Tip, or Boost that is available in that room.</p></div></article>
          <article class="step"><span class="step-index">3</span><div><h3>Review before submitting</h3><p>Confirm the request details and any applicable amount before authorizing it.</p></div></article>
          <article class="step"><span class="step-index">4</span><div><h3>Follow the result</h3><p>Use the private status view to see what happened without interrupting the DJ.</p></div></article>
        </div>
        <p class="truth-note"><strong>A Request is not a promise that a song will be played.</strong> The DJ keeps artistic and operational control of the room. Payment is not shown as complete before the backend and payment provider confirm it.</p>
      </section>

      <section class="content" aria-labelledby="performer-heading">
        <div class="section-heading">
          <h2 id="performer-heading">How to run Sway tonight</h2>
          <p>The opening flow stays centered on the live room, so you can get from account to working QR code quickly.</p>
        </div>
        <div class="steps">
          <article class="step"><span class="step-index">1</span><div><h3>Create or open your account</h3><p>Sign up or log in, then activate Pro Mode if your account has not yet been set up as a performer.</p></div></article>
          <article class="step"><span class="step-index">2</span><div><h3>Start your live room</h3><p>Confirm the room settings, Request source, minimum support amount, and operating mode.</p></div></article>
          <article class="step"><span class="step-index">3</span><div><h3>Share the room</h3><p>Display the Sway QR code or send the room link where the crowd can reach it.</p></div></article>
          <article class="step"><span class="step-index">4</span><div><h3>Manage the queue</h3><p>Review incoming actions, approve or deny Requests, order approved items, pause or resume intake, update status, and complete fulfilled items.</p></div></article>
          <article class="step"><span class="step-index">5</span><div><h3>Close the room</h3><p>End the session cleanly and review the room recap, activity, and available earnings information.</p></div></article>
        </div>
      </section>

      <section class="content" aria-labelledby="control-heading">
        <div class="control-panel">
          <h2 id="control-heading">You remain in control</h2>
          <ul class="control-list">
            <li>Sway does not replace DJ software or control the decks.</li>
            <li>A paid Request does not guarantee that it will be played.</li>
            <li>Boosts apply only to Requests the performer has already approved.</li>
            <li>Patrons cannot buy control of the performance.</li>
            <li>Payment success waits for confirmed provider and backend state.</li>
            <li>Refund, release, capture, and payout language follows the recorded outcome.</li>
          </ul>
        </div>
      </section>

      <section class="content" aria-labelledby="beta-heading">
        <div class="beta-panel">
          <p class="eyebrow">Opening beta</p>
          <h2 id="beta-heading">Focused on the live room</h2>
          <p>The opening DJ beta is focused on Request, Tip, Boost, queue control, patron status, and room recap. No DJ software connection or patron app download is required.</p>
          <div class="final-actions">
            <a class="action primary" href="/account/signup">Create your DJ account</a>
            <a class="action" href="/account/login">Log in and start</a>
            <a class="action" href="/home">Join a live room</a>
          </div>
        </div>
      </section>

      <footer aria-label="Sway legal and support links">
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms</a>
        <a href="/support">Support</a>
        <a href="/privacy/data-deletion">Data deletion</a>
        <a href="/legal/payments">Payment terms</a>
        <a href="/legal/payouts">Payout terms</a>
        <a href="/legal/tickets">Ticket terms</a>
      </footer>
    </main>
  </body>
</html>`;

function installDjBetaAboutSurface() {
  let express;
  try {
    express = require('express');
  } catch (error) {
    // NODE_OPTIONS also runs during dependency installation. The route patch
    // becomes active when the real server starts after Express is installed.
    if (error && error.code === 'MODULE_NOT_FOUND') return;
    throw error;
  }

  const patchFlag = Symbol.for('sway.djBetaAboutSurface.v1');
  if (express.application[patchFlag]) return;

  const originalGet = express.application.get;
  let registrationLogged = false;

  express.application.get = function swayDjBetaAboutGet(path, ...handlers) {
    if ((path === '/about' || path === '/faq') && handlers.length > 0) {
      if (!registrationLogged) {
        registrationLogged = true;
        console.log('[sway.about] DJ beta About and FAQ surface active.');
      }
      return originalGet.call(this, path, (_req, res) => {
        res.set('Cache-Control', 'no-store');
        res.status(200).type('html').send(DJ_BETA_ABOUT_HTML);
      });
    }

    return originalGet.call(this, path, ...handlers);
  };

  Object.defineProperty(express.application, patchFlag, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
}

installDjBetaAboutSurface();

module.exports = {
  DJ_BETA_ABOUT_HTML,
  installDjBetaAboutSurface
};
