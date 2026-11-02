import * as crypto from 'crypto';
import {createWriteStream, promises as fsp} from 'fs';
import {FileHandle} from 'fs/promises';
import {Readable, Transform, TransformCallback} from 'stream';
import {pipeline} from 'stream/promises';

/**
 * Encrypted file format (v1), chunked AES-256-GCM:
 *
 *   header (24 bytes): 'PG2E' | version (1) | chunkSizeLog2 (1) | reserved (2) | fileSalt (16)
 *   body: N chunks, each = ciphertext (up to CHUNK_SIZE bytes) | GCM tag (16 bytes)
 *
 * - The file key is derived from the master key with HKDF-SHA256 (salt = fileSalt),
 *   so every file is encrypted with its own key.
 * - The GCM nonce of a chunk is its index, the AAD is the header + a "final chunk" flag.
 *   Reordering, swapping or truncating chunks makes the authentication fail.
 * - Every chunk is authenticated on its own, so any byte range can be decrypted
 *   without reading the whole file (needed for video seeking / HTTP range requests).
 * - The plain size is not stored, it is derived from the file size.
 * - All chunks are CHUNK_SIZE long, except the last one (1..CHUNK_SIZE bytes, 0 for an empty file).
 */
export const MAGIC = Buffer.from('PG2E');
export const FORMAT_VERSION = 1;
export const CHUNK_SIZE_LOG2 = 16;
export const CHUNK_SIZE = 1 << CHUNK_SIZE_LOG2; // 64 KiB
export const TAG_SIZE = 16;
const SALT_SIZE = 16;
export const HEADER_SIZE = MAGIC.length + 1 + 1 + 2 + SALT_SIZE; // 24
const CHUNK_STRIDE = CHUNK_SIZE + TAG_SIZE;
const HKDF_INFO = 'pg2-file-v1';
const MAX_CHUNKS = 0xFFFFFFFF;

export interface EncryptedFileInfo {
  header: Buffer;
  /** size of the decrypted content in bytes */
  plainSize: number;
  chunkCount: number;
  /** size of the last (final) encrypted chunk, tag included */
  lastChunkEncSize: number;
}

export class FileCrypto {

  /**
   * Plain size from the size of an encrypted file. Throws if the size can't belong to a valid encrypted file.
   */
  public static plainSizeFromEncryptedSize(encSize: number): number {
    return FileCrypto.layout(encSize).plainSize;
  }

  private static layout(encSize: number): { plainSize: number, chunkCount: number, lastChunkEncSize: number } {
    const body = encSize - HEADER_SIZE;
    if (body < TAG_SIZE) {
      throw new Error('Encrypted file is truncated or corrupt');
    }
    const chunkCount = Math.ceil(body / CHUNK_STRIDE);
    const lastChunkEncSize = body - (chunkCount - 1) * CHUNK_STRIDE;
    if (lastChunkEncSize < TAG_SIZE) {
      throw new Error('Encrypted file is truncated or corrupt');
    }
    return {
      plainSize: (chunkCount - 1) * CHUNK_SIZE + (lastChunkEncSize - TAG_SIZE),
      chunkCount,
      lastChunkEncSize
    };
  }

  public static hasMagic(firstBytes: Buffer): boolean {
    return firstBytes.length >= MAGIC.length && firstBytes.subarray(0, MAGIC.length).equals(MAGIC);
  }

  /**
   * Tells if the file is encrypted by looking at the first bytes only.
   */
  public static async isEncryptedFile(filePath: string): Promise<boolean> {
    let fh: FileHandle;
    try {
      fh = await fsp.open(filePath, 'r');
      const buf = Buffer.alloc(MAGIC.length);
      const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
      return bytesRead === MAGIC.length && FileCrypto.hasMagic(buf);
    } finally {
      await fh?.close();
    }
  }

