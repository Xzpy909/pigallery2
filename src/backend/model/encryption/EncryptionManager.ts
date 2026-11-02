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
import {SupportedFormats} from '../../../common/SupportedFormats';

const LOG_TAG = '[EncryptionManager]';

/**
 * Stored in the photo folder, next to the encrypted files. Holds the random master key, encrypted
 * (AES-256-GCM) with a key that is derived (scrypt) from the password of the unlock user.
 * Nothing in it is enough to decrypt the files without that password.
 */
interface KeyMeta {
  version: 2;
  /** name of the gallery user whose login password unlocks the gallery */
  unlockUser: string;
  kdf: 'scrypt';
  /** hex */
  salt: string;
  N: number;
  r: number;
  p: number;
  /** hex: nonce (12 bytes) | encrypted master key (32 bytes) | GCM tag (16 bytes) */
  wrappedKey: string;
}

/**
 * The gallery has encrypted files, but the key is not loaded: the unlock user has not logged in since the start.
 */
export class EncryptionLockedError extends Error {
  constructor(message = 'The gallery is encrypted and locked. Log in as the unlock user to unlock it.') {
    super(message);
    this.name = 'EncryptionLockedError';
  }
}

export interface FfmpegInput {
  /** path or URL that ffmpeg / ffprobe can read */
  input: string;

  release(): void;
}

/**
 * Encryption at rest of the gallery.
 * - Everything that is read from the image folder or generated from it (thumbnails, transcoded videos...)
 *   is encrypted with a master key that only exists in memory.
 * - The gallery starts locked. The master key is unwrapped when the unlock user logs in with their password.
 * - Files are decrypted in memory, while they are sent to the client or processed.
 * - Plain (not yet encrypted) files are still readable, so a gallery can be encrypted gradually.
 * - Encryption is active if the key file (META_FILE_NAME) exists in the photo folder.
 */
export class EncryptionManager {
  public static readonly META_FILE_NAME = '.pg2-encryption.json';
  public static readonly MIN_PASSWORD_LENGTH = 8;
  private static readonly SCRYPT = {N: 1 << 15, r: 8, p: 1};
  private static meta: KeyMeta = null;
  private static masterKey: Buffer = null;

  public static get MetaFilePath(): string {
    return path.join(ProjectPath.ImageFolder, EncryptionManager.META_FILE_NAME);
  }

  /**
   * New files are written encrypted.
   */
  public static isEnabled(): boolean {
    return EncryptionManager.meta !== null;
  }

  /**
   * The gallery is encrypted, but nobody has unlocked it yet.
   */
  public static isLocked(): boolean {
    return EncryptionManager.meta !== null && EncryptionManager.masterKey === null;
  }

  /**
   * Throws EncryptionLockedError while the gallery is locked.
   * Call it before reading content, where errors would otherwise be swallowed (e.g.: files skipped by indexing),
   * so a locked gallery can not end up with an empty or incomplete index.
   */
  public static assertUnlocked(): void {
    if (EncryptionManager.isLocked()) {
      throw new EncryptionLockedError();
    }
  }

  public static getUnlockUser(): string | null {
    return EncryptionManager.meta?.unlockUser ?? null;
  }

  /**
   * Reads the key file. The gallery stays locked: the key is only available after unlock().
   */
  public static async init(): Promise<void> {
    EncryptionManager.masterKey = null;
    EncryptionManager.meta = await EncryptionManager.loadMeta();
    if (EncryptionManager.meta) {
      Logger.info(LOG_TAG, 'The gallery is encrypted. It is locked until "' + EncryptionManager.meta.unlockUser + '" logs in.');
    }
  }

  /**
   * Called after a successful login. Unlocks the gallery if the user is the unlock user.
   * Returns true if the gallery is unlocked afterwards.
   */
  public static async unlock(username: string, password: string): Promise<boolean> {
    if (EncryptionManager.meta === null || EncryptionManager.masterKey !== null) {
      return EncryptionManager.masterKey !== null;
    }
    if (username !== EncryptionManager.meta.unlockUser) {
      return false;
    }
    const key = await EncryptionManager.unwrap(EncryptionManager.meta, password);
    if (!key) {
      Logger.warn(LOG_TAG, 'The login password of "' + username + '" does not unlock the gallery. ' +
        'Was it changed outside of the app?');
      return false;
    }
    EncryptionManager.masterKey = key;
    Logger.info(LOG_TAG, 'The gallery is unlocked by "' + username + '".');
    return true;
  }

  /**
   * For the tool: loads the key of an already encrypted gallery with the password of its unlock user.
   * Returns false for a wrong password.
   */
  public static async unlockWithPassword(password: string): Promise<boolean> {
    if (EncryptionManager.meta === null) {
      throw new Error('This gallery is not encrypted yet.');
    }
    return EncryptionManager.unlock(EncryptionManager.meta.unlockUser, password);
  }

