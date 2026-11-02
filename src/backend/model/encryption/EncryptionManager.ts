import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import {constants as fsConstants, createReadStream, createWriteStream, promises as fsp} from 'fs';
import {IncomingMessage, ServerResponse} from 'http';
import {Readable} from 'stream';
import {pipeline} from 'stream/promises';
import {Config} from '../../../common/config/private/Config';
import {ProjectPath} from '../../ProjectPath';
import {Logger} from '../../Logger';
import {FileCrypto} from './FileCrypto';
import {DecryptedFileServer} from './DecryptedFileServer';
import {DecryptedLoopbackServer} from './DecryptedLoopbackServer';

const LOG_TAG = '[EncryptionManager]';

interface KeyMeta {
  version: 1;
  kdf: 'scrypt' | 'raw';
  /** hex, only for scrypt */
  salt?: string;
  N?: number;
  r?: number;
  p?: number;
  /** HMAC of a constant with the key: tells if the passphrase / key is the right one */
  check: string;
}

export interface FfmpegInput {
  /** path or URL that ffmpeg / ffprobe can read */
  input: string;

  release(): void;
}

/**
 * Encryption at rest of the gallery.
 * - Everything that is read from the image folder or generated from it (thumbnails, transcoded videos...)
 *   is encrypted with a key that only exists in memory.
 * - Files are decrypted in memory, while they are sent to the client or processed.
 * - Plain (not yet encrypted) files are still readable, so a gallery can be encrypted gradually.
 */
export class EncryptionManager {
  public static readonly META_FILE_NAME = '.pg2-encryption.json';
  private static readonly KEY_CHECK_LABEL = 'pg2-key-check-v1';
  private static readonly SCRYPT = {N: 1 << 15, r: 8, p: 1};
  private static masterKey: Buffer = null;

  /**
   * New files are written encrypted.
   */
  public static isEnabled(): boolean {
    return Config.Encryption.enabled === true;
  }

  public static hasKeyMaterial(): boolean {
    return !!(Config.Encryption.passphrase || Config.Encryption.keyFile);
  }

  public static get MetaFilePath(): string {
    return path.join(ProjectPath.ImageFolder, EncryptionManager.META_FILE_NAME);
  }

  /**
   * Loads the key. Throws if encryption is enabled, but the key can not be loaded (it fails closed).
   * If encryption is disabled the key is only loaded if there is one,
   * so already encrypted files can still be viewed (and decrypted by the tool).
   */
  public static async init(): Promise<void> {
    EncryptionManager.masterKey = null;
    const meta = await EncryptionManager.loadMeta();
    if (!EncryptionManager.isEnabled() && (!EncryptionManager.hasKeyMaterial() || !meta)) {
      // nothing was encrypted yet, or the key is not given: it is only a problem when an encrypted file is found
      return;
    }
    if (!EncryptionManager.hasKeyMaterial()) {
      throw new Error('Encryption is enabled, but there is no passphrase or key file set. ' +
        'Set Encryption.passphrase (or the PG2_ENCRYPTION_PASSPHRASE environment variable) or Encryption.keyFile.');
    }

    const {key, meta: usedMeta} = await EncryptionManager.deriveMasterKey(meta);
    const check = EncryptionManager.keyCheck(key);
    if (meta) {
      if (!EncryptionManager.safeEqualHex(meta.check, check)) {
        throw new Error('The encryption passphrase / key file does not match the one used to encrypt this gallery (' +
          EncryptionManager.MetaFilePath + '). Refusing to start to avoid encrypting files with an other key.');
      }
    } else {
      usedMeta.check = check;
      await EncryptionManager.saveMeta(usedMeta, key);
    }
    EncryptionManager.masterKey = key;
    Logger.info(LOG_TAG, 'Encryption key loaded. New files are encrypted: ' + EncryptionManager.isEnabled());
  }

  /**
   * For tools and tests, that do not start the full server.
   */
  public static setKeyForTesting(key: Buffer | null): void {
    EncryptionManager.masterKey = key;
  }

  public static async isEncrypted(filePath: string): Promise<boolean> {
    try {
      return await FileCrypto.isEncryptedFile(filePath);
    } catch (e) {
      // missing or not readable: the normal file handling reports it
      return false;
    }
  }

  /**
   * Size of the content, not the size of the file on the disk.
   */
  public static async getPlainSize(filePath: string): Promise<number> {
    const stat = await fsp.stat(filePath);
    if (await EncryptionManager.isEncrypted(filePath)) {
      return FileCrypto.plainSizeFromEncryptedSize(stat.size);
    }
    return stat.size;
  }

