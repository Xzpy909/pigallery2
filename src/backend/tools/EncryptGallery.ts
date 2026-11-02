import 'reflect-metadata';
import {promises as fsp} from 'fs';
import * as path from 'path';
import {Config} from '../../common/config/private/Config';
import {ProjectPath} from '../ProjectPath';
import {SupportedFormats} from '../../common/SupportedFormats';
import {EncryptionManager} from '../model/encryption/EncryptionManager';

/**
 * Encrypts (or decrypts) the existing files of the gallery in place.
 *
 * Usage (stop the server first, and keep a backup of the gallery before the first run):
 *   node ./src/backend/tools/EncryptGallery                    shows what would be encrypted
 *   node ./src/backend/tools/EncryptGallery --apply            encrypts the files
 *   node ./src/backend/tools/EncryptGallery --decrypt --apply  turns the files back to plain
 *
 * It reads the config like the server does, so the same options work
 * (e.g.: --config-path=..., --Encryption-passphrase=...  or the PG2_ENCRYPTION_PASSPHRASE environment variable).
 * It can be interrupted and restarted: files are replaced one by one, and encrypted files are skipped.
 */
const args = process.argv || [];
const apply = args.includes('--apply');
const decrypt = args.includes('--decrypt');

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

(async (): Promise<void> => {
  if (!decrypt) {
    // the tool is the one that decides here, not the config
    Config.Encryption.enabled = true;
  }
  await EncryptionManager.init();

  const mode = decrypt ? 'decrypt' : 'encrypt';
  console.log((apply ? 'Running' : 'Dry run (use --apply to change the files)') + ': ' + mode +
    ' the files in ' + ProjectPath.ImageFolder);

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
    if (!decrypt) {
      console.log('Keep the passphrase / key file safe: without it the files can not be recovered.');
    }
  }
  process.exit(counts.failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
