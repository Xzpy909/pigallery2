/* eslint-disable no-unused-expressions,@typescript-eslint/no-unused-expressions */
import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {AdminMWs} from '../../../../../src/backend/middlewares/admin/AdminMWs';
import {EncryptionManager} from '../../../../../src/backend/model/encryption/EncryptionManager';
import {ObjectManagers} from '../../../../../src/backend/model/ObjectManagers';
import {ProjectPath} from '../../../../../src/backend/ProjectPath';
import {Config} from '../../../../../src/common/config/private/Config';
import {ErrorCodes} from '../../../../../src/common/entities/Error';
import {TestHelper} from '../../../../TestHelper';

describe('AdminMWs encryption setup', () => {
  before(TestHelper.resetConfig);

  let dir: string;
  let origImages: string;
  let origUserManager: unknown;

  beforeEach(async () => {
    origImages = ProjectPath.ImageFolder;
    origUserManager = ObjectManagers.getInstance().UserManager;
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pg2-adminenc-'));
    ProjectPath.ImageFolder = dir;
    Config.Users.authenticationRequired = true;
    EncryptionManager.setKeyForTesting(null);
  });

  afterEach(async () => {
    EncryptionManager.setKeyForTesting(null);
    ProjectPath.ImageFolder = origImages;
    (ObjectManagers.getInstance() as {UserManager: unknown}).UserManager = origUserManager;
    await fs.promises.rm(dir, {recursive: true, force: true});
  });

  const call = (mw: (req: never, res: never, next: never) => unknown, req: unknown): Promise<any> =>
    new Promise((resolve) => {
      Promise.resolve((mw as any)(req, {}, (err?: unknown) => resolve(err))).catch(resolve);
    });

  const mockUsers = (valid: string): void => {
    (ObjectManagers.getInstance() as {UserManager: unknown}).UserManager = {
      findOne: async (f: {name: string, password: string}): Promise<unknown> => {
        if (f.password !== valid) {
          throw new Error('No entry found');
        }
        return {name: f.name};
      }
    };
  };

  const request = (password: unknown): any => ({
    session: {context: {user: {name: 'alice'}}}, body: {password}, ip: '::1'
  });

  it('should report the status', async () => {
    const req: any = request('x');
    await call(AdminMWs.getEncryptionStatus as never, req);
    expect(req.resultPipe).to.deep.include({enabled: false, currentUser: 'alice', unlockUser: null});
  });

  it('should refuse the wrong password and create no key', async () => {
    mockUsers('right long password');
    const req = request('wrong long password');
    const err = await call(AdminMWs.setupEncryption as never, req);
    expect(err.code).to.equal(ErrorCodes.CREDENTIAL_NOT_FOUND);
    expect(EncryptionManager.isEnabled()).to.be.false;
    expect(fs.existsSync(EncryptionManager.MetaFilePath)).to.be.false;
  });

  it('should use the password of the logged in user as the key', async () => {
    mockUsers('right long password');
    const req = request('right long password');
    const err = await call(AdminMWs.setupEncryption as never, req);
    expect(err).to.be.undefined;
    expect(req.resultPipe).to.equal('ok');
    expect(EncryptionManager.isEnabled()).to.be.true;
    expect(EncryptionManager.getUnlockUser()).to.equal('alice');
    // after a restart this password unlocks it
    await EncryptionManager.init();
    expect(await EncryptionManager.unlock('alice', 'right long password')).to.be.true;
  });

  it('should refuse short passwords and a second setup', async () => {
    mockUsers('short');
    const err = await call(AdminMWs.setupEncryption as never, request('short'));
    expect(err.code).to.equal(ErrorCodes.SETTINGS_ERROR);
    expect(EncryptionManager.isEnabled()).to.be.false;

    mockUsers('right long password');
    await call(AdminMWs.setupEncryption as never, request('right long password'));
    const err2 = await call(AdminMWs.setupEncryption as never, request('right long password'));
    expect(err2.code).to.equal(ErrorCodes.SETTINGS_ERROR);
  });

  it('should need a password in the request', async () => {
    const err = await call(AdminMWs.setupEncryption as never, request(undefined));
    expect(err.code).to.equal(ErrorCodes.INPUT_ERROR);
  });
});
