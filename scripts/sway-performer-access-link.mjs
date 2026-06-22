import { createHmac } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readFlag(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const actorUserId = readFlag('--actor-user-id')?.trim() || '';
const baseUrl = (readFlag('--base-url')?.trim() || process.env.SWAY_PERFORMER_ACCESS_BASE_URL || 'https://app.sway.tips').replace(/\/+$/, '');
const ttlMinutes = Number(readFlag('--ttl-minutes')?.trim() || '15');
const secret = process.env.SWAY_PERFORMER_BOOTSTRAP_SECRET?.trim() || '';

if (!secret) {
  console.error('SWAY_PERFORMER_BOOTSTRAP_SECRET is required.');
  process.exit(1);
}

if (!UUID_PATTERN.test(actorUserId)) {
  console.error('A valid --actor-user-id UUID is required.');
  process.exit(1);
}

if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
  console.error('--ttl-minutes must be a positive number.');
  process.exit(1);
}

const expiresAt = new Date(Date.now() + Math.floor(ttlMinutes) * 60 * 1000).toISOString();
const payload = Buffer.from(JSON.stringify({
  v: 1,
  actor_user_id: actorUserId,
  exp: expiresAt
}), 'utf8').toString('base64url');

const signature = createHmac('sha256', secret)
  .update(payload, 'utf8')
  .digest('base64url');

const token = `${payload}.${signature}`;
const url = `${baseUrl}/api/talent/session/bootstrap?token=${encodeURIComponent(token)}`;

console.log(`Actor user ID: ${actorUserId}`);
console.log(`Expires at: ${expiresAt}`);
console.log(url);
