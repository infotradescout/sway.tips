import { registerDirectMusicRoutes } from './src/server/direct-music/routes';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
    app.get(/^\/assets\/dev-sandbox-.*\.js$/, (_req, res) => {
      res.status(404).send('Not found');
    });
    app.use(express.static(distPath, { index: false }));
    const handlePublicPerformerRoute = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const htmlPath = path.join(distPath, shellHtmlRelativePath('patron'));
        const template = readFileSync(htmlPath, 'utf8');
        await renderPublicPerformerDocument(req, res, template);
      } catch (error) {
        next(error);
      }
    };
    app.get('/p/:handle', handlePublicPerformerRoute);
    app.get(/^\/p\/.+$/, handlePublicPerformerRoute);
    app.get('*', async (req, res, next) => {
      const shell = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
      if (!isShellAllowed(shell)) {
        res.status(404).send('Not found');
        return;
      }
      try {
        const htmlPath = path.join(distPath, shellHtmlRelativePath(shell));
        const template = readFileSync(htmlPath, 'utf8');
        const html = injectShareMetadata(template, await resolveShareMetadata(req));
        applyNoStoreHeaders(res);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (error) {
        next(error);
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('[sway.startup] server failed before accepting traffic:', error);
  process.exitCode = 1;
});
