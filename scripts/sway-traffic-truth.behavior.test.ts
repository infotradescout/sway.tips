// Preserve all prior behavior cases, then verify dev-asset and real HTTP boundaries.
import './sway-traffic-truth.behavior-core.test';
await import('./sway-traffic-truth.local-modules.test');
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
try { await import('./sway-traffic-truth.http.test'); }
finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}
