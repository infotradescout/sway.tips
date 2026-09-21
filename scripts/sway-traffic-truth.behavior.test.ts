// Preserve the existing behavior cases, then exercise the current real guard over HTTP.
import './sway-traffic-truth.behavior-core.test';
await import('./sway-traffic-truth.http.test');
