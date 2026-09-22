import type { Express } from 'express';
import type { SwayDb } from '../db/client';
import type { AccessControl } from './access-control';
import { queryAcquisitionQuality } from '../../scripts/report-acquisition-quality.mjs';
import { completeUtcWindow, parseAcquisitionQualityReport } from '../acquisition-quality-report';

type ReportClient = { query: (text: string, values?: any[]) => Promise<any>; release: () => void };
/** A timed-out pool acquisition releases its eventual client rather than leaking it. */
export function acquireReportClient(pool: { connect: () => Promise<ReportClient> }, timeoutMs = 5000): Promise<ReportClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('Report connection unavailable.')); }, timeoutMs);
    Promise.resolve().then(() => pool.connect()).then(client => {
      if (settled) { client.release(); return; }
      settled = true; clearTimeout(timer); resolve(client);
    }, () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Report connection unavailable.')); } });
  });
}
export function registerAcquisitionQualityRoutes(input: { app: Express; db: SwayDb | null; accessControl: Pick<AccessControl, 'requireAdminAccess'> }) {
  const { app, db, accessControl } = input;
  let activeReads = 0;
  app.get('/api/admin/discovery-observatory/acquisition-quality', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    let client: ReportClient | undefined;
    let reserved = false;
    try {
      const access = await accessControl.requireAdminAccess(req);
      if (access.allowed === false) return res.status(access.status).json({ error: 'Administrator access required.' });
      let window: { start: string; endExclusive: string };
      try { window = completeUtcWindow(req.query.start, req.query.end); }
      catch { return res.status(400).json({ error: 'Choose 1–90 complete UTC days using start and end dates. The end date is excluded.' }); }
      if (!db) return res.status(503).json({ error: 'Acquisition evidence is unavailable. No totals were inferred.' });
      if (activeReads >= 2) return res.status(429).set('Retry-After', '5').json({ error: 'Acquisition report is busy. Please retry.' });
      activeReads++; reserved = true;
      client = await acquireReportClient(db.$client);
      const raw = await queryAcquisitionQuality(client, window.start, window.endExclusive);
      const report = parseAcquisitionQualityReport(raw, window);
      return res.json({ report });
    } catch {
      return res.status(503).json({ error: 'Acquisition evidence is unavailable. No totals were inferred.' });
    } finally {
      client?.release();
      if (reserved) activeReads--;
    }
  });
}
