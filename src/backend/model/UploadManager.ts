import {ProjectPath} from '../ProjectPath';
import * as path from 'path';
import * as fs from 'fs';
import {UploadUtils} from '../../common/UploadUtils';
import {FileAlreadyExists} from '../exceptions/FileAlreadyExists';
import {ObjectManagers} from './ObjectManagers';
import {DiskManager} from './fileaccess/DiskManager';
import {Config} from '../../common/config/private/Config';
import {PG2ConfMap} from '../../common/PG2ConfMap';
import {EncryptionManager} from './encryption/EncryptionManager';

export interface UploadError {
  filename: string;
  error: string;
}

export class UploadManager {

  private static readonly MAX_FOLDER_DEPTH = 32;

  /**
   * Checks the folder of an uploaded folder structure (e.g.: "Holiday/Day 1"), that is inside the upload directory.
   * Returns the normalized path without leading or trailing slashes.
   */
  public static sanitizeRelativeDir(relativeDir: string): string {
    if (!relativeDir) {
      return '';
    }
    const parts = relativeDir.split('/').filter(p => p.length > 0);
    if (parts.length > UploadManager.MAX_FOLDER_DEPTH) {
      throw new Error('The folder structure is too deep.');
    }
    for (const part of parts) {
      if (part === '.' || part === '..' || /[\\\0]/.test(part) || part.length > 255) {
        throw new Error('Invalid folder name: ' + part);
      }
    }
    return parts.join('/');
  }

  public async saveFiles(directoryIn: string, files: Express.Multer.File[], uploadedFolder = ''): Promise<UploadError[]> {
    if (Config.Upload.enabled === false) {
      throw new Error('Upload is disabled');
    }
    const directory = directoryIn || '';
    const relativeDir = directory;
    const fullDirPath = path.join(ProjectPath.ImageFolder, relativeDir);
    // the target of the files, it can be a new folder inside the upload directory
    const folder = UploadManager.sanitizeRelativeDir(uploadedFolder);
    const targetDirectory = folder ? path.join(directory, folder) : directory;

    if (Config.Upload.enforcedDirectoryConfig === true) {
      const hasUploadConf = Object.keys(PG2ConfMap.upload).some(filename => {
        const pg2confPath = path.join(fullDirPath, filename);
        return fs.existsSync(pg2confPath);
      });
      if (!hasUploadConf) {
        throw new Error('Upload is not enabled in this directory');
      }
    }

    const errors: UploadError[] = [];
    for (const file of files) {
      try {
        await this.saveFile(targetDirectory, file);
      } catch (e) {
        errors.push({filename: file.originalname, error: e.message});
      }
    }
    const dto = DiskManager.getDTOFromPath(directory || '');
    await ObjectManagers.getInstance().onDataChange(dto);

    return errors;
  }

  public async saveFile(directory: string, file: Express.Multer.File): Promise<void> {
    const relativeDir = directory || '';
    const fullDirPath = path.resolve(path.join(ProjectPath.ImageFolder, relativeDir));

    const filename = file.originalname;
    // the filename must be a plain name, no path components
    if (!filename || filename === '.' || filename === '..' ||
      /[/\\\0]/.test(filename) || path.basename(filename) !== filename) {
      throw new Error('Invalid filename: ' + filename);
    }

    const extension = UploadUtils.getExtension(filename);
    if (!UploadUtils.isUploadableExtension(extension, Config.Upload.blockedExtensions)) {
      throw new Error('Unsupported file format: ' + extension);
    }

    const fullFilePath = path.join(fullDirPath, filename);
    const imageFolder = path.resolve(ProjectPath.ImageFolder);
    if (fullFilePath.indexOf(imageFolder + path.sep) !== 0) {
      throw new Error('Invalid upload path: ' + filename);
    }

    if (fs.existsSync(fullFilePath)) {
      throw new FileAlreadyExists('File already exists: ' + fullFilePath, file.originalname);
    }

    if (!fs.existsSync(fullDirPath)) {
      await fs.promises.mkdir(fullDirPath, {recursive: true});
    }

    if (Config.Upload.encryptNewUploads === false) {
      await fs.promises.writeFile(fullFilePath, file.buffer);
      return;
    }
    // encrypted before it reaches the disk, if the gallery is encrypted
    await EncryptionManager.writeFile(fullFilePath, file.buffer);
  }
}