  /**
   * Reads and validates the header. Returns null if the file is not encrypted.
   */
  public static async readInfo(fh: FileHandle): Promise<EncryptedFileInfo | null> {
    const header = Buffer.alloc(HEADER_SIZE);
    const {bytesRead} = await fh.read(header, 0, HEADER_SIZE, 0);
    if (bytesRead < MAGIC.length || !FileCrypto.hasMagic(header)) {
      return null;
    }
    if (bytesRead < HEADER_SIZE) {
      throw new Error('Encrypted file header is truncated');
    }
    if (header[MAGIC.length] !== FORMAT_VERSION) {
      throw new Error('Unsupported encrypted file version: ' + header[MAGIC.length]);
    }
    if (header[MAGIC.length + 1] !== CHUNK_SIZE_LOG2) {
      throw new Error('Unsupported encrypted chunk size: 2^' + header[MAGIC.length + 1]);
    }
    const stat = await fh.stat();
    return {header, ...FileCrypto.layout(stat.size)};
  }

  /**
   * Decrypts a byte range of the plain content. Both start and end are inclusive.
   * Each chunk is verified before its bytes are returned, a failed check throws.
   */
  public static async* decryptRange(
    masterKey: Buffer,
    filePath: string,
    start = 0,
    end = Number.MAX_SAFE_INTEGER
  ): AsyncGenerator<Buffer> {
    const fh = await fsp.open(filePath, 'r');
    try {
      const info = await FileCrypto.readInfo(fh);
      if (!info) {
        throw new Error('File is not encrypted: ' + filePath);
      }
      end = Math.min(end, info.plainSize - 1);
      const fileKey = FileCrypto.deriveFileKey(masterKey, info.header);
      const firstChunk = Math.floor(start / CHUNK_SIZE);
      // an empty file has a single empty chunk that is still verified
      const lastChunk = info.plainSize === 0 ? 0 : Math.floor(end / CHUNK_SIZE);
      if (info.plainSize > 0 && start > end) {
        return;
      }

      for (let i = firstChunk; i <= lastChunk; ++i) {
        const isFinal = i === info.chunkCount - 1;
        const encLen = isFinal ? info.lastChunkEncSize : CHUNK_STRIDE;
        const enc = Buffer.allocUnsafe(encLen);
        await FileCrypto.readExactly(fh, enc, HEADER_SIZE + i * CHUNK_STRIDE);

        const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, FileCrypto.nonce(i), {authTagLength: TAG_SIZE});
        decipher.setAAD(FileCrypto.aad(info.header, isFinal));
        decipher.setAuthTag(enc.subarray(encLen - TAG_SIZE));
        const plain = Buffer.concat([decipher.update(enc.subarray(0, encLen - TAG_SIZE)), decipher.final()]);

        const from = i === firstChunk ? start - i * CHUNK_SIZE : 0;
        const to = i === lastChunk ? end - i * CHUNK_SIZE + 1 : plain.length;
        if (to > from) {
          yield plain.subarray(from, to);
        }
      }
    } finally {
      await fh.close();
    }
  }

  public static createDecryptStream(masterKey: Buffer, filePath: string, start = 0, end = Number.MAX_SAFE_INTEGER): Readable {
    return Readable.from(FileCrypto.decryptRange(masterKey, filePath, start, end), {objectMode: false});
  }

  public static async decryptToBuffer(masterKey: Buffer, filePath: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of FileCrypto.decryptRange(masterKey, filePath)) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  }

  public static encryptBuffer(masterKey: Buffer, plain: Buffer): Buffer {
    const sealer = new ChunkSealer(masterKey);
    const parts: Buffer[] = [sealer.header];
    const chunkCount = Math.max(1, Math.ceil(plain.length / CHUNK_SIZE));
    for (let i = 0; i < chunkCount; ++i) {
      parts.push(sealer.seal(plain.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), i === chunkCount - 1));
    }
    return Buffer.concat(parts);
  }

  public static createEncryptTransform(masterKey: Buffer): Transform {
    return new EncryptTransform(masterKey);
  }

  /**
   * Encrypts the content into destPath. The destination only appears when it is complete.
   */
  public static async encryptToFile(
    masterKey: Buffer,
    destPath: string,
    source: Buffer | Readable,
    mtime?: Date
  ): Promise<void> {
    const tmpPath = destPath + '.enc-' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      if (Buffer.isBuffer(source)) {
        await fsp.writeFile(tmpPath, FileCrypto.encryptBuffer(masterKey, source));
      } else {
        await pipeline(source, FileCrypto.createEncryptTransform(masterKey), createWriteStream(tmpPath));
      }
      if (mtime) {
        await fsp.utimes(tmpPath, mtime, mtime);
      }
      await fsp.rename(tmpPath, destPath);
    } catch (e) {
      await fsp.unlink(tmpPath).catch(() => {/* ignoring errors */});
      throw e;
    }
  }

  public static deriveFileKey(masterKey: Buffer, header: Buffer): Buffer {
    const salt = header.subarray(HEADER_SIZE - SALT_SIZE, HEADER_SIZE);
    return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, HKDF_INFO, 32));
  }

  public static nonce(chunkIndex: number): Buffer {
    if (chunkIndex >= MAX_CHUNKS) {
      throw new Error('File is too big to encrypt');
    }
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(chunkIndex, 8);
    return nonce;
  }

  public static aad(header: Buffer, isFinal: boolean): Buffer {
    return Buffer.concat([header, Buffer.from([isFinal ? 1 : 0])]);
  }

  private static async readExactly(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
    let offset = 0;
    while (offset < buf.length) {
      const {bytesRead} = await fh.read(buf, offset, buf.length - offset, position + offset);
      if (bytesRead === 0) {
        throw new Error('Encrypted file is truncated or corrupt');
      }
      offset += bytesRead;
    }
  }
}

