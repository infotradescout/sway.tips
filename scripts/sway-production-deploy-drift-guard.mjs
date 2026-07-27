// Production deploy drift guard.
//
// Polls the production build-marker endpoints until every domain reports the
// commit under review, or until the timeout expires. This is the automated
// form of the Release-State Rule in docs/SWAY_AUDIT_HOLD_PRODUCTION_STATE.md:
// declare the intended production commit before deploy, observe the actual
// production commit after deploy.
//
// Extracted verbatim from .github/workflows/production-deploy-drift-guard.yml
// when GitHub Actions was retired. The logic is unchanged; only the commit
// source moved from ${{ github.sha }} to an argument or local HEAD.
//
// Usage:
//   npm run guard:production-drift              # verifies local HEAD reached production
//   npm run guard:production-drift -- <sha>     # verifies a specific commit
//   EXPECTED_SHA=<sha> npm run guard:production-drift
//
// Exit 0 when all domains match, exit 1 on timeout or mismatch.

import { execSync } from 'node:child_process';

const urls = [
  'https://sway.tips/api/build-marker',
  'https://www.sway.tips/api/build-marker',
  'https://app.sway.tips/api/build-marker'
];

function resolveExpectedSha() {
  const fromArg = process.argv[2]?.trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env.EXPECTED_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    console.error('No commit given and git rev-parse HEAD failed. Pass a sha or set EXPECTED_SHA.');
    process.exit(1);
  }
}

const expectedSha = resolveExpectedSha();
const timeoutMs = 15 * 60 * 1000;
const intervalMs = 30 * 1000;
const requestTimeoutMs = 12 * 1000;
const started = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatObservation(observation) {
  const lines = [];
  lines.push(`URL: ${observation.url}`);
  lines.push(`HTTP: ${observation.status}`);
  lines.push(`Content-Type: ${observation.contentType || 'missing'}`);
  if (observation.error) lines.push(`Error: ${observation.error}`);
  if (observation.bodySnippet) lines.push(`Body snippet: ${observation.bodySnippet}`);
  if (observation.commit) lines.push(`Commit: ${observation.commit}`);
  return lines.join('\n');
}

async function checkOnce() {
  const observations = [];
  let allOk = true;

  for (const url of urls) {
    const observation = {
      url,
      status: 'n/a',
      contentType: '',
      commit: '',
      error: '',
      bodySnippet: ''
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetch(url, { redirect: 'follow', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      observation.status = response.status;
      observation.contentType = response.headers.get('content-type') || '';

      const body = await response.text();
      observation.bodySnippet = body.slice(0, 180).replace(/\s+/g, ' ').trim();

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }

      if (!parsed || typeof parsed !== 'object') {
        observation.error = 'Response is not JSON.';
        allOk = false;
      } else if (parsed.service !== 'sway.tips') {
        observation.error = `Unexpected service marker: ${String(parsed.service)}`;
        allOk = false;
      } else if (typeof parsed.commit !== 'string' || parsed.commit.length < 7) {
        observation.error = 'Commit marker is missing or invalid.';
        allOk = false;
      } else {
        observation.commit = parsed.commit;
        if (parsed.commit !== expectedSha) {
          observation.error = `Commit mismatch. Expected ${expectedSha}, got ${parsed.commit}`;
          allOk = false;
        }
      }
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error);
      allOk = false;
    }

    observations.push(observation);
  }

  return { allOk, observations };
}

console.log(`Waiting for production build marker to reach ${expectedSha}`);

let attempt = 0;
while (Date.now() - started < timeoutMs) {
  attempt += 1;
  const { allOk, observations } = await checkOnce();

  console.log(`Attempt ${attempt}:`);
  for (const o of observations) {
    console.log(formatObservation(o));
    console.log('----');
  }

  if (allOk) {
    console.log('Production build marker matches the commit under review on all domains.');
    process.exit(0);
  }

  await sleep(intervalMs);
}

console.error('Timed out waiting for production build marker to match the commit under review.');
process.exit(1);
