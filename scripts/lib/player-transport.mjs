// Native endpoints are explicit and local. Never resolve a hostname into a new target.
export function localHttpEndpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Choose a numeric loopback player origin without credentials, path or query.');
  }
  return url.origin;
}
export function requestTimeout(value = 5000) {
  if (!Number.isInteger(value) || value < 50 || value > 30000) throw new Error('Invalid player deadline.');
  return value;
}
export async function boundedOperation(ms, operation, abort) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Player response timed out. Delivery may be uncertain; do not retry the command.'));
      try { abort?.(); } catch { /* Timeout remains the failure even if cancellation fails. */ }
    }, ms);
  });
  try { return await Promise.race([deadline, Promise.resolve().then(operation)]); }
  finally { clearTimeout(timer); }
}
export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function secondsMs(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null; }
export function optionalText(value) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2048) : null; }
