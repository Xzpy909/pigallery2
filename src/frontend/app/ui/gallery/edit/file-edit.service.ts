import {Injectable, inject, signal} from '@angular/core';
import {NetworkService} from '../../../model/network/network.service';
import {NotificationService} from '../../../model/notification.service';
import {ContentLoaderService} from '../contentLoader.service';
import {Utils} from '../../../../../common/Utils';
import {SelectionService} from './selection.service';

export interface MoveItem {
  directory: string;
  name: string;
}

export interface MoveError {
  name: string;
  error: string;
}

export type EditDialog =
  | { type: 'newFolder'; parent: string }
  | { type: 'rename'; path: string; name: string }
  | { type: 'move' };

@Injectable({providedIn: 'root'})
export class FileEditService {
  private networkService = inject(NetworkService);
  private notificationService = inject(NotificationService);
  private contentLoader = inject(ContentLoaderService);
  private selection = inject(SelectionService);

  /** The dialog that is open right now. */
  public readonly dialog = signal<EditDialog | null>(null);

  /** Same permission as the upload. */
  public canEdit(): boolean {
    return this.selection.canEdit();
  }

  /** Current directory, only when a real directory (not a search result) is open. */
  public currentDirectory(): string | null {
    const dir = this.contentLoader.content.value.directory;
    return dir ? SelectionService.normalizeDir(Utils.concatUrls(dir.path, dir.name)) : null;
  }

  public openNewFolder(): void {
    const parent = this.currentDirectory();
    if (parent !== null) {
      this.dialog.set({type: 'newFolder', parent});
    }
  }

  public openRename(path: string, name: string): void {
    this.dialog.set({type: 'rename', path, name});
  }

  public openMove(): void {
    this.dialog.set({type: 'move'});
  }

  public closeDialog(): void {
    this.dialog.set(null);
  }

  public listFolders(directory: string): Promise<string[]> {
    return this.networkService.getJson<string[]>('/folders/' + encodeURIComponent(directory).replace(/%2F/g, '/'));
  }

  public async createFolder(parent: string, name: string): Promise<string> {
    const path = await this.networkService.postJson<string>('/folders/create', {parent, name});
    await this.contentLoader.reloadCurrentContent();
    return path;
  }

  public async renameFolder(path: string, name: string): Promise<string> {
    const newPath = await this.networkService.postJson<string>('/folders/rename', {path, name});
    await this.contentLoader.reloadCurrentContent();
    return newPath;
  }

  /** Moves the selected files. Files that could not be moved stay selected. */
  public async moveSelected(target: string): Promise<void> {
    const files = this.selection.toMoveItems();
    const errors = await this.networkService.postJson<MoveError[]>('/files/move', {files, target});
    this.selection.clear();
    if (errors.length > 0) {
      this.notificationService.error(
        $localize`${files.length - errors.length} moved, ${errors.length} failed:` + ' ' +
        errors.slice(0, 3).map((e) => e.name + ': ' + e.error).join('; '));
    } else {
      this.notificationService.success($localize`${files.length} items moved`);
    }
    await this.contentLoader.reloadCurrentContent();
  }
}
