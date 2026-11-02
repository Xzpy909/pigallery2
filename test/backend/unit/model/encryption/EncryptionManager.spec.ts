/* eslint-disable no-unused-expressions,@typescript-eslint/no-unused-expressions */
import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import {Config} from '../../../../../src/common/config/private/Config';
import {ProjectPath} from '../../../../../src/backend/ProjectPath';
import {EncryptionLockedError, EncryptionManager} from '../../../../../src/backend/model/encryption/EncryptionManager';
import {MetadataLoader} from '../../../../../src/backend/model/fileaccess/MetadataLoader';
import {PhotoProcessing} from '../../../../../src/backend/model/fileaccess/fileprocessing/PhotoProcessing';
import {VideoConverterWorker} from '../../../../../src/backend/model/fileaccess/VideoConverterWorker';
import {ImageRendererFactory, ThumbnailSourceType, VideoRendererFactory} from '../../../../../src/backend/model/fileaccess/PhotoWorker';
import {GPXProcessing} from '../../../../../src/backend/model/fileaccess/fileprocessing/GPXProcessing';
import {TestHelper} from '../../../../TestHelper';

const ASSETS = path.join(__dirname, '../../../assets');

const rejects = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('Expected the promise to reject');
};

describe('EncryptionManager', () => {
  before(TestHelper.resetConfig);

  let root: string;
  let images: string;

  const setup = async (): Promise<void> => {
    TestHelper.resetConfig();
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pg2-enc-'));
    images = path.join(root, 'images');
    await fs.promises.mkdir(images);
    ProjectPath.ImageFolder = images;
    ProjectPath.TempFolder = path.join(root, 'tmp');
    ProjectPath.TranscodedFolder = path.join(ProjectPath.TempFolder, 'tc');
    ProjectPath.FacesFolder = path.join(ProjectPath.TempFolder, 'f');
    await fs.promises.mkdir(ProjectPath.TranscodedFolder, {recursive: true});
    Config.Encryption.scratchFolder = path.join(root, 'scratch');
    EncryptionManager.setKeyForTesting(null);
  };

  const copyAsset = async (name: string, as = name): Promise<string> => {
    const dest = path.join(images, as);
    await fs.promises.mkdir(path.dirname(dest), {recursive: true});
    await fs.promises.copyFile(path.join(ASSETS, name), dest);
    return dest;
  };

  afterEach(async () => {
    EncryptionManager.setKeyForTesting(null);
    if (root) {
      await fs.promises.rm(root, {recursive: true, force: true});
    }
  });

  describe('key handling', () => {
    beforeEach(setup);

    const metaPath = (): string => path.join(images, EncryptionManager.META_FILE_NAME);

    it('should not be active and not need a key while there is no key file', async () => {
      await EncryptionManager.init();
      expect(EncryptionManager.isEnabled()).to.be.false;
      expect(EncryptionManager.isLocked()).to.be.false;
      expect(await EncryptionManager.isEncrypted(await copyAsset('test_png.png'))).to.be.false;
    });

    it('should wrap a random key with the password and never store the password or the key', async () => {
      await EncryptionManager.setup('alice', 'correct horse battery staple');
      const raw = await fs.promises.readFile(metaPath(), 'utf8');
      const meta = JSON.parse(raw);
      expect(meta.version).to.equal(2);
      expect(meta.unlockUser).to.equal('alice');
      expect(meta.kdf).to.equal('scrypt');
      expect(meta.salt).to.have.length(32);
      expect(raw).to.not.contain('correct horse');
      // nonce + key + tag
      expect(meta.wrappedKey).to.have.length((12 + 32 + 16) * 2);
    });

    it('should start locked and unlock only with the password of the unlock user', async () => {
      await EncryptionManager.setup('alice', 'correct horse battery staple');
      const photo = await copyAsset('test_png.png');
      await EncryptionManager.encryptFile(photo);

      await EncryptionManager.init();
      expect(EncryptionManager.isEnabled()).to.be.true;
      expect(EncryptionManager.isLocked()).to.be.true;
      expect(EncryptionManager.getUnlockUser()).to.equal('alice');

      expect(await EncryptionManager.unlock('bob', 'correct horse battery staple')).to.be.false;
      expect(await EncryptionManager.unlock('alice', 'wrong password')).to.be.false;
      expect(EncryptionManager.isLocked()).to.be.true;

      expect(await EncryptionManager.unlock('alice', 'correct horse battery staple')).to.be.true;
      expect(EncryptionManager.isLocked()).to.be.false;
      expect((await EncryptionManager.readFile(photo)).length).to.equal(
        (await fs.promises.readFile(path.join(ASSETS, 'test_png.png'))).length);
    });

    it('should fail clearly, not with empty data, while locked', async () => {
      await EncryptionManager.setup('alice', 'correct horse battery staple');
      const photo = await copyAsset('test_png.png');
      await EncryptionManager.encryptFile(photo);
      await EncryptionManager.init();

      const e = await rejects(EncryptionManager.readFile(photo));
      expect(e).to.be.instanceOf(EncryptionLockedError);
      expect(() => EncryptionManager.assertUnlocked()).to.throw(EncryptionLockedError);
      // indexing must not turn a locked photo into an empty one
      const e2 = await rejects(MetadataLoader.loadPhotoMetadata(photo));
      expect(e2).to.be.instanceOf(EncryptionLockedError);
    });

    it('should not be fooled by a different unicode form of the same password', async () => {
      await EncryptionManager.setup('alice', 'café password'); // precomposed
      await EncryptionManager.init();
      expect(await EncryptionManager.unlock('alice', 'café password')).to.be.true; // decomposed
    });

    it('should refuse short passwords and a second setup', async () => {
      const e = await rejects(EncryptionManager.setup('alice', 'short'));
      expect(e.message).to.contain('at least');
      expect(fs.existsSync(metaPath())).to.be.false;

      await EncryptionManager.setup('alice', 'long enough password');
      const e2 = await rejects(EncryptionManager.setup('alice', 'another long password'));
      expect(e2.message).to.contain('already');
    });

    it('should keep the files readable after the password changed (rewrap)', async () => {
      await EncryptionManager.setup('alice', 'first long password');
      const photo = await copyAsset('test_png.png');
      const original = await fs.promises.readFile(photo);
      await EncryptionManager.encryptFile(photo);

      await EncryptionManager.rewrap('second long password');
      expect(fs.readdirSync(images).filter(f => f.endsWith('.tmp'))).to.deep.equal([]);

      await EncryptionManager.init();
      expect(await EncryptionManager.unlock('alice', 'first long password')).to.be.false;
      expect(await EncryptionManager.unlock('alice', 'second long password')).to.be.true;
      expect((await EncryptionManager.readFile(photo)).equals(original)).to.be.true;
    });

    it('should refuse a rewrap with a short password and while locked', async () => {
      await EncryptionManager.setup('alice', 'first long password');
      const e = await rejects(EncryptionManager.rewrap('short'));
      expect(e.message).to.contain('at least');
      await EncryptionManager.init();
      expect(await rejects(EncryptionManager.rewrap('second long password'))).to.be.instanceOf(EncryptionLockedError);
    });

    it('should not unwrap a key file that was edited to belong to an other user', async () => {
      await EncryptionManager.setup('alice', 'first long password');
      const meta = JSON.parse(await fs.promises.readFile(metaPath(), 'utf8'));
      meta.unlockUser = 'mallory';
      await fs.promises.writeFile(metaPath(), JSON.stringify(meta));
      await EncryptionManager.init();
      expect(await EncryptionManager.unlock('mallory', 'first long password')).to.be.false;
    });

    it('should refuse to read a key file of the old passphrase based version', async () => {
      await fs.promises.writeFile(metaPath(), JSON.stringify({version: 1, kdf: 'scrypt', salt: 'aa'}));
      const e = await rejects(EncryptionManager.init());
      expect(e.message).to.contain('not supported');
    });

    it('should be off again once the key file is removed', async () => {
      await EncryptionManager.setup('alice', 'first long password');
      await EncryptionManager.removeKeyFile();
      expect(EncryptionManager.isEnabled()).to.be.false;
      expect(fs.existsSync(metaPath())).to.be.false;
    });
  });

  describe('files', () => {
    beforeEach(async () => {
      await setup();
      EncryptionManager.setKeyForTesting(Buffer.alloc(32, 5));
    });

    it('should encrypt a file in place, keeping its name and modification time', async () => {
      const photo = await copyAsset('test_png.png');
      const original = await fs.promises.readFile(photo);
      const mtime = new Date('2020-02-02T10:00:00Z');
      await fs.promises.utimes(photo, mtime, mtime);

      expect(await EncryptionManager.encryptFile(photo)).to.be.true;
      expect(await EncryptionManager.isEncrypted(photo)).to.be.true;
      expect((await fs.promises.stat(photo)).mtime.getTime()).to.equal(mtime.getTime());
      expect((await fs.promises.readFile(photo)).includes(original.subarray(0, 64))).to.be.false;
      expect((await EncryptionManager.readFile(photo)).equals(original)).to.be.true;
      expect(await EncryptionManager.getPlainSize(photo)).to.equal(original.length);
      // no staging file is left behind
      expect(fs.existsSync(photo + '.pg2enc')).to.be.false;
    });

    it('should skip already encrypted files and decrypt back to the identical bytes', async () => {
      const photo = await copyAsset('test_png.png');
      const original = await fs.promises.readFile(photo);
      await EncryptionManager.encryptFile(photo);
      expect(await EncryptionManager.encryptFile(photo)).to.be.false;

      expect(await EncryptionManager.decryptFile(photo)).to.be.true;
      expect(await EncryptionManager.decryptFile(photo)).to.be.false;
      expect((await fs.promises.readFile(photo)).equals(original)).to.be.true;
    });

    it('should write new files encrypted only when the gallery is encrypted', async () => {
      const a = path.join(images, 'a.txt');
      await EncryptionManager.writeFile(a, 'hello');
      expect(await EncryptionManager.isEncrypted(a)).to.be.true;
      expect((await EncryptionManager.readFile(a)).toString()).to.equal('hello');

      EncryptionManager.setKeyForTesting(null);
      const b = path.join(images, 'b.txt');
      await EncryptionManager.writeFile(b, 'hello');
      expect(await EncryptionManager.isEncrypted(b)).to.be.false;
      // plain files are still readable, so a gallery can be encrypted gradually
      expect((await EncryptionManager.readFile(b)).toString()).to.equal('hello');
    });

    it('should leave the original untouched if the encrypted copy can not be verified', async () => {
      const photo = await copyAsset('test_png.png');
      const original = await fs.promises.readFile(photo);
      // a stage path that can not be created makes the encryption fail halfway
      await fs.promises.mkdir(photo + '.pg2enc');
      await rejects(EncryptionManager.encryptFile(photo));
      expect((await fs.promises.readFile(photo)).equals(original)).to.be.true;
    });
  });

  describe('media processing of encrypted files', () => {
    beforeEach(async () => {
      await setup();
    });

    const enableEncryption = async (): Promise<void> => {
      EncryptionManager.setKeyForTesting(Buffer.alloc(32, 5));
    };

    it('should read the same photo metadata from an encrypted photo', async () => {
      const photo = await copyAsset('Chars_exiftool.jpg');
      const plainMeta = await MetadataLoader.loadPhotoMetadata(photo);
      const plainSize = (await fs.promises.stat(photo)).size;

      await enableEncryption();
      await EncryptionManager.encryptFile(photo);
      const encMeta = await MetadataLoader.loadPhotoMetadata(photo);

      expect(plainMeta.size.width).to.be.greaterThan(0);
      expect(encMeta.size).to.deep.equal(plainMeta.size);
      expect(encMeta.fileSize).to.equal(plainSize);
      expect(encMeta.fileSize).to.not.equal((await fs.promises.stat(photo)).size);
      expect(encMeta.creationDate).to.equal(plainMeta.creationDate);
      expect(encMeta.keywords).to.deep.equal(plainMeta.keywords);
      expect(encMeta.caption).to.equal(plainMeta.caption);
      expect(encMeta.cameraData).to.deep.equal(plainMeta.cameraData);
      expect(encMeta.positionData).to.deep.equal(plainMeta.positionData);
    });

    it('should read the metadata of a photo with an encrypted sidecar', async () => {
      const photo = await copyAsset('sidecar/' + fs.readdirSync(path.join(ASSETS, 'sidecar'))
        .find(f => f.toLowerCase().endsWith('.jpg')));
      const xmp = fs.readdirSync(path.join(ASSETS, 'sidecar')).find(f => f.toLowerCase().endsWith('.xmp'));
      if (!xmp) {
        return; // no sidecar fixture in this checkout
      }
      await copyAsset('sidecar/' + xmp);
      const plainMeta = await MetadataLoader.loadPhotoMetadata(photo);
      await enableEncryption();
      for (const f of fs.readdirSync(path.dirname(photo))) {
        await EncryptionManager.encryptFile(path.join(path.dirname(photo), f));
      }
      expect(await MetadataLoader.loadPhotoMetadata(photo)).to.deep.equal(plainMeta);
    });

    it('should generate an encrypted thumbnail that is a valid image', async () => {
      const photo = await copyAsset('Chars_exiftool.jpg');
      await enableEncryption();
      await EncryptionManager.encryptFile(photo);
      PhotoProcessing.init();

      Config.Media.Photo.thumbnailSizes = [64];
      const th = await PhotoProcessing.generateThumbnail(photo, 64, ThumbnailSourceType.Photo, true);

      expect(await EncryptionManager.isEncrypted(th)).to.be.true;
      const raw = await fs.promises.readFile(th);
      expect(raw.includes(Buffer.from('WEBP'))).to.be.false; // the format marker is not visible
      const meta = await sharp(await EncryptionManager.readFile(th)).metadata();
      expect(meta.format).to.equal('webp');
      expect(meta.width).to.equal(64);
      expect(meta.height).to.equal(64);
    });

    it('should keep making plain thumbnails when encryption is off', async () => {
      const photo = await copyAsset('Chars_exiftool.jpg');
      PhotoProcessing.init();
      Config.Media.Photo.thumbnailSizes = [64];
      const th = await PhotoProcessing.generateThumbnail(photo, 64, ThumbnailSourceType.Photo, true);
      expect(await EncryptionManager.isEncrypted(th)).to.be.false;
      expect((await sharp(th).metadata()).format).to.equal('webp');
    });

    it('should read the metadata of an encrypted video without a plain copy', async () => {
      const video = await copyAsset('video.mp4');
      const plainMeta = await MetadataLoader.loadVideoMetadata(video);
      const plainSize = (await fs.promises.stat(video)).size;
      expect(plainMeta.duration).to.be.greaterThan(0);

      await enableEncryption();
      await EncryptionManager.encryptFile(video);
      const encMeta = await MetadataLoader.loadVideoMetadata(video);

      expect(encMeta.size).to.deep.equal(plainMeta.size);
      expect(encMeta.duration).to.equal(plainMeta.duration);
      expect(encMeta.fps).to.equal(plainMeta.fps);
      expect(encMeta.fileSize).to.equal(plainSize);
      // nothing but the encrypted file and the stored salt are in the image folder
      expect(fs.readdirSync(images).filter(f => f !== EncryptionManager.META_FILE_NAME)).to.deep.equal(['video.mp4']);
    });

    it('should make an encrypted thumbnail of an encrypted video', async () => {
      const video = await copyAsset('video.mp4');
      await enableEncryption();
      await EncryptionManager.encryptFile(video);

      const out = path.join(ProjectPath.TranscodedFolder, 'video_th.webp');
      await VideoRendererFactory.build()({
        type: ThumbnailSourceType.Video,
        mediaPath: video,
        size: 48,
        outPath: out,
        makeSquare: true,
        useLanczos3: true,
        quality: 80,
        smartSubsample: false,
        sharpOptions: {},
        animate: false
      });

      expect(await EncryptionManager.isEncrypted(out)).to.be.true;
      const meta = await sharp(await EncryptionManager.readFile(out)).metadata();
      expect(meta.format).to.equal('webp');
      expect(meta.width).to.equal(48);
      // the frame went through a pipe: no plain image was written next to it
      expect(fs.readdirSync(ProjectPath.TranscodedFolder)).to.deep.equal(['video_th.webp']);
    });

    it('should transcode an encrypted video into an encrypted video and clean up the scratch file', async () => {
      const video = await copyAsset('video.mp4');
      await enableEncryption();
      await EncryptionManager.encryptFile(video);

      const out = path.join(ProjectPath.TranscodedFolder, 'video_converted.mp4');
      await VideoConverterWorker.convert({
        videoPath: video,
        input: {},
        output: {path: out, codec: 'libx264', format: 'mp4', crf: 30, resolution: 120, customOptions: ['-movflags', 'faststart']} as never
      });

      expect(await EncryptionManager.isEncrypted(out)).to.be.true;
      expect(fs.existsSync(Config.Encryption.scratchFolder) ? fs.readdirSync(Config.Encryption.scratchFolder) : [])
        .to.deep.equal([]);
      // it is a real, playable video once decrypted
      const decoded = path.join(root, 'decoded.mp4');
      await fs.promises.writeFile(decoded, await EncryptionManager.readFile(out));
      const meta = await MetadataLoader.loadVideoMetadata(decoded);
      expect(meta.size.height).to.equal(120);
      expect(meta.duration).to.be.greaterThan(0);
    });

    it('should compress an encrypted gpx file into an encrypted gpx file', async () => {
      const gpx = path.join(images, 'track.gpx');
      const points = Array.from({length: 50}, (_, i) =>
        `<trkpt lat="${47 + i * 0.001}" lon="${19 + i * 0.001}"><time>2020-01-01T00:${String(i).padStart(2, '0')}:00Z</time></trkpt>`).join('');
      await fs.promises.writeFile(gpx, `<?xml version="1.0"?><gpx><trk><trkseg>${points}</trkseg></trk></gpx>`);
      await enableEncryption();
      await EncryptionManager.encryptFile(gpx);

      const compressed = await GPXProcessing.compressGPX(gpx);
      expect(await EncryptionManager.isEncrypted(compressed)).to.be.true;
      expect((await EncryptionManager.readFile(compressed)).toString()).to.contain('<gpx>');
    });

    it('should render an svg icon without encrypting it', async () => {
      await enableEncryption();
      const out = path.join(ProjectPath.TranscodedFolder, 'icon.png');
      await ImageRendererFactory.render({
        type: ThumbnailSourceType.Photo,
        svgString: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        size: 16,
        outPath: out,
        makeSquare: false,
        quality: 80,
        useLanczos3: true
      } as never);
      expect(await EncryptionManager.isEncrypted(out)).to.be.false;
    });
  });
});
