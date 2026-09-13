import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AudioRangeNotSatisfiableError, audioContentRange, type AudioByteRange } from './audio-byte-range';

type PrivateListeningReader = {
  listenToGrantedOriginal(input: {
    grantId: string; userId: string; rangeHeader?: string; ifRange?: string;
  }): Promise<{
    version: { mimeType: string }; stream: Readable; byteSize: number;
    range?: AudioByteRange; etag: string;
  }>;
};

export async function sendPrivateAudioListeningResponse(
  req: Request,
  res: Response,
  service: PrivateListeningReader,
  userId: string
) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    const opened = await service.listenToGrantedOriginal({
      grantId: String(req.params.grantId || ''),
      userId,
      rangeHeader: req.method === 'HEAD' ? undefined : req.get('range'),
      ifRange: req.get('if-range')
    });
    res.status(opened.range ? 206 : 200);
    res.setHeader('Content-Type', opened.version.mimeType);
    res.setHeader('Content-Length', String(opened.byteSize));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', opened.etag);
    if (opened.range) res.setHeader('Content-Range', audioContentRange(opened.range));
    if (req.method === 'HEAD') {
      opened.stream.destroy();
      res.end();
      return;
    }
    // pipeline closes the object stream if the browser aborts or seeks again.
    await pipeline(opened.stream, res);
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy();
      return;
    }
    if (error instanceof AudioRangeNotSatisfiableError) {
      res.setHeader('Content-Range', `bytes */${error.totalBytes}`);
      res.status(416).end();
      return;
    }
    const status = Number((error as { status?: number })?.status);
    const publicStatus = [403, 404, 410, 415].includes(status) ? status : 503;
    res.status(publicStatus).json({
      error: publicStatus === 503
        ? 'Audio listening is temporarily unavailable.'
        : 'This audio file is unavailable or your access has ended.'
    });
  }
}
