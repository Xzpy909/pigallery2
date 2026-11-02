/* eslint-disable no-unused-expressions,@typescript-eslint/no-unused-expressions */
import {expect} from 'chai';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {Readable} from 'stream';
import {pipeline} from 'stream/promises';
import {AddressInfo} from 'net';
import {CHUNK_SIZE, FileCrypto, HEADER_SIZE, TAG_SIZE} from '../../../../../src/backend/model/encryption/FileCrypto';
import {DecryptedFileServer} from '../../../../../src/backend/model/encryption/DecryptedFileServer';
import {TestHelper} from '../../../../TestHelper';

const CHUNK_STRIDE = CHUNK_SIZE + TAG_SIZE;

const rejects = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('Expected the promise to reject');
};

describe('FileCrypto', () => {
  before(TestHelper.resetConfig);

  const key = crypto.randomBytes(32);
  let dir: string;
  let counter = 0;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pg2-crypto-'));
  });
  after(async () => {
    await fs.promises.rm(dir, {recursive: true, force: true});
  });

  const newPath = (): string => path.join(dir, 'file' + (counter++));
  const encrypted = async (plain: Buffer): Promise<string> => {
    const p = newPath();
    await FileCrypto.encryptToFile(key, p, plain);
    return p;
  };

  describe('round trip', () => {
    const sizes = [0, 1, 15, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE + 17];

    for (const size of sizes) {
      it('should encrypt and decrypt a buffer of ' + size + ' bytes', async () => {
        const plain = crypto.randomBytes(size);
        const p = await encrypted(plain);

        expect(await FileCrypto.isEncryptedFile(p)).to.be.true;
        const stat = await fs.promises.stat(p);
        expect(FileCrypto.plainSizeFromEncryptedSize(stat.size)).to.equal(size);
        expect((await FileCrypto.decryptToBuffer(key, p)).equals(plain)).to.be.true;
      });

      it('should encrypt a stream of ' + size + ' bytes the same way as a buffer', async () => {
        const plain = crypto.randomBytes(size);
        const pieces: Buffer[] = [];
        for (let i = 0; i < plain.length; i += 7001) { // odd pieces, that do not match the chunk size
          pieces.push(plain.subarray(i, i + 7001));
        }
        const p = newPath();
        await FileCrypto.encryptToFile(key, p, Readable.from(pieces));

        const stat = await fs.promises.stat(p);
        expect(stat.size).to.equal((await fs.promises.stat(await encrypted(plain))).size);
        expect((await FileCrypto.decryptToBuffer(key, p)).equals(plain)).to.be.true;
      });
    }

    it('should not leave the plain content in the encrypted file', async () => {
      const plain = Buffer.from('this is a very recognizable plain text '.repeat(200));
      const raw = await fs.promises.readFile(await encrypted(plain));
      expect(raw.includes(Buffer.from('recognizable'))).to.be.false;
    });

    it('should produce different ciphertext for the same content (new key per file)', async () => {
      const plain = crypto.randomBytes(1000);
      const a = await fs.promises.readFile(await encrypted(plain));
      const b = await fs.promises.readFile(await encrypted(plain));
      expect(a.equals(b)).to.be.false;
    });

    it('should not recognise plain files as encrypted', async () => {
      const p = newPath();
      await fs.promises.writeFile(p, 'plain content');
      expect(await FileCrypto.isEncryptedFile(p)).to.be.false;
      const empty = newPath();
      await fs.promises.writeFile(empty, '');
      expect(await FileCrypto.isEncryptedFile(empty)).to.be.false;
    });

    it('should leave no temp file when the source fails', async () => {
      const p = newPath();
      const failing = new Readable({
        read(): void {
          this.destroy(new Error('read error'));
        }
      });
      await rejects(FileCrypto.encryptToFile(key, p, failing));
      expect(fs.existsSync(p)).to.be.false;
      expect((await fs.promises.readdir(dir)).filter(f => f.startsWith(path.basename(p)))).to.deep.equal([]);
    });
  });

  describe('range decrypt', () => {
    const size = 5 * CHUNK_SIZE + 123;
    const plain = crypto.randomBytes(size);
    let p: string;

    before(async () => {
      p = await encrypted(plain);
    });

    const ranges: [number, number][] = [
      [0, 0], [0, CHUNK_SIZE - 1], [CHUNK_SIZE - 1, CHUNK_SIZE], [CHUNK_SIZE, 2 * CHUNK_SIZE - 1],
      [100, 3 * CHUNK_SIZE + 5], [size - 1, size - 1], [5 * CHUNK_SIZE, size - 1], [10, 10]
    ];
    for (const [start, end] of ranges) {
      it('should decrypt bytes ' + start + '-' + end, async () => {
        const parts: Buffer[] = [];
        for await (const c of FileCrypto.decryptRange(key, p, start, end)) {
          parts.push(c);
        }
        expect(Buffer.concat(parts).equals(plain.subarray(start, end + 1))).to.be.true;
      });
    }

    it('should decrypt random ranges', async () => {
      for (let i = 0; i < 30; ++i) {
        const start = crypto.randomInt(0, size);
        const end = crypto.randomInt(start, size);
        const part = Buffer.concat(await collect(FileCrypto.decryptRange(key, p, start, end)));
        expect(part.equals(plain.subarray(start, end + 1))).to.be.true;
      }
    });

    it('should clamp the end of the range to the file size', async () => {
      const part = Buffer.concat(await collect(FileCrypto.decryptRange(key, p, size - 5)));
      expect(part.equals(plain.subarray(size - 5))).to.be.true;
    });

    it('should return nothing if the range starts after the end', async () => {
      expect(Buffer.concat(await collect(FileCrypto.decryptRange(key, p, size + 10))).length).to.equal(0);
    });

    it('should work as a stream', async () => {
      const chunks: Buffer[] = [];
      for await (const c of FileCrypto.createDecryptStream(key, p, 10, 20)) {
        chunks.push(c as Buffer);
      }
      expect(Buffer.concat(chunks).equals(plain.subarray(10, 21))).to.be.true;
    });
  });

  describe('tampering', () => {
    const size = 3 * CHUNK_SIZE + 10; // 3 full chunks and a final one
    const plain = crypto.randomBytes(size);

    const tampered = async (change: (raw: Buffer) => Buffer): Promise<string> => {
      const raw = await fs.promises.readFile(await encrypted(plain));
      const p = newPath();
      await fs.promises.writeFile(p, change(raw));
      return p;
    };

    it('should reject a wrong key', async () => {
      const p = await encrypted(plain);
      await rejects(FileCrypto.decryptToBuffer(crypto.randomBytes(32), p));
    });

    it('should reject a changed ciphertext byte', async () => {
      const p = await tampered(raw => {
        raw[HEADER_SIZE + CHUNK_STRIDE + 100] ^= 1;
        return raw;
      });
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should only fail for the chunk that was changed', async () => {
      const p = await tampered(raw => {
        raw[HEADER_SIZE + CHUNK_STRIDE + 100] ^= 1; // second chunk
        return raw;
      });
      // the first chunk is still fine, so a video can start playing before the broken part
      const first = Buffer.concat(await collect(FileCrypto.decryptRange(key, p, 0, 99)));
      expect(first.equals(plain.subarray(0, 100))).to.be.true;
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject a changed tag', async () => {
      const p = await tampered(raw => {
        raw[raw.length - 1] ^= 1;
        return raw;
      });
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject a changed header (salt)', async () => {
      const p = await tampered(raw => {
        raw[HEADER_SIZE - 1] ^= 1;
        return raw;
      });
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject a file that lost its last (partial) chunk', async () => {
      const p = await tampered(raw => raw.subarray(0, HEADER_SIZE + 3 * CHUNK_STRIDE));
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject a file that lost a full chunk at the end', async () => {
      const p = await tampered(raw => Buffer.concat([
        raw.subarray(0, HEADER_SIZE + 2 * CHUNK_STRIDE),
        raw.subarray(HEADER_SIZE + 3 * CHUNK_STRIDE)]));
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject swapped chunks', async () => {
      const p = await tampered(raw => {
        const c0 = Buffer.from(raw.subarray(HEADER_SIZE, HEADER_SIZE + CHUNK_STRIDE));
        const c1 = Buffer.from(raw.subarray(HEADER_SIZE + CHUNK_STRIDE, HEADER_SIZE + 2 * CHUNK_STRIDE));
        c1.copy(raw, HEADER_SIZE);
        c0.copy(raw, HEADER_SIZE + CHUNK_STRIDE);
        return raw;
      });
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject a truncated header or body', async () => {
      await rejects(FileCrypto.decryptToBuffer(key, await tampered(raw => raw.subarray(0, 10))));
      await rejects(FileCrypto.decryptToBuffer(key, await tampered(raw => raw.subarray(0, HEADER_SIZE + 5))));
    });

    it('should reject an unsupported version', async () => {
      const p = await tampered(raw => {
        raw[4] = 99;
        return raw;
      });
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });

    it('should reject a file that is not encrypted', async () => {
      const p = newPath();
      await fs.promises.writeFile(p, 'plain');
      await rejects(FileCrypto.decryptToBuffer(key, p));
    });
  });

  describe('HTTP serving', () => {
    const size = 3 * CHUNK_SIZE + 321;
    const plain = crypto.randomBytes(size);
    let p: string;
    let server: http.Server;
    let port: number;

    before(async () => {
      p = await encrypted(plain);
      server = http.createServer((req, res) => {
        DecryptedFileServer.serve(req, res, key, p).catch(() => {
          res.statusCode = 500;
          res.end();
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    after(() => {
      server.close();
    });

    const request = (headers: http.OutgoingHttpHeaders = {}, method = 'GET'):
      Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer }> => {
      return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, method, headers}, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
        });
        req.on('error', reject);
        req.end();
      });
    };

    it('should send the whole decrypted file', async () => {
      const r = await request();
      expect(r.status).to.equal(200);
      expect(r.headers['content-length']).to.equal('' + size);
      expect(r.headers['accept-ranges']).to.equal('bytes');
      expect(r.body.equals(plain)).to.be.true;
    });

    it('should send a byte range', async () => {
      const start = CHUNK_SIZE - 10;
      const end = 2 * CHUNK_SIZE + 10;
      const r = await request({range: 'bytes=' + start + '-' + end});
      expect(r.status).to.equal(206);
      expect(r.headers['content-range']).to.equal('bytes ' + start + '-' + end + '/' + size);
      expect(r.headers['content-length']).to.equal('' + (end - start + 1));
      expect(r.body.equals(plain.subarray(start, end + 1))).to.be.true;
    });

    it('should send an open ended range', async () => {
      const r = await request({range: 'bytes=' + (size - 100) + '-'});
      expect(r.status).to.equal(206);
      expect(r.body.equals(plain.subarray(size - 100))).to.be.true;
    });

    it('should send the last N bytes', async () => {
      const r = await request({range: 'bytes=-50'});
      expect(r.status).to.equal(206);
      expect(r.headers['content-range']).to.equal('bytes ' + (size - 50) + '-' + (size - 1) + '/' + size);
      expect(r.body.equals(plain.subarray(size - 50))).to.be.true;
    });

    it('should reject a range that is outside of the file', async () => {
      const r = await request({range: 'bytes=' + size + '-'});
      expect(r.status).to.equal(416);
      expect(r.headers['content-range']).to.equal('bytes */' + size);
    });

    it('should send everything if the range is not valid or not supported', async () => {
      for (const range of ['bytes=abc', 'bytes=10-5', 'items=1-2', 'bytes=0-1,5-6']) {
        const r = await request({range});
        expect(r.status, range).to.equal(200);
        expect(r.body.equals(plain), range).to.be.true;
      }
    });

    it('should answer HEAD without a body', async () => {
      const r = await request({}, 'HEAD');
      expect(r.status).to.equal(200);
      expect(r.headers['content-length']).to.equal('' + size);
      expect(r.body.length).to.equal(0);
    });

    it('should answer 304 if the client has the current version', async () => {
      const first = await request();
      const byEtag = await request({'if-none-match': first.headers['etag']});
      expect(byEtag.status).to.equal(304);
      expect(byEtag.body.length).to.equal(0);
      const byDate = await request({'if-modified-since': first.headers['last-modified']});
      expect(byDate.status).to.equal(304);
      const other = await request({'if-none-match': 'W/"something-else"'});
      expect(other.status).to.equal(200);
    });

    it('should ignore the range if If-Range does not match', async () => {
      const first = await request();
      const stale = await request({range: 'bytes=0-9', 'if-range': 'W/"old"'});
      expect(stale.status).to.equal(200);
      expect(stale.body.length).to.equal(size);
      const current = await request({range: 'bytes=0-9', 'if-range': first.headers['last-modified']});
      expect(current.status).to.equal(206);
      expect(current.body.equals(plain.subarray(0, 10))).to.be.true;
    });

    it('should not send decrypted bytes of a corrupt file', async () => {
      const raw = await fs.promises.readFile(p);
      const bad = newPath();
      raw[HEADER_SIZE + 50] ^= 1;
      await fs.promises.writeFile(bad, raw);
      const badServer = http.createServer((req, res) => {
        DecryptedFileServer.serve(req, res, key, bad).catch(() => {
          res.statusCode = 500;
          res.end();
        });
      });
      await new Promise<void>(resolve => badServer.listen(0, '127.0.0.1', resolve));
      try {
        const badPort = (badServer.address() as AddressInfo).port;
        const received = await new Promise<number>((resolve) => {
          let bytes = 0;
          http.get({host: '127.0.0.1', port: badPort}, (res) => {
            res.on('data', (c: Buffer) => bytes += c.length);
            res.on('end', () => resolve(bytes));
            res.on('error', () => resolve(bytes));
            res.on('aborted', () => resolve(bytes));
          }).on('error', () => resolve(bytes));
        });
        // the first chunk is broken, so no plain byte may arrive
        expect(received).to.equal(0);
      } finally {
        badServer.close();
      }
    });

    it('should pipe to any writable', async () => {
      const out: Buffer[] = [];
      await pipeline(FileCrypto.createDecryptStream(key, p), new (require('stream').Writable)({
        write(chunk: Buffer, enc: string, cb: () => void): void {
          out.push(chunk);
          cb();
        }
      }));
      expect(Buffer.concat(out).equals(plain)).to.be.true;
    });
  });
});

async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  for await (const c of gen) {
    parts.push(c);
  }
  return parts;
}