  /**
   * For the tool: starts encryption with a new random master key, locked to the password of the user.
   * Fails if the gallery already has a key file.
   */
  public static async setup(unlockUser: string, password: string): Promise<void> {
    if (!unlockUser) {
      throw new Error('A user name is needed.');
    }
    if (password.length < EncryptionManager.MIN_PASSWORD_LENGTH) {
      throw new Error('The password is the encryption key, use at least ' + EncryptionManager.MIN_PASSWORD_LENGTH + ' characters.');
    }
    const key = crypto.randomBytes(32);
    const meta = await EncryptionManager.wrap(key, unlockUser, password);
    try {
      await fsp.writeFile(EncryptionManager.MetaFilePath, JSON.stringify(meta, null, 2), {flag: 'wx'});
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(EncryptionManager.MetaFilePath + ' already exists, this gallery is already set up.');
      }
      throw new Error('Can not write ' + EncryptionManager.MetaFilePath + ' (the image folder needs write permission' +
        ' to store the key file next to the encrypted files): ' + (e as Error).message);
    }
    EncryptionManager.meta = meta;
    EncryptionManager.masterKey = key;
  }

  /**
   * The unlock user changed their password: the master key is wrapped again with the new one.
   * The key must be loaded (the user just logged in or changed it while unlocked).
   */
  public static async rewrap(newPassword: string): Promise<void> {
    if (EncryptionManager.meta === null) {
      return;
    }
    if (newPassword.length < EncryptionManager.MIN_PASSWORD_LENGTH) {
      throw new Error('The password is the encryption key of the gallery, use at least ' +
        EncryptionManager.MIN_PASSWORD_LENGTH + ' characters.');
    }
    const meta = await EncryptionManager.wrap(EncryptionManager.getKey(), EncryptionManager.meta.unlockUser, newPassword);
    const tmp = EncryptionManager.MetaFilePath + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
      await fsp.rename(tmp, EncryptionManager.MetaFilePath);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {/* ignoring errors */});
      throw e;
    }
    EncryptionManager.meta = meta;
  }

  /**
   * For the tool, after everything was decrypted: the gallery is not encrypted anymore.
   */
  public static async removeKeyFile(): Promise<void> {
    await fsp.unlink(EncryptionManager.MetaFilePath);
    EncryptionManager.meta = null;
    EncryptionManager.masterKey = null;
  }

  /**
   * For tests, that do not go through the login.
   */
  public static setKeyForTesting(key: Buffer | null, unlockUser = 'test'): void {
    EncryptionManager.masterKey = key;
    EncryptionManager.meta = key ? {version: 2, unlockUser, kdf: 'scrypt', salt: '', N: 0, r: 0, p: 0, wrappedKey: ''} : null;
  }

  /**
   * For tests: encryption is active, but the key is not loaded.
   */
  public static setLockedForTesting(unlockUser = 'test'): void {
    EncryptionManager.masterKey = null;
    EncryptionManager.meta = {version: 2, unlockUser, kdf: 'scrypt', salt: '', N: 0, r: 0, p: 0, wrappedKey: ''};
  }

  /**
   * The files of the photo folder that are encrypted: media, meta files and sidecars.
   */
  public static isTargetFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return SupportedFormats.WithDots.Photos.includes(ext) ||
      SupportedFormats.WithDots.Videos.includes(ext) ||
      SupportedFormats.WithDots.MetaFiles.includes(ext) ||
      ext === '.xmp'; // sidecars
  }

  /**
   * Thumbnails, converted videos and face thumbnails are regenerated (encrypted) on demand.
   */
  public static async deleteGeneratedFiles(): Promise<void> {
    for (const folder of [ProjectPath.TranscodedFolder, ProjectPath.FacesFolder]) {
      await fsp.rm(folder, {recursive: true, force: true});
    }
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
   * Writes the data to the file, encrypted if the gallery is encrypted.
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
      throw new EncryptionLockedError();
    }
    return EncryptionManager.masterKey;
  }

  private static deriveKek(password: string, salt: Buffer, params: { N: number, r: number, p: number }): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password.normalize('NFKC'), salt, 32,
        {N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r},
        (err, derived) => err ? reject(err) : resolve(derived));
    });
  }

  private static wrapAad(unlockUser: string): Buffer {
    return Buffer.from('pg2-wrap-v2|' + unlockUser);
  }

  private static async wrap(masterKey: Buffer, unlockUser: string, password: string): Promise<KeyMeta> {
    const salt = crypto.randomBytes(16);
    const params = EncryptionManager.SCRYPT;
    const kek = await EncryptionManager.deriveKek(password, salt, params);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce, {authTagLength: 16});
    cipher.setAAD(EncryptionManager.wrapAad(unlockUser));
    const wrapped = Buffer.concat([nonce, cipher.update(masterKey), cipher.final(), cipher.getAuthTag()]);
    return {version: 2, unlockUser, kdf: 'scrypt', salt: salt.toString('hex'), ...params, wrappedKey: wrapped.toString('hex')};
  }

  /**
   * Returns null for a wrong password (the authentication tag does not match).
   */
  private static async unwrap(meta: KeyMeta, password: string): Promise<Buffer | null> {
    const kek = await EncryptionManager.deriveKek(password, Buffer.from(meta.salt, 'hex'), meta);
    const wrapped = Buffer.from(meta.wrappedKey, 'hex');
    if (wrapped.length !== 12 + 32 + 16) {
      throw new Error('The key file ' + EncryptionManager.MetaFilePath + ' is corrupt.');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12), {authTagLength: 16});
      decipher.setAAD(EncryptionManager.wrapAad(meta.unlockUser));
      decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
      return Buffer.concat([decipher.update(wrapped.subarray(12, wrapped.length - 16)), decipher.final()]);
    } catch (e) {
      return null;
    }
  }

  private static async loadMeta(): Promise<KeyMeta | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(EncryptionManager.MetaFilePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new Error('Can not read ' + EncryptionManager.MetaFilePath + ': ' + (e as Error).message);
    }
    let meta: KeyMeta;
    try {
      meta = JSON.parse(raw);
    } catch (e) {
      throw new Error('The key file ' + EncryptionManager.MetaFilePath + ' is corrupt.');
    }
    if (meta.version !== 2 || !meta.unlockUser || !meta.wrappedKey) {
      throw new Error('The key file ' + EncryptionManager.MetaFilePath + ' is not supported by this version' +
        ' (it was made by an older, passphrase based version).');
    }
    return meta;
  }
}
