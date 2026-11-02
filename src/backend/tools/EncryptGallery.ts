import 'reflect-metadata';
import {promises as fsp} from 'fs';
import * as path from 'path';
import {ProjectPath} from '../ProjectPath';
import {SupportedFormats} from '../../common/SupportedFormats';
import {EncryptionManager} from '../model/encryption/EncryptionManager';
import {SQLConnection} from '../model/database/SQLConnection';
import {UserManager} from '../model/database/UserManager';

/**
 * Encrypts (or decrypts) the existing files of the gallery in place.
 * The key of the gallery is protected by the login password of one gallery user (the "unlock user").
 *
 * Usage (stop the server first, and keep a backup of the gallery before the first run):
 *   node ./src/backend/tools/EncryptGallery --user=<name>            shows what would be encrypted
 *   node ./src/backend/tools/EncryptGallery --user=<name> --apply    encrypts the files
 *   node ./src/backend/tools/EncryptGallery --decrypt --apply        turns the files back to plain
 *
 * The password is asked without echo. For scripts it can be given in the PG2_ENCRYPTION_PASSWORD environment variable
 * or on the standard input. The tool reads the config like the server does, so the same options work (e.g.: --config-path=...).
 * It can be interrupted and restarted: files are replaced one by one, and encrypted files are skipped.
 */
const args = process.argv || [];
const apply = args.includes('--apply');
const decrypt = args.includes('--decrypt');

const getArg = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) {
    return undefined;
  }
  return args[i].includes('=') ? args[i].substring(args[i].indexOf('=') + 1) : args[i + 1];
};

const isTargetFile = (name: string): boolean => {
  const ext = path.extname(name).toLowerCase();
  return SupportedFormats.WithDots.Photos.includes(ext) ||
    SupportedFormats.WithDots.Videos.includes(ext) ||
    SupportedFormats.WithDots.MetaFiles.includes(ext) ||
    ext === '.xmp'; // sidecars
};

const walk = async function* (dir: string): AsyncGenerator<string> {
  for (const entry of await fsp.readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && isTargetFile(entry.name)) {
      yield full;
    }
  }
};

const wipeGeneratedFiles = async (): Promise<void> => {
  // thumbnails, converted videos and face thumbnails are regenerated on demand
  for (const folder of [ProjectPath.TranscodedFolder, ProjectPath.FacesFolder]) {
    await fsp.rm(folder, {recursive: true, force: true});
  }
};

const readPassword = (prompt: string): Promise<string> => {
  if (process.env.PG2_ENCRYPTION_PASSWORD) {
    return Promise.resolve(process.env.PG2_ENCRYPTION_PASSWORD);
  }
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { // piped: first line
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => data += d);
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      stdin.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    let password = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(password);
        } else if (c === '\u0003') { // ctrl+c
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (c === '\u007f' || c === '\b') {
          password = password.slice(0, -1);
        } else {
          password += c;
        }
      }
    };
    stdin.on('data', onData);
  });
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

(async (): Promise<void> => {
  await EncryptionManager.init();
  const alreadySetUp = EncryptionManager.isEnabled();
  const requestedUser = getArg('--user');

  if (decrypt && !alreadySetUp) {
    fail('This gallery is not encrypted (there is no ' + EncryptionManager.META_FILE_NAME + ' in ' + ProjectPath.ImageFolder + ').');
  }
  if (alreadySetUp && requestedUser && requestedUser !== EncryptionManager.getUnlockUser()) {
    fail('This gallery is locked to the password of "' + EncryptionManager.getUnlockUser() + '", not "' + requestedUser + '".');
  }
  const user = alreadySetUp ? EncryptionManager.getUnlockUser() : requestedUser;
  if (!user) {
    fail('Say whose login password unlocks the gallery: --user=<name>');
  }

  const mode = decrypt ? 'decrypt' : 'encrypt';
  console.log((apply ? 'Running' : 'Dry run (use --apply to change the files)') + ': ' + mode +
    ' the files in ' + ProjectPath.ImageFolder);

  if (apply) {
    const password = await readPassword('Gallery password of "' + user + '": ');
    // it has to be the login password, otherwise the user could not unlock the gallery later
    try {
      await new UserManager().findOne({name: user, password});
    } catch (e) {
      await SQLConnection.close();
      fail('There is no user "' + user + '" with this password in the gallery. ' +
        'Create the user in the gallery first, and use its login password.');
    }
    if (alreadySetUp) {
      if (!(await EncryptionManager.unlockWithPassword(password))) {
        await SQLConnection.close();
        fail('This password does not open the key of the gallery. Was the password of "' + user + '" changed while the gallery was not unlocked?');
      }
    } else {
      await EncryptionManager.setup(user, password);
      console.log('Key file created: ' + EncryptionManager.MetaFilePath + ' (keep it with the photos).');
    }
    await SQLConnection.close();
  }

  const counts = {changed: 0, skipped: 0, failed: 0};
  for await (const file of walk(ProjectPath.ImageFolder)) {
    try {
      const encrypted = await EncryptionManager.isEncrypted(file);
      if (encrypted === decrypt) { // needs a change
        if (apply) {
          if (decrypt) {
            await EncryptionManager.decryptFile(file);
          } else {
            await EncryptionManager.encryptFile(file);
          }
        }
        counts.changed++;
        if (counts.changed % 100 === 0) {
          console.log(counts.changed + ' files done...');
        }
      } else {
        counts.skipped++;
      }
    } catch (e) {
      counts.failed++;
      console.error('FAILED: ' + file + ' (' + (e as Error).message + ')');
    }
  }

  if (apply) {
    await wipeGeneratedFiles();
  }
  console.log((apply ? '' : 'Would be ') + (decrypt ? 'decrypted' : 'encrypted') + ': ' + counts.changed +
    ', already in the right state: ' + counts.skipped + ', failed: ' + counts.failed);
  if (apply) {
    console.log('The thumbnails and converted files in the temp folder were deleted, they are regenerated on demand.');
    if (decrypt && counts.failed === 0) {
      await EncryptionManager.removeKeyFile();
      console.log('The gallery is not encrypted anymore, the key file was removed.');
    } else if (decrypt) {
      console.log('Some files failed, the key file was kept. Run the tool again.');
    } else {
      console.log('From now on, "' + user + '" unlocks the gallery by logging in. If this password is lost, the files can not be recovered.');
    }
  }
  process.exit(counts.failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
