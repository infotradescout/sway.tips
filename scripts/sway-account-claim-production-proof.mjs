import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

/**
 * Production claim-code proof using an authorized disposable performer slot.
 * Loads DATABASE_URL from .env.local; never prints the DB URL or full claim codes.
 */

dotenv.config({ path: 'd:/AAATraderCorner/TradeScout/sway/sway.tips/.env.local', override: false, quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const databaseUrl = process.env.DATABASE_URL;
const baseUrl = (process.env.SWAY_PROD_BASE_URL || 'https://app.sway.tips').replace(/\/$/, '');
const outDir = join(process.cwd(), 'tmp', 'claim-onboarding-production-proof');
mkdirSync(outDir, { recursive: true });

function fingerprint(code) {
  return createHash('sha256').update(String(code), 'utf8').digest('hex').slice(0, 12);
}

function stamp(label, data = {}) {
  console.log(JSON.stringify({ step: label, at: new Date().toISOString(), ...data }));
}

if (!databaseUrl) {
  console.error(JSON.stringify({ step: 'blocked', reason: 'DATABASE_URL missing' }));
  process.exit(2);
}

async function loadChallengeStore() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const dbOut = join(tempDir, 'prod-proof-db.bundle.cjs');
  const loginOut = join(tempDir, 'prod-proof-login.bundle.cjs');
  await Promise.all([
    build({ entryPoints: ['src/db/client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dbOut, sourcemap: false, packages: 'external' }),
    build({ entryPoints: ['src/server/performer-login.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: loginOut, sourcemap: false, packages: 'external' })
  ]);
  const require = createRequire(import.meta.url);
  return {
    createSwayDb: require(dbOut).createSwayDb,
    ...require(loginOut)
  };
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() || [];
  if (raw.length) return raw.map((v) => v.split(';')[0]).join('; ');
  const single = response.headers.get('set-cookie');
  return single ? single.split(';')[0] : '';
}

async function jsonFetch(path, { method = 'POST', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, cookie: cookieFrom(response), response };
}

async function issueDisposableClaim(storeMods) {
  const {
    createSwayDb,
    createPerformerLoginChallengeStore,
    hashPerformerLoginRequesterIp,
    PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
    PERFORMER_CLAIM_CODE_TTL_MS
  } = storeMods;

  const suffix = randomBytes(3).toString('hex');
  const handle = `qadispose${suffix}`;
  const displayName = `QA Disposable ${suffix}`;
  const db = createSwayDb(databaseUrl);
  const store = createPerformerLoginChallengeStore({ dbOverride: db });
  const ipHash = hashPerformerLoginRequesterIp('claim-prod-proof');

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    const userId = randomUUID();
    const performerId = randomUUID();
    await pg.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, pro_mode_status)
       VALUES ($1, NULL, $2, NULL, 'performer', 'disabled')`,
      [userId, displayName]
    );
    await pg.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, is_active, onboarding_status)
       VALUES ($1, $2, $3, $4, false, 'created')`,
      [performerId, userId, handle, displayName]
    );

    const issued = await store.issueChallenge({
      actorUserId: userId,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId },
      requesterIpHash: ipHash,
      ttlMs: PERFORMER_CLAIM_CODE_TTL_MS
    });

    return {
      userId,
      performerId,
      handle,
      displayName,
      token: issued.token,
      fingerprint: fingerprint(issued.token)
    };
  } finally {
    await pg.end();
  }
}

async function readOwnership(performerId) {
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    const row = await pg.query(
      `SELECT p.id, p.handle, p.is_active, p.onboarding_status, p.owner_user_id,
              u.email, u.role, u.pro_mode_status, u.email_verified_at IS NOT NULL AS email_verified,
              EXISTS (
                SELECT 1 FROM performer_login_challenges c
                WHERE c.challenge_type = 'claim_code'
                  AND c.consumed_at IS NOT NULL
                  AND (c.challenge_metadata->>'performerId') = $1::text
              ) AS code_consumed
       FROM performers p
       JOIN users u ON u.id = p.owner_user_id
       WHERE p.id = $1
       LIMIT 1`,
      [performerId]
    );
    return row.rows[0] || null;
  } finally {
    await pg.end();
  }
}

async function captureMobileEvidence(claimCode, label) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2
    });
    await page.goto(`${baseUrl}/signup?claim=${encodeURIComponent(claimCode)}`, {
      waitUntil: 'networkidle',
      timeout: 90000
    });
    await page.waitForSelector('text=Create your Sway account', { timeout: 60000 });
    const prefill = await page.locator('input[name=claimCode]').inputValue();
    const valid = await page.getByText('Performer profile found:').isVisible().catch(() => false);
    const invalid = await page.getByText(/Code already used|Code expired|Code not recognized/).isVisible().catch(() => false);
    const shot = join(outDir, `${label}-signup-390x844.png`);
    await page.screenshot({ path: shot, fullPage: true });
    return {
      prefillMatches: prefill === claimCode,
      validPreview: valid,
      invalidPreview: invalid,
      screenshot: shot
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const evidence = {
    baseUrl,
    newAccount: {},
    reuseRejected: {},
    existingAccount: {},
    mobile: {}
  };

  stamp('load_store');
  const mods = await loadChallengeStore();

  stamp('issue_disposable_new_account_code');
  const claimA = await issueDisposableClaim(mods);
  evidence.newAccount = {
    handle: claimA.handle,
    performerId: claimA.performerId,
    fingerprint: claimA.fingerprint
  };
  writeFileSync(join(outDir, 'claim-a.fingerprint.txt'), claimA.fingerprint);

  stamp('mobile_pre_redeem_evidence');
  evidence.mobile.preRedeem = await captureMobileEvidence(claimA.token, 'pre-redeem');

  stamp('peek_valid');
  const peek = await jsonFetch('/api/account/claim/peek', { body: { code: claimA.token } });
  if (peek.status !== 200 || !peek.data?.enablesProMode) {
    throw new Error(`peek failed status=${peek.status}`);
  }

  const email = `qa.claim.${randomBytes(4).toString('hex')}@example.com`;
  const password = `Sway-Qa-${randomBytes(4).toString('hex')}!1`;
  const displayName = `QA Claimer ${randomBytes(2).toString('hex')}`;

  stamp('signup_with_claim');
  const signup = await jsonFetch('/api/account/signup', {
    body: {
      displayName,
      email,
      password,
      confirmPassword: password,
      termsAccepted: true,
      claimCode: claimA.token
    }
  });
  if (signup.status !== 200 || !signup.data?.redirectPath) {
    throw new Error(`signup claim failed status=${signup.status} body=${JSON.stringify(signup.data)}`);
  }
  evidence.newAccount.signupStatus = signup.status;
  evidence.newAccount.redirectPath = signup.data.redirectPath;
  evidence.newAccount.sessionCookiePresent = Boolean(signup.cookie);

  stamp('verify_ownership_pro_mode');
  const owned = await readOwnership(claimA.performerId);
  evidence.newAccount.ownership = {
    handle: owned?.handle,
    isActive: owned?.is_active,
    onboardingStatus: owned?.onboarding_status,
    role: owned?.role,
    proModeStatus: owned?.pro_mode_status,
    emailVerified: owned?.email_verified,
    codeConsumed: owned?.code_consumed,
    emailMatches: owned?.email === email
  };
  if (owned?.pro_mode_status !== 'active' || owned?.is_active !== true || owned?.code_consumed !== true) {
    throw new Error(`ownership/pro-mode proof failed: ${JSON.stringify(evidence.newAccount.ownership)}`);
  }

  stamp('reuse_rejected');
  const reuse = await jsonFetch('/api/account/signup', {
    body: {
      displayName: 'Reuse Attempt',
      email: `qa.reuse.${randomBytes(3).toString('hex')}@example.com`,
      password,
      confirmPassword: password,
      termsAccepted: true,
      claimCode: claimA.token
    }
  });
  evidence.reuseRejected = {
    status: reuse.status,
    code: reuse.data?.code || null,
    error: reuse.data?.error || null
  };
  if (!(reuse.status >= 400 && reuse.status < 500)) {
    throw new Error(`expected reused code rejection, got ${reuse.status}`);
  }

  stamp('issue_disposable_existing_account_code');
  const claimB = await issueDisposableClaim(mods);
  evidence.existingAccount.fingerprint = claimB.fingerprint;
  evidence.existingAccount.handle = claimB.handle;
  evidence.existingAccount.performerId = claimB.performerId;

  const existingEmail = `qa.existing.${randomBytes(4).toString('hex')}@example.com`;
  const existingPassword = `Sway-Qa-${randomBytes(4).toString('hex')}!1`;

  stamp('create_normal_customer_account');
  const normalSignup = await jsonFetch('/api/account/signup', {
    body: {
      displayName: 'QA Existing Customer',
      email: existingEmail,
      password: existingPassword,
      confirmPassword: existingPassword,
      termsAccepted: true
    }
  });
  if (![200, 202].includes(normalSignup.status)) {
    throw new Error(`normal signup failed status=${normalSignup.status} body=${JSON.stringify(normalSignup.data)}`);
  }

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    await pg.query(
      `UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE lower(email) = lower($1)`,
      [existingEmail]
    );
  } finally {
    await pg.end();
  }

  stamp('login_with_pending_claim');
  const login = await jsonFetch('/api/account/login', {
    body: { email: existingEmail, password: existingPassword, claimCode: claimB.token }
  });
  if (login.status !== 200 || !String(login.data?.redirectPath || '').includes('claim=')) {
    throw new Error(`login claim carry failed status=${login.status} body=${JSON.stringify(login.data)}`);
  }
  const sessionCookie = login.cookie;
  evidence.existingAccount.loginRedirect = login.data.redirectPath;
  evidence.existingAccount.sessionCookiePresent = Boolean(sessionCookie);

  stamp('attach_claim');
  const attach = await jsonFetch('/api/account/claim/attach', {
    body: { claimCode: claimB.token },
    cookie: sessionCookie
  });
  if (attach.status !== 200) {
    throw new Error(`attach failed status=${attach.status} body=${JSON.stringify(attach.data)}`);
  }

  const ownedB = await readOwnership(claimB.performerId);
  evidence.existingAccount.ownership = {
    handle: ownedB?.handle,
    isActive: ownedB?.is_active,
    role: ownedB?.role,
    proModeStatus: ownedB?.pro_mode_status,
    emailMatches: ownedB?.email === existingEmail,
    codeConsumed: ownedB?.code_consumed
  };
  if (ownedB?.pro_mode_status !== 'active' || ownedB?.email !== existingEmail || ownedB?.is_active !== true) {
    throw new Error(`existing-account claim proof failed: ${JSON.stringify(evidence.existingAccount.ownership)}`);
  }

  stamp('mobile_post_redeem_invalid_reuse_ui');
  evidence.mobile.postReuse = await captureMobileEvidence(claimA.token, 'post-reuse-invalid');

  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  stamp('CLAIM_CODE_FLOW_PASS', {
    evidencePath: join(outDir, 'evidence.json'),
    screenshots: [evidence.mobile.preRedeem.screenshot, evidence.mobile.postReuse.screenshot]
  });
}

main().catch((error) => {
  console.error(JSON.stringify({
    step: 'CLAIM_CODE_FLOW_DEFECT_FOUND',
    reason: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
});
