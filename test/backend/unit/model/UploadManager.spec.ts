import {expect} from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import {UploadManager} from '../../../../src/backend/model/UploadManager';
import {ProjectPath} from '../../../../src/backend/ProjectPath';
import {Config} from '../../../../src/common/config/private/Config';
import {ObjectManagers} from '../../../../src/backend/model/ObjectManagers';
import {TestHelper} from '../../../TestHelper';
import {EncryptionManager} from '../../../../src/backend/model/encryption/EncryptionManager';

declare const describe: any;
declare const before: any;
declare const after: any;
declare const it: any;

describe('UploadManager', () => {
  before(TestHelper.resetConfig);
  const uploadManager = new UploadManager();
  const testDir = path.join(__dirname, 'tmp');

  before(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, {recursive: true});
    }
    Config.Media.folder = testDir;
    Config.Upload.enabled = true;
    ProjectPath.reset();

    // Mock ObjectManagers
    const om: any = ObjectManagers.getInstance();
    om.VersionManager = {onNewDataVersion: () => Promise.resolve()};
    om.initDone = true;
  });

  after(async () => {
    await ObjectManagers.reset();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, {recursive: true, force: true});
    }
  });

  it('should save a supported file', async () => {
    const file: any = {
      originalname: 'test.jpg',
      buffer: Buffer.from('test image content')
    };
    await uploadManager.saveFile('test_subdir', file);

    const savedPath = path.join(testDir, 'test_subdir', 'test.jpg');
    expect(fs.existsSync(savedPath)).to.be.true;
    expect(fs.readFileSync(savedPath).toString()).to.equal('test image content');
  });

  it('should throw error for unsupported file', async () => {
    const file: any = {
      originalname: 'test.exe',
      buffer: Buffer.from('test content')
    };
    try {
      await uploadManager.saveFile('', file);
      expect.fail('Should have thrown an error');
    } catch (e) {
      expect(e.message).to.contain('Unsupported file format');
    }
  });

  it('should reject filenames with path components', async () => {
    for (const name of ['../escape.jpg', '..\\escape.jpg', 'sub/escape.jpg', '../../../../../tmp/poc.gpx', '..', '.', '']) {
      const file: any = {
        originalname: name,
        buffer: Buffer.from('test content')
      };
      try {
        await uploadManager.saveFile('traversal_test', file);
        expect.fail('Should have thrown an error for: ' + name);
      } catch (e) {
        expect(e.message, name).to.contain('Invalid filename');
      }
    }
    expect(fs.existsSync(path.join(testDir, 'escape.jpg'))).to.be.false;
    expect(fs.existsSync(path.join(testDir, 'traversal_test', 'sub'))).to.be.false;
  });

  it('should reject a directory outside of the image folder', async () => {
    const file: any = {
      originalname: 'outside.jpg',
      buffer: Buffer.from('test content')
    };
    try {
      await uploadManager.saveFile('../outside_dir', file);
      expect.fail('Should have thrown an error');
    } catch (e) {
      expect(e.message).to.contain('Invalid upload path');
    }
    expect(fs.existsSync(path.join(testDir, '..', 'outside_dir'))).to.be.false;
  });

  it('should not accept blocked extensions by default', async () => {
    for (const name of ['.uploader.pg2conf', 'sorting.PG2CONF', 'image.svg']) {
      const file: any = {
        originalname: name,
        buffer: Buffer.from('{}')
      };
      try {
        await uploadManager.saveFile('blocked_test', file);
        expect.fail('Should have thrown an error for: ' + name);
      } catch (e) {
        expect(e.message, name).to.contain('Unsupported file format');
      }
    }
  });

  it('should accept supported extensions that are removed from blockedExtensions', async () => {
    const blocked = Config.Upload.blockedExtensions;
    Config.Upload.blockedExtensions = [];
    try {
      for (const name of ['.uploader.pg2conf', 'image.svg']) {
        const file: any = {
          originalname: name,
          buffer: Buffer.from('{}')
        };
        await uploadManager.saveFile('unblocked_test', file);
        expect(fs.existsSync(path.join(testDir, 'unblocked_test', name)), name).to.be.true;
      }
    } finally {
      Config.Upload.blockedExtensions = blocked;
    }
  });

  it('should block any listed extension', async () => {
    const blocked = Config.Upload.blockedExtensions;
    Config.Upload.blockedExtensions = ['JPG'];
    try {
      const file: any = {
        originalname: 'image.jpg',
        buffer: Buffer.from('test')
      };
      await uploadManager.saveFile('blocked_jpg_test', file);
      expect.fail('Should have thrown an error');
    } catch (e) {
      expect(e.message).to.contain('Unsupported file format');
    } finally {
      Config.Upload.blockedExtensions = blocked;
    }
  });

  it('should handle multiple files with some errors', async () => {
    const files: any[] = [
      {
        originalname: 'valid.jpg',
        buffer: Buffer.from('valid jpg')
      },
      {
        originalname: 'invalid.exe',
        buffer: Buffer.from('invalid exe')
      }
    ];

    const errors = await uploadManager.saveFiles('multi_test', files);
    expect(errors.length).to.equal(1);
    expect(errors[0].filename).to.equal('invalid.exe');
    expect(errors[0].error).to.contain('Unsupported file format');

    const validPath = path.join(testDir, 'multi_test', 'valid.jpg');
    expect(fs.existsSync(validPath)).to.be.true;
  });

  it('should throw error if upload is disabled', async () => {
    Config.Upload.enabled = false;
    try {
      const file: any = {
        originalname: 'test.jpg',
        buffer: Buffer.from('test content')
      };
      await uploadManager.saveFiles('', [file]);
      expect.fail('Should have thrown an error');
    } catch (e) {
      expect(e.message).to.equal('Upload is disabled');
    } finally {
      Config.Upload.enabled = true;
    }
  });

  it('should throw error if enforcedDirectoryConfig is true and .uploader.pg2conf is missing', async () => {
    Config.Upload.enforcedDirectoryConfig = true;
    try {
      const file: any = {
        originalname: 'test.jpg',
        buffer: Buffer.from('test content')
      };
      await uploadManager.saveFiles('no_config_dir', [file]);
      expect.fail('Should have thrown an error');
    } catch (e) {
      expect(e.message).to.equal('Upload is not enabled in this directory');
    } finally {
      Config.Upload.enforcedDirectoryConfig = false;
    }
  });

  it('should save file if enforcedDirectoryConfig is true and .uploader.pg2conf exists', async () => {
    Config.Upload.enforcedDirectoryConfig = true;
    const dir = 'config_dir';
    const fullDirPath = path.join(testDir, dir);
    if (!fs.existsSync(fullDirPath)) {
      fs.mkdirSync(fullDirPath, {recursive: true});
    }
    fs.writeFileSync(path.join(fullDirPath, '.uploader.pg2conf'), '');

    try {
      const file: any = {
        originalname: 'test.jpg',
        buffer: Buffer.from('test content')
      };
      await uploadManager.saveFiles(dir, [file]);
      const savedPath = path.join(fullDirPath, 'test.jpg');
      expect(fs.existsSync(savedPath)).to.be.true;
    } finally {
      Config.Upload.enforcedDirectoryConfig = false;
    }
  });

  it('should return error if file already exists', async () => {
    const file: any = {
      originalname: 'exists.jpg',
      buffer: Buffer.from('content')
    };
    await uploadManager.saveFile('exists_test', file);

    const errors = await uploadManager.saveFiles('exists_test', [file]);
    expect(errors.length).to.equal(1);
    expect(errors[0].filename).to.equal('exists.jpg');
    expect(errors[0].error).to.contain('already exists');
  });

  it('should store an uploaded file encrypted when encryption is enabled', async () => {
    EncryptionManager.setKeyForTesting(Buffer.alloc(32, 7));
    try {
      const content = Buffer.from('secret image content');
      await uploadManager.saveFile('enc_subdir', {originalname: 'secret.jpg', buffer: content} as any);

      const savedPath = path.join(testDir, 'enc_subdir', 'secret.jpg');
      const onDisk = fs.readFileSync(savedPath);
      expect(onDisk.includes(content)).to.be.false;
      expect(await EncryptionManager.isEncrypted(savedPath)).to.be.true;
      expect((await EncryptionManager.readFile(savedPath)).equals(content)).to.be.true;
    } finally {
      EncryptionManager.setKeyForTesting(null);
    }
  });

  describe('folders', () => {
    const f = (name: string, content = 'content'): any => ({originalname: name, buffer: Buffer.from(content)});

    afterEach(() => {
      Config.Upload.encryptNewUploads = true;
      EncryptionManager.setKeyForTesting(null);
    });

    it('should create the folder structure, like creating the folders by hand', async () => {
      const errors = await uploadManager.saveFiles('folders_a', [f('1.jpg')], 'Holiday/Day 1');
      expect(errors).to.deep.equal([]);
      expect(fs.readFileSync(path.join(testDir, 'folders_a', 'Holiday', 'Day 1', '1.jpg'), 'utf8')).to.equal('content');
    });

    it('should merge into an existing folder and not overwrite existing files', async () => {
      await uploadManager.saveFiles('folders_b', [f('1.jpg', 'old')], 'Trip');
      const errors = await uploadManager.saveFiles('folders_b', [f('1.jpg', 'new'), f('2.jpg', 'two')], 'Trip');
      expect(errors.length).to.equal(1);
      expect(errors[0].error).to.contain('already exists');
      expect(fs.readFileSync(path.join(testDir, 'folders_b', 'Trip', '1.jpg'), 'utf8')).to.equal('old');
      expect(fs.readFileSync(path.join(testDir, 'folders_b', 'Trip', '2.jpg'), 'utf8')).to.equal('two');
    });

    it('should refuse folders that would leave the upload directory', async () => {
      for (const bad of ['..', '../x', 'a/../../x', 'a/./b', 'a\\b']) {
        let message = '';
        await uploadManager.saveFiles('folders_c', [f('evil.jpg')], bad).catch((e) => message = e.message);
        expect(message, bad).to.contain('Invalid folder name');
      }
      expect(fs.existsSync(path.join(testDir, 'evil.jpg'))).to.be.false;
      expect(fs.existsSync(path.join(testDir, 'x'))).to.be.false;
    });

    it('should ignore leading, trailing and doubled slashes', () => {
      expect(UploadManager.sanitizeRelativeDir('/a//b/')).to.equal('a/b');
      expect(UploadManager.sanitizeRelativeDir('')).to.equal('');
    });

    it('should encrypt uploads in folders when the gallery is encrypted', async () => {
      EncryptionManager.setKeyForTesting(Buffer.alloc(32, 7));
      await uploadManager.saveFiles('folders_d', [f('s.jpg', 'secret')], 'Priv');
      const p = path.join(testDir, 'folders_d', 'Priv', 's.jpg');
      expect(await EncryptionManager.isEncrypted(p)).to.be.true;
      expect((await EncryptionManager.readFile(p)).toString()).to.equal('secret');
    });

    it('should store uploads plain when "Encrypt new uploads" is off', async () => {
      EncryptionManager.setKeyForTesting(Buffer.alloc(32, 7));
      Config.Upload.encryptNewUploads = false;
      await uploadManager.saveFiles('folders_e', [f('p.jpg', 'plain text')]);
      const p = path.join(testDir, 'folders_e', 'p.jpg');
      expect(await EncryptionManager.isEncrypted(p)).to.be.false;
      expect(fs.readFileSync(p, 'utf8')).to.equal('plain text');
    });

    it('should leave the option without effect when the gallery is not encrypted', async () => {
      await uploadManager.saveFiles('folders_f', [f('p.jpg', 'x')]);
      expect(await EncryptionManager.isEncrypted(path.join(testDir, 'folders_f', 'p.jpg'))).to.be.false;
    });
  });
});
