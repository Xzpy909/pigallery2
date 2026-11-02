import {promises as fsp} from 'fs';
import * as path from 'path';
import {Job} from './Job';
import {DefaultsJobs} from '../../../../common/entities/job/JobDTO';
import {DynamicConfig} from '../../../../common/entities/DynamicConfig';
import {ProjectPath} from '../../../ProjectPath';
import {EncryptionManager} from '../../encryption/EncryptionManager';

/**
 * Encrypts every photo, video, meta file and sidecar that is not encrypted yet.
 * It is available once the gallery has a key (Tools / Encrypt media files, or the EncryptGallery tool).
 * It walks the photo folder (not the DB), one directory per step, and can be stopped and started again.
 */
export class EncryptionJob extends Job {
  public readonly Name = DefaultsJobs[DefaultsJobs['Media Encryption']];
  public readonly ConfigTemplate: DynamicConfig[] = [];
  private directoryQueue: string[] = [];
  private encryptedCount = 0;

  get LOG_TAG(): string {
    return '[EncryptionJob]';
  }

  public get Supported(): boolean {
    return EncryptionManager.isEnabled() && !EncryptionManager.isLocked();
  }

  protected async init(): Promise<void> {
    this.directoryQueue = [ProjectPath.ImageFolder];
    this.encryptedCount = 0;
  }

  protected async step(): Promise<boolean> {
    const dir = this.directoryQueue.shift();
    if (dir === undefined) {
      if (this.encryptedCount > 0) {
        // the old plain thumbnails are not needed anymore, they are regenerated encrypted
        await EncryptionManager.deleteGeneratedFiles();
        this.Progress.log('Deleted the old thumbnails, they are regenerated encrypted on demand.');
      }
      return false;
    }
    this.Progress.log('scanning directory: ' + dir);
    for (const entry of await fsp.readdir(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.directoryQueue.push(full);
      } else if (entry.isFile() && EncryptionManager.isTargetFile(entry.name)) {
        try {
          if (await EncryptionManager.encryptFile(full)) {
            this.Progress.Processed++;
            this.encryptedCount++;
          } else {
            this.Progress.Skipped++;
          }
        } catch (e) {
          this.Progress.log('FAILED: ' + full + ' (' + (e as Error).message + ')');
        }
      }
    }
    return true;
  }
}