/**
 * Creates the header of a new file (random salt, so a new file key) and seals chunks one by one.
 */
class ChunkSealer {
  public readonly header: Buffer;
  private readonly fileKey: Buffer;
  private index = 0;

  constructor(masterKey: Buffer) {
    this.header = Buffer.concat([
      MAGIC,
      Buffer.from([FORMAT_VERSION, CHUNK_SIZE_LOG2, 0, 0]),
      crypto.randomBytes(SALT_SIZE)
    ]);
    this.fileKey = FileCrypto.deriveFileKey(masterKey, this.header);
  }

  public seal(plain: Buffer, isFinal: boolean): Buffer {
    const cipher = crypto.createCipheriv('aes-256-gcm', this.fileKey, FileCrypto.nonce(this.index++), {authTagLength: TAG_SIZE});
    cipher.setAAD(FileCrypto.aad(this.header, isFinal));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
}

class EncryptTransform extends Transform {
  private readonly sealer: ChunkSealer;
  private headerSent = false;
  private pending: Buffer = Buffer.alloc(0);

  constructor(masterKey: Buffer) {
    super();
    this.sealer = new ChunkSealer(masterKey);
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.sendHeader();
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
      // a chunk is only sealed as non final if there is more data after it,
      // so the last chunk is always the one that is sealed in _flush
      while (this.pending.length > CHUNK_SIZE) {
        this.push(this.sealer.seal(this.pending.subarray(0, CHUNK_SIZE), false));
        this.pending = this.pending.subarray(CHUNK_SIZE);
      }
      callback();
    } catch (e) {
      callback(e);
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      this.sendHeader();
      this.push(this.sealer.seal(this.pending, true));
      this.pending = Buffer.alloc(0);
      callback();
    } catch (e) {
      callback(e);
    }
  }

  private sendHeader(): void {
    if (!this.headerSent) {
      this.push(this.sealer.header);
      this.headerSent = true;
    }
  }
}
