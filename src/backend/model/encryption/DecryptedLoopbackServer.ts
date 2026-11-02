import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import {AddressInfo} from 'net';
import {DecryptedFileServer} from './DecryptedFileServer';
import {Logger} from '../../Logger';

const LOG_TAG = '[DecryptedLoopbackServer]';

export interface DecryptedLease {
  /** URL that ffmpeg/ffprobe can read the decrypted file from */
  url: string;

  /** The URL stops working */
  release(): void;
}

/**
 * ffmpeg and ffprobe can only read files by path or URL. To avoid writing decrypted videos to the disk,
 * they read them from this server instead. It listens on the loopback interface only,
 * and a file is only reachable through a random token that lives as long as the lease.
 * It supports byte ranges, so ffmpeg can seek (e.g.: mp4 files with the moov atom at the end).
 */
export class DecryptedLoopbackServer {
  private static server: http.Server = null;
  private static starting: Promise<number> = null;
  private static readonly leases = new Map<string, { filePath: string, masterKey: Buffer }>();

  public static async lease(filePath: string, masterKey: Buffer): Promise<DecryptedLease> {
    const port = await DecryptedLoopbackServer.start();
    const token = crypto.randomBytes(16).toString('hex');
    DecryptedLoopbackServer.leases.set(token, {filePath, masterKey});
    return {
      // the extension helps ffmpeg to pick the demuxer
      url: 'http://127.0.0.1:' + port + '/' + token + '/media' + path.extname(filePath).toLowerCase(),
      release: (): void => {
        DecryptedLoopbackServer.leases.delete(token);
      }
    };
  }

  private static start(): Promise<number> {
    if (DecryptedLoopbackServer.starting) {
      return DecryptedLoopbackServer.starting;
    }
    DecryptedLoopbackServer.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        DecryptedLoopbackServer.handle(req, res).catch((e) => {
          Logger.warn(LOG_TAG, 'Error during serving a decrypted file', (e as Error)?.message);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          } else {
            res.destroy();
          }
        });
      });
      server.once('error', (e) => {
        DecryptedLoopbackServer.starting = null;
        reject(e);
      });
      server.listen(0, '127.0.0.1', () => {
        // do not keep the process (or the tests) alive because of this server
        server.unref();
        DecryptedLoopbackServer.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return DecryptedLoopbackServer.starting;
  }

  private static async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = (req.url || '').split('/')[1];
    const lease = DecryptedLoopbackServer.leases.get(token);
    if (!lease || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    await DecryptedFileServer.serve(req, res, lease.masterKey, lease.filePath);
  }
}
