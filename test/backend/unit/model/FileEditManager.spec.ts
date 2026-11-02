import {expect} from 'chai';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {FileEditManager} from '../../../../src/backend/model/FileEditManager';
import {ProjectPath} from '../../../../src/backend/ProjectPath';
import {Config} from '../../../../src/common/config/private/Config';
import {ObjectManagers} from '../../../../src/backend/model/ObjectManagers';
import {TestHelper} from '../../../TestHelper';
import {EncryptionManager} from '../../../../src/backend/model/encryption/EncryptionManager';

declare const describe: any;
declare const before: any;
declare const beforeEach: any;
declare const after: any;
declare const it: any;

describe('FileEditManager', () => {
  before(TestHelper.resetConfig);
  const manager = new FileEditManager();
  let root: string;
  let changed: string[];

  const write = (rel: string, content = 'x'): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
    fs.writeFileSync(path.join(root, rel), content);
  };
  const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));

  before(() => {
    Config.Upload.enabled = true;
    const om: any = ObjectManagers.getInstance();
    om.VersionManager = {onNewDataVersion: () => Promise.resolve()};
    om.initDone = true;
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg2-edit-'));
    Config.Media.folder = root;
    ProjectPath.reset();
    Config.Upload.enabled = true;
    changed = [];
    (ObjectManagers.getInstance() as any).onDataChange = async (dir: any): Promise<void> => {
      changed.push(path.join(dir.path, dir.name));
    };
  });

  after(async () => {
    await ObjectManagers.reset();
  });

  describe('createFolder', () => {
    it('should create a folder and tell that the parent changed', async () => {
      write('album/a.jpg');
      expect(await manager.createFolder('album', 'New one')).to.equal(path.join('album', 'New one'));
      expect(fs.statSync(path.join(root, 'album', 'New one')).isDirectory()).to.be.true;
      expect(changed.length).to.equal(1);
    });

    it('should create it in the root, with non ASCII names', async () => {
      await manager.createFolder('', 'Hévíz – Tihany 🌅');
      expect(exists('Hévíz – Tihany 🌅')).to.be.true;
    });

    it('should refuse an existing folder and bad names', async () => {
      write('album/a.jpg');
      let e = '';
      await manager.createFolder('', 'album').catch(x => e = x.message);
      expect(e).to.contain('already exists');
      for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', '../x']) {
        e = '';
        await manager.createFolder('', bad).catch(x => e = x.message);
        expect(e, bad).to.contain('Invalid folder name');
      }
    });

    it('should not create anything outside of the photo folder or when the parent is missing', async () => {
      let e = '';
      await manager.createFolder('../outside', 'x').catch(x => e = x.message);
      expect(e).to.contain('Invalid path');
      e = '';
      await manager.createFolder('nope', 'x').catch(x => e = x.message);
      expect(e).to.contain('does not exist');
    });

    it('should refuse everything when uploading is disabled', async () => {
      Config.Upload.enabled = false;
      let e = '';
      await manager.createFolder('', 'x').catch(x => e = x.message);
      expect(e).to.contain('disabled');
    });
  });

  describe('renameFolder', () => {
    it('should rename a folder with its content', async () => {
      write('old/sub/a.jpg', 'A');
      expect(await manager.renameFolder('old', 'new')).to.equal('new');
      expect(exists('old')).to.be.false;
      expect(fs.readFileSync(path.join(root, 'new', 'sub', 'a.jpg'), 'utf8')).to.equal('A');
    });

    it('should rename a nested folder and report its new path', async () => {
      write('a/b/c.jpg');
      expect(await manager.renameFolder(path.join('a', 'b'), 'B2')).to.equal(path.join('a', 'B2'));
      expect(exists('a/B2/c.jpg')).to.be.true;
    });

    it('should not overwrite an existing folder, rename the root or leave the photo folder', async () => {
      write('one/a.jpg');
      write('two/b.jpg');
      let e = '';
      await manager.renameFolder('one', 'two').catch(x => e = x.message);
      expect(e).to.contain('already exists');
      expect(exists('one/a.jpg') && exists('two/b.jpg')).to.be.true;
      e = '';
      await manager.renameFolder('', 'x').catch(x => e = x.message);
      expect(e).to.contain('root');
      e = '';
      await manager.renameFolder('one', '../escaped').catch(x => e = x.message);
      expect(e).to.contain('Invalid folder name');
      e = '';
      await manager.renameFolder('../etc', 'x').catch(x => e = x.message);
      expect(e).to.contain('Invalid path');
    });

    it('should keep encrypted files readable after the folder is renamed', async () => {
      EncryptionManager.setKeyForTesting(Buffer.alloc(32, 4));
      try {
        write('enc/a.jpg', 'secret');
        await EncryptionManager.encryptFile(path.join(root, 'enc', 'a.jpg'));
        await manager.renameFolder('enc', 'enc2');
        expect((await EncryptionManager.readFile(path.join(root, 'enc2', 'a.jpg'))).toString()).to.equal('secret');
      } finally {
        EncryptionManager.setKeyForTesting(null);
      }
    });
  });

  describe('moveFiles', () => {
    it('should move files and their sidecars, and report both folders as changed', async () => {
      write('from/a.jpg', 'A');
      write('from/a.jpg.xmp', 'XA');
      write('from/b.mp4', 'B');
      write('to/keep.jpg');
      const errors = await manager.moveFiles([
        {directory: 'from', name: 'a.jpg'}, {directory: 'from', name: 'b.mp4'}], 'to');
      expect(errors).to.deep.equal([]);
      expect(exists('from/a.jpg') || exists('from/a.jpg.xmp') || exists('from/b.mp4')).to.be.false;
      expect(fs.readFileSync(path.join(root, 'to', 'a.jpg'), 'utf8')).to.equal('A');
      expect(fs.readFileSync(path.join(root, 'to', 'a.jpg.xmp'), 'utf8')).to.equal('XA');
      expect(exists('to/b.mp4') && exists('to/keep.jpg')).to.be.true;
      expect(changed.sort()).to.deep.equal([path.join('from'), path.join('to')].sort().map(p => path.join(p)).map(p => p));
    });

    it('should move the shared "name.xmp" sidecar only if no other file uses it', async () => {
      write('f/IMG1.jpg');
      write('f/IMG1.xmp');
      write('f/IMG2.jpg');
      write('f/IMG2.raw'); // same base name: shares the sidecar
      write('f/IMG2.xmp');
      await manager.moveFiles([{directory: 'f', name: 'IMG1.jpg'}, {directory: 'f', name: 'IMG2.jpg'}], '');
      expect(exists('IMG1.xmp')).to.be.true;
      expect(exists('f/IMG2.xmp')).to.be.true; // stays with IMG2.raw
      expect(exists('IMG2.xmp')).to.be.false;
    });

    it('should report files that can not be moved and move the rest', async () => {
      write('from/ok.jpg');
      write('from/clash.jpg', 'new');
      write('to/clash.jpg', 'old');
      write('from/.uploader.pg2conf');
      write('from/notes.txt');
      const errors = await manager.moveFiles([
        {directory: 'from', name: 'ok.jpg'},
        {directory: 'from', name: 'clash.jpg'},
        {directory: 'from', name: 'missing.jpg'},
        {directory: 'from', name: '.uploader.pg2conf'},
        {directory: 'from', name: 'notes.txt'},
        {directory: 'from', name: '../escape.jpg'},
        {directory: '../outside', name: 'x.jpg'},
      ], 'to');
      expect(errors.map(e => e.name)).to.deep.equal(
        ['clash.jpg', 'missing.jpg', '.uploader.pg2conf', 'notes.txt', '../escape.jpg', 'x.jpg']);
      expect(exists('to/ok.jpg')).to.be.true;
      expect(fs.readFileSync(path.join(root, 'to', 'clash.jpg'), 'utf8')).to.equal('old');
      expect(fs.readFileSync(path.join(root, 'from', 'clash.jpg'), 'utf8')).to.equal('new');
      expect(exists('from/.uploader.pg2conf') && exists('from/notes.txt')).to.be.true;
    });

    it('should move files from different folders (e.g. from a search result)', async () => {
      write('a/1.jpg');
      write('b/2.jpg');
      const errors = await manager.moveFiles([{directory: 'a', name: '1.jpg'}, {directory: 'b', name: '2.jpg'}], 'c-target-missing')
        .catch(e => e.message);
      expect(errors).to.contain('does not exist');
      fs.mkdirSync(path.join(root, 'c'));
      expect(await manager.moveFiles([{directory: 'a', name: '1.jpg'}, {directory: 'b', name: '2.jpg'}], 'c')).to.deep.equal([]);
      expect(exists('c/1.jpg') && exists('c/2.jpg')).to.be.true;
    });

    it('should refuse a target outside of the photo folder and moving into the same folder', async () => {
      write('a/1.jpg');
      let e = '';
      await manager.moveFiles([{directory: 'a', name: '1.jpg'}], '../x').catch(x => e = x.message);
      expect(e).to.contain('Invalid path');
      const errors = await manager.moveFiles([{directory: 'a', name: '1.jpg'}], 'a');
      expect(errors[0].error).to.contain('already in this folder');
    });

    it('should move encrypted files without touching their content', async () => {
      EncryptionManager.setKeyForTesting(Buffer.alloc(32, 4));
      try {
        write('src/e.jpg', 'secret');
        await EncryptionManager.encryptFile(path.join(root, 'src', 'e.jpg'));
        const before = fs.readFileSync(path.join(root, 'src', 'e.jpg'));
        fs.mkdirSync(path.join(root, 'dst'));
        await manager.moveFiles([{directory: 'src', name: 'e.jpg'}], 'dst');
        expect(fs.readFileSync(path.join(root, 'dst', 'e.jpg')).equals(before)).to.be.true;
        expect((await EncryptionManager.readFile(path.join(root, 'dst', 'e.jpg'))).toString()).to.equal('secret');
      } finally {
        EncryptionManager.setKeyForTesting(null);
      }
    });
  });

  describe('listFolders', () => {
    it('should list the sub folders, sorted, without hidden ones and files', async () => {
      write('b/x.jpg');
      write('a/x.jpg');
      write('.hidden/x.jpg');
      write('file.jpg');
      expect(await manager.listFolders('')).to.deep.equal(['a', 'b']);
      write('a/inner/x.jpg');
      expect(await manager.listFolders('a')).to.deep.equal(['inner']);
    });

    it('should not list outside of the photo folder', async () => {
      let e = '';
      await manager.listFolders('../').catch(x => e = x.message);
      expect(e).to.contain('Invalid path');
    });
  });
});
