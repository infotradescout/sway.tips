import type { Request, Response, NextFunction } from 'express';
import {
  createAccessControl,
  routeFamilyGuard as createCoreRouteFamilyGuard,
  type AccessControl,
  type SwayActor
} from './access-control-core';
import {
  applyTrafficTruthToTelemetryRequest,
  shouldHard404ScannerRequest
} from './traffic-truth-request';

export { createAccessControl };
export type { AccessControl, SwayActor };

export function routeFamilyGuard(accessControl: AccessControl) {
  const coreGuard = createCoreRouteFamilyGuard(accessControl);
  return async (req: Request, res: Response, next: NextFunction) => {
    applyTrafficTruthToTelemetryRequest(req);

    if (shouldHard404ScannerRequest(req)) {
      res
        .status(404)
        .set({
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex, nofollow'
        })
        .send('Not found.');
      return;
    }

    await coreGuard(req, res, next);
  };
}