  public static async readFile(filePath: string): Promise<Buffer> {
    if (await EncryptionManager.isEncrypted(filePath)) {
      return FileCrypto.decryptToBuffer(EncryptionManager.getKey(), filePath);
    }
    return fsp.readFile(filePath);
  }

  /**
   * Libraries like sharp, exifr or image-size can read a path or a buffer.
   * A plain file is read by path, an encrypted one is decrypted in memory.
   */
  public static async getImageSource(filePath: string): Promise<string | Buffer> {
    if (await EncryptionManager.isEncrypted(filePath)) {
      return FileCrypto.decryptToBuffer(EncryptionManager.getKey(), filePath);
    }
    return filePath;
  }

  /**
   * Writes the data to the file, encrypted if encryption is enabled.
   */
  public static async writeFile(filePath: string, data: Buffer | string): Promise<void> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (EncryptionManager.isEnabled()) {
      return FileCrypto.encryptToFile(EncryptionManager.getKey(), filePath, buf);
    }
    await fsp.writeFile(filePath, buf);
  }

  /**
   * Replaces a plain file with its encrypted version (same name, same modification time).
   * The encrypted copy is decrypted again and compared with the original before it replaces it,
   * so a bug or a full disk can not destroy a photo.
   * Returns false if it was already encrypted.
   */
  public static async encryptFile(filePath: string): Promise<boolean> {
    if (await EncryptionManager.isEncrypted(filePath)) {
      return false;
    }
    const key = EncryptionManager.getKey();
    const stat = await fsp.stat(filePath);
    const stagePath = filePath + '.pg2enc';
    const plainDigest = crypto.createHash('sha256');
    const hashedSource = Readable.from((async function* (): AsyncGenerator<Buffer> {
      for await (const chunk of createReadStream(filePath)) {
        plainDigest.update(chunk);
        yield chunk as Buffer;
      }
    })());

    try {
      await FileCrypto.encryptToFile(key, stagePath, hashedSource, stat.mtime);
      const decryptedDigest = crypto.createHash('sha256');
      for await (const part of FileCrypto.decryptRange(key, stagePath)) {
        decryptedDigest.update(part);
      }
      if (plainDigest.digest('hex') !== decryptedDigest.digest('hex')) {
        throw new Error('Verification of the encrypted copy failed, the original is left untouched: ' + filePath);
      }
      await fsp.rename(stagePath, filePath);
    } catch (e) {
      await fsp.unlink(stagePath).catch(() => {/* ignoring errors */});
      throw e;
    }
    return true;
  }

  /**
   * Replaces an encrypted file with its plain version. Returns false if it was not encrypted.
   */
  public static async decryptFile(filePath: string): Promise<boolean> {
    if (!(await EncryptionManager.isEncrypted(filePath))) {
      return false;
    }
    const stat = await fsp.stat(filePath);
    const tmpPath = filePath + '.dec-' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      await pipeline(FileCrypto.createDecryptStream(EncryptionManager.getKey(), filePath), createWriteStream(tmpPath));
      await fsp.utimes(tmpPath, stat.mtime, stat.mtime);
      await fsp.rename(tmpPath, filePath);
    } catch (e) {
      await fsp.unlink(tmpPath).catch(() => {/* ignoring errors */});
      throw e;
    }
    return true;
  }

  /**
   * Encrypts the content of a plain file (e.g.: ffmpeg output) into an other file.
   */
  public static async encryptFileTo(plainFilePath: string, destPath: string): Promise<void> {
    await FileCrypto.encryptToFile(EncryptionManager.getKey(), destPath, createReadStream(plainFilePath));
  }

  public static createReadStream(filePath: string, start?: number, end?: number): Readable {
    return FileCrypto.createDecryptStream(EncryptionManager.getKey(), filePath, start, end);
  }

  public static async serve(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
    return DecryptedFileServer.serve(req, res, EncryptionManager.getKey(), filePath);
  }

  /**
   * ffmpeg / ffprobe can not read buffers. Encrypted files are served for them on a loopback URL,
   * so there is no decrypted copy on the disk. Release it when ffmpeg is done.
   */
  public static async getFfmpegInput(filePath: string): Promise<FfmpegInput> {
    if (await EncryptionManager.isEncrypted(filePath)) {
      const lease = await DecryptedLoopbackServer.lease(filePath, EncryptionManager.getKey());
      return {input: lease.url, release: lease.release};
    }
    return {
      input: filePath, release: (): void => {/* nothing to release */
      }
    };
  }

  /**
   * Path for plain files that are needed temporarily (e.g.: ffmpeg output before it is encrypted).
   */
  public static async getScratchPath(extension = '.part'): Promise<string> {
    const dir = Config.Encryption.scratchFolder ?
      ProjectPath.getAbsolutePath(Config.Encryption.scratchFolder) : os.tmpdir();
    await fsp.mkdir(dir, {recursive: true});
    return path.join(dir, 'pg2-' + crypto.randomBytes(8).toString('hex') + extension);
  }

  /**
   * Overwrites the file before deleting it. Best effort, as SSDs and journaling file systems may keep old copies.
   */
  public static async shred(filePath: string): Promise<void> {
    try {
      const stat = await fsp.stat(filePath);
      const fh = await fsp.open(filePath, fsConstants.O_WRONLY);
      try {
        const zeros = Buffer.alloc(1024 * 1024);
        for (let pos = 0; pos < stat.size; pos += zeros.length) {
          await fh.write(zeros, 0, Math.min(zeros.length, stat.size - pos), pos);
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (e) {
      // not existing or not writable, deleting is what matters
    }
    await fsp.unlink(filePath).catch(() => {/* ignoring errors */});
  }

  private static getKey(): Buffer {
    if (!EncryptionManager.masterKey) {
      throw new Error('The gallery has encrypted files, but there is no encryption key loaded. ' +
        'Set Encryption.passphrase (or the PG2_ENCRYPTION_PASSPHRASE environment variable) or Encryption.keyFile and restart.');
    }
    return EncryptionManager.masterKey;
  }

  private static async deriveMasterKey(meta: KeyMeta | null): Promise<{ key: Buffer, meta: KeyMeta }> {
    let secret = Config.Encryption.passphrase;
    if (Config.Encryption.keyFile) {
      const raw = await fsp.readFile(ProjectPath.getAbsolutePath(Config.Encryption.keyFile));
      const text = raw.toString('utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(text)) {
        if (meta && meta.kdf !== 'raw') {
          throw new Error('The gallery was encrypted with a passphrase, but a raw key file is configured.');
        }
        return {key: Buffer.from(text, 'hex'), meta: {version: 1, kdf: 'raw', check: ''}};
      }
      secret = text;
    }
    if (!secret) {
      throw new Error('The encryption key file is empty.');
    }
    if (meta && meta.kdf !== 'scrypt') {
      throw new Error('The gallery was encrypted with a raw key, but a passphrase is configured.');
    }
    const params = meta ? {N: meta.N, r: meta.r, p: meta.p} : EncryptionManager.SCRYPT;
    const salt = meta ? Buffer.from(meta.salt, 'hex') : crypto.randomBytes(16);
    const key = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(secret.normalize('NFKC'), salt, 32,
        {...params, maxmem: 256 * params.N * params.r},
        (err, derived) => err ? reject(err) : resolve(derived));
    });
    return {key, meta: {version: 1, kdf: 'scrypt', salt: salt.toString('hex'), ...params, check: ''}};
  }

  private static keyCheck(key: Buffer): string {
    return crypto.createHmac('sha256', key).update(EncryptionManager.KEY_CHECK_LABEL).digest('hex');
  }

  private static safeEqualHex(a: string, b: string): boolean {
    const ba = Buffer.from(a || '', 'hex');
    const bb = Buffer.from(b || '', 'hex');
    return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
  }

  private static async loadMeta(): Promise<KeyMeta | null> {
    try {
      return JSON.parse(await fsp.readFile(EncryptionManager.MetaFilePath, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new Error('Can not read ' + EncryptionManager.MetaFilePath + ': ' + (e as Error).message);
    }
  }

  /**
   * The salt must stay with the encrypted files (not in the temp folder or config that can be wiped),
   * otherwise the files could not be decrypted even with the right passphrase.
   */
  private static async saveMeta(meta: KeyMeta, key: Buffer): Promise<void> {
    try {
      await fsp.writeFile(EncryptionManager.MetaFilePath, JSON.stringify(meta, null, 2), {flag: 'wx'});
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // an other process was faster, it must have used the same key
        const existing = await EncryptionManager.loadMeta();
        if (existing && EncryptionManager.safeEqualHex(existing.check, EncryptionManager.keyCheck(key))) {
          return;
        }
        throw new Error('The encryption passphrase / key file does not match ' + EncryptionManager.MetaFilePath);
      }
      throw new Error('Can not write ' + EncryptionManager.MetaFilePath + ' (the image folder needs write permission' +
        ' to store the salt next to the encrypted files): ' + (e as Error).message);
    }
  }
}
