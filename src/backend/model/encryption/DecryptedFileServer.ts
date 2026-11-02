import {IncomingMessage, ServerResponse} from 'http';
import {promises as fsp} from 'fs';
import {pipeline} from 'stream/promises';
import {FileCrypto} from './FileCrypto';
import {Logger} from '../../Logger';

const LOG_TAG = '[DecryptedFileServer]';

type ByteRange = { start: number, end: number };

/**
 * Sends the decrypted content of an encrypted file to an HTTP client.
 * Supports conditional (ETag, Last-Modified) and byte range requests (video seeking), and HEAD.
 */
export class DecryptedFileServer {

  /**
   * Headers like Content-Type and Cache-Control should be set by the caller before calling this.
   * It only throws before anything is sent to the client (e.g.: file is missing, header is invalid),
   * so the caller can still respond with an error.
   * Errors during the streaming (e.g.: corrupted chunk) abort the connection.
   */
  public static async serve(
    req: IncomingMessage,
    res: ServerResponse,
    masterKey: Buffer,
    filePath: string
  ): Promise<void> {
    const stat = await fsp.stat(filePath);
    const fh = await fsp.open(filePath, 'r');
    let plainSize: number;
    try {
      const info = await FileCrypto.readInfo(fh);
      if (!info) {
        throw new Error('File is not encrypted: ' + filePath);
      }
      plainSize = info.plainSize;
    } finally {
      await fh.close();
    }

    // the validators come from the encrypted file: no need to decrypt anything to answer a revalidation
    const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
    const lastModified = stat.mtime.toUTCString();
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('Accept-Ranges', 'bytes');

    if (DecryptedFileServer.isNotModified(req, etag, stat.mtimeMs)) {
      res.statusCode = 304;
      res.end();
      return;
    }

    let range: ByteRange = {start: 0, end: plainSize - 1};
    let partial = false;
    const rangeHeader = req.headers['range'];
    const ifRange = req.headers['if-range'];
    // a range is ignored if the client has an other version of the file
    if (rangeHeader && (!ifRange || ifRange === etag || ifRange === lastModified)) {
      const parsed = DecryptedFileServer.parseRange(rangeHeader, plainSize);
      if (parsed === 'unsatisfiable') {
        res.statusCode = 416;
        res.setHeader('Content-Range', 'bytes */' + plainSize);
        res.setHeader('Content-Length', 0);
        res.end();
        return;
      }
      if (parsed) {
        range = parsed;
        partial = true;
      }
    }

    const length = Math.max(0, range.end - range.start + 1);
    res.statusCode = partial ? 206 : 200;
    if (partial) {
      res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + plainSize);
    }
    res.setHeader('Content-Length', length);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    try {
      await pipeline(FileCrypto.createDecryptStream(masterKey, filePath, range.start, range.end), res);
    } catch (e) {
      // the client closing the connection (seeking, navigating away) is normal
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        Logger.error(LOG_TAG, 'Error during sending a decrypted file: ' + filePath, (e as Error)?.message);
      }
      res.destroy();
    }
  }

  private static isNotModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }
    const noneMatch = req.headers['if-none-match'];
    if (noneMatch) {
      const strip = (t: string): string => t.trim().replace(/^W\//, '');
      return noneMatch.split(',').some(t => t.trim() === '*' || strip(t) === strip(etag));
    }
    const modifiedSince = req.headers['if-modified-since'];
    if (modifiedSince) {
      const t = Date.parse(modifiedSince);
      return !isNaN(t) && Math.floor(mtimeMs / 1000) * 1000 <= t;
    }
    return false;
  }

  /**
   * Only a single range is supported (it is all browsers and ffmpeg use),
   * for anything else the full content is sent.
   */
  private static parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      return null;
    }
    if (m[1] === '') { // last N bytes
      const suffix = parseInt(m[2], 10);
      if (suffix === 0 || size === 0) {
        return 'unsatisfiable';
      }
      return {start: Math.max(0, size - suffix), end: size - 1};
    }
    const start = parseInt(m[1], 10);
    const explicitEnd = m[2] === '' ? null : parseInt(m[2], 10);
    if (explicitEnd !== null && explicitEnd < start) {
      return null; // not a valid range, it is ignored
    }
    if (start >= size) {
      return 'unsatisfiable';
    }
    return {start, end: explicitEnd === null ? size - 1 : Math.min(explicitEnd, size - 1)};
  }
}
