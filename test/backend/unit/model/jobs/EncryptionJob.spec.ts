/* eslint-disable no-unused-expressions,@typescript-eslint/no-unused-expressions */
import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {EncryptionJob} from '../../../../../src/backend/model/jobs/jobs/EncryptionJob';
import {EncryptionManager} from '../../../../../src/backend/model/encryption/EncryptionManager';
import {ProjectPath} from '../../../../../src/backend/ProjectPath';
import {TestHelper} from '../../../../TestHelper';

describe('EncryptionJob', () => {
  before(TestHelper.resetConfig);

  let root: string;
  let origImages: string;
  let origTranscoded: string;
  let origFaces: string;

  beforeEach(async () => {
    origImages = ProjectPath.ImageFolder;
    origTranscoded = ProjectPath.TranscodedFolder;
    origFaces = ProjectPath.FacesFolder;
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pg2-encjob-'));
    ProjectPath.ImageFolder = path.join(root, 'images');
    ProjectPath.TranscodedFolder = path.join(root, 'tmp', 'tc');
    ProjectPath.FacesFolder = path.join(root, 'tmp', 'f');
    await fs.promises.mkdir(path.join(ProjectPath.ImageFolder, 'sub', 'deeper'), {recursive: true});
    await fs.promises.mkdir(ProjectPath.TranscodedFolder, {recursive: true});
    EncryptionManager.setKeyForTesting(null);
  });

  afterEach(async () => {
    EncryptionManager.setKeyForTesting(null);
    ProjectPath.ImageFolder = origImages;
    ProjectPath.TranscodedFolder = origTranscoded;
    ProjectPath.FacesFolder = origFaces;
    await fs.promises.rm(root, {recursive: true, force: true});
  });

  const newJob = (): EncryptionJob => {
    const job = new EncryptionJob();
    job.JobListener = {onJobFinished: (): void => undefined, onProgressUpdate: (): void => undefined} as never;
    return job;
  };

  const waitUntilDone = async (job: EncryptionJob): Promise<void> => {
    for (let i = 0; i < 200 && job.InProgress; ++i) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(job.InProgress).to.be.false;
  };

  it('should not be available before the gallery has a key, or while it is locked', () => {
    const job = new EncryptionJob();
    expect(job.Supported).to.be.false;
    EncryptionManager.setLockedForTesting();
    expect(job.Supported).to.be.false;
    EncryptionManager.setKeyForTesting(Buffer.alloc(32, 1));
    expect(job.Supported).to.be.true;
  });

  it('should encrypt the media files of all directories, skip the encrypted and leave other files alone', async () => {
    EncryptionManager.setKeyForTesting(Buffer.alloc(32, 1));
    const img = ProjectPath.ImageFolder;
    const files = {
      a: path.join(img, 'a.jpg'),
      b: path.join(img, 'sub', 'b.png'),
      c: path.join(img, 'sub', 'deeper', 'c.gpx'),
      d: path.join(img, 'sub', 'd.jpg.xmp'),
      already: path.join(img, 'already.jpg'),
      other: path.join(img, 'notes.txt'),
    };
    for (const f of Object.values(files)) {
      await fs.promises.writeFile(f, 'content of ' + path.basename(f));
    }
    await EncryptionManager.encryptFile(files.already);
    const staleThumbnail = path.join(ProjectPath.TranscodedFolder, 'old.webp');
    await fs.promises.writeFile(staleThumbnail, 'plain thumbnail');

    const job = newJob();
    await job.start({});
    await waitUntilDone(job);

    for (const f of [files.a, files.b, files.c, files.d, files.already]) {
      expect(await EncryptionManager.isEncrypted(f), f).to.be.true;
    }
    expect((await EncryptionManager.readFile(files.b)).toString()).to.equal('content of b.png');
    expect(await EncryptionManager.isEncrypted(files.other)).to.be.false;
    // the plain thumbnails go, they are regenerated encrypted
    expect(fs.existsSync(staleThumbnail)).to.be.false;
  });

  it('should keep the thumbnails if there was nothing to encrypt, and finish', async () => {
    EncryptionManager.setKeyForTesting(Buffer.alloc(32, 1));
    const f = path.join(ProjectPath.ImageFolder, 'a.jpg');
    await fs.promises.writeFile(f, 'x');
    await EncryptionManager.encryptFile(f);
    const thumb = path.join(ProjectPath.TranscodedFolder, 'keep.webp');
    await fs.promises.writeFile(thumb, 'encrypted thumbnail stays');

    const job = newJob();
    await job.start({});
    await waitUntilDone(job);

    expect(fs.existsSync(thumb)).to.be.true;
  });

  it('should refuse to start while the gallery is locked', async () => {
    EncryptionManager.setLockedForTesting();
    let failed = false;
    await newJob().start({}).catch(() => failed = true);
    expect(failed).to.be.true;
  });
});
