import * as path from 'path';
import * as fs from 'fs';
import {ProjectPath} from '../ProjectPath';
import {Config} from '../../common/config/private/Config';
import {ObjectManagers} from './ObjectManagers';
import {DiskManager} from './fileaccess/DiskManager';
import {FileAlreadyExists} from '../exceptions/FileAlreadyExists';
import {SupportedFormats} from '../../common/SupportedFormats';
import {UploadUtils} from '../../common/UploadUtils';

export interface MoveItem {
  /** directory of the file, relative to the photo folder ('.' for the root) */
  directory: string;
  name: string;
}

export interface MoveError {
  name: string;
  error: string;
}

/**
 * Creates and renames folders and moves files inside the photo folder, like doing it by hand on the disk.
 * Same permission as uploading (Upload.minimumRole).
 * The DB is updated by the next indexing of the changed directories.
 */
export class FileEditManager {

  /** a folder name is a single, plain path segment */
  public static validateFolderName(name: string): string {
    const n = (name || '').trim();
    if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n) || n.length > 255) {
      throw new Error('Invalid folder name: ' + name);
    }
    return n;
  }

  /** the absolute path of a directory inside the photo folder (the folder itself included) */
  private static resolveDir(relativeDir: string): string {
    const imageFolder = path.resolve(ProjectPath.ImageFolder);
    const full = path.resolve(path.join(imageFolder, relativeDir || ''));
    if (full !== imageFolder && full.indexOf(imageFolder + path.sep) !== 0) {
      throw new Error('Invalid path: ' + relativeDir);
    }
    return full;
  }

  private static assertEnabled(): void {
    if (Config.Upload.enabled === false) {
      throw new Error('Upload is disabled');
    }
  }

  private static async isDirectory(p: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(p)).isDirectory();
    } catch (e) {
      return false;
    }
  }

  private static async exists(p: string): Promise<boolean> {
    try {
      await fs.promises.lstat(p);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** The sub folders of a directory, to pick a target for moving. */
  public async listFolders(relativeDir: string): Promise<string[]> {
    FileEditManager.assertEnabled();
    const full = FileEditManager.resolveDir(relativeDir);
    const entries = await fs.promises.readdir(full, {withFileTypes: true});
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  }

  public async createFolder(parent: string, name: string): Promise<string> {
    FileEditManager.assertEnabled();
    const folderName = FileEditManager.validateFolderName(name);
    const parentFull = FileEditManager.resolveDir(parent);
    if (!(await FileEditManager.isDirectory(parentFull))) {
      throw new Error('The parent folder does not exist: ' + parent);
    }
    const full = path.join(parentFull, folderName);
    if (await FileEditManager.exists(full)) {
      throw new FileAlreadyExists('Folder already exists: ' + folderName, folderName);
    }
    await fs.promises.mkdir(full);
    await ObjectManagers.getInstance().onDataChange(DiskManager.getDTOFromPath(parent || ''));
    return path.join(parent || '', folderName);
  }

  /** Returns the new relative path of the folder. */
  public async renameFolder(relativeDir: string, newName: string): Promise<string> {
    FileEditManager.assertEnabled();
    const folderName = FileEditManager.validateFolderName(newName);
    const normalized = path.normalize(relativeDir || '');
    const full = FileEditManager.resolveDir(normalized);
    if (full === path.resolve(ProjectPath.ImageFolder)) {
      throw new Error('The root folder can not be renamed.');
    }
    if (!(await FileEditManager.isDirectory(full))) {
      throw new Error('The folder does not exist: ' + relativeDir);
    }
    const parentRelative = path.dirname(normalized);
    const target = path.join(path.dirname(full), folderName);
    if (target === full) {
      return normalized;
    }
    if (await FileEditManager.exists(target)) {
      throw new FileAlreadyExists('Folder already exists: ' + folderName, folderName);
    }
    await fs.promises.rename(full, target);
    await ObjectManagers.getInstance().onDataChange(DiskManager.getDTOFromPath(parentRelative === '.' ? '' : parentRelative));
    return path.join(parentRelative === '.' ? '' : parentRelative, folderName);
  }

  /**
   * Moves files (with their sidecars) to an existing folder. Files that can not be moved are reported, the others are moved.
   */
  public async moveFiles(items: MoveItem[], targetDir: string): Promise<MoveError[]> {
    FileEditManager.assertEnabled();
    const targetFull = FileEditManager.resolveDir(targetDir);
    if (!(await FileEditManager.isDirectory(targetFull))) {
      throw new Error('The target folder does not exist: ' + targetDir);
    }
    const errors: MoveError[] = [];
    const changed = new Set<string>([path.normalize(targetDir || '')]);
    for (const item of items) {
      try {
        await this.moveFile(item, targetFull);
        changed.add(path.normalize(item.directory || ''));
      } catch (e) {
        errors.push({name: item.name, error: (e as Error).message});
      }
    }
    for (const dir of changed) {
      await ObjectManagers.getInstance().onDataChange(DiskManager.getDTOFromPath(dir === '.' ? '' : dir));
    }
    return errors;
  }

  private async moveFile(item: MoveItem, targetFull: string): Promise<void> {
    const name = item.name;
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name) || path.basename(name) !== name) {
      throw new Error('Invalid filename: ' + name);
    }
    const ext = UploadUtils.getExtension(name);
    // only what the gallery shows: no config files or anything else that sits in the folder
    if (!(SupportedFormats.Photos.includes(ext) || SupportedFormats.Videos.includes(ext) ||
      SupportedFormats.MetaFiles.includes(ext)) || ext === 'pg2conf') {
      throw new Error('Unsupported file format: ' + ext);
    }
    const sourceDir = FileEditManager.resolveDir(item.directory);
    const source = path.join(sourceDir, name);
    const dest = path.join(targetFull, name);
    if (sourceDir === targetFull) {
      throw new Error('The file is already in this folder.');
    }
    if (!(await FileEditManager.exists(source))) {
      throw new Error('File not found: ' + name);
    }
    if (await FileEditManager.exists(dest)) {
      throw new FileAlreadyExists('File already exists: ' + name, name);
    }

    // sidecars: "photo.jpg.xmp" belongs to this file, "photo.xmp" is shared with files of the same name (e.g.: raw + jpg)
    const sidecars: string[] = [];
    for (const s of [name + '.xmp', name + '.XMP']) {
      sidecars.push(s);
    }
    const base = name.substring(0, name.length - path.extname(name).length);
    const siblings = (await fs.promises.readdir(sourceDir)).filter(f =>
      f !== name && f.substring(0, f.length - path.extname(f).length) === base && !/\.xmp$/i.test(f));
    if (siblings.length === 0) {
      sidecars.push(base + '.xmp', base + '.XMP');
    }
    const sidecarMoves: { from: string, to: string }[] = [];
    for (const s of sidecars) {
      const from = path.join(sourceDir, s);
      const to = path.join(targetFull, s);
      if (await FileEditManager.exists(from) && !(await FileEditManager.exists(to))) {
        sidecarMoves.push({from, to});
      }
    }

    await fs.promises.rename(source, dest);
    for (const m of sidecarMoves) {
      await fs.promises.rename(m.from, m.to);
    }
  }
}
