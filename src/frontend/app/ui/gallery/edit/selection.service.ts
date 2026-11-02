import {Injectable, computed, inject, signal} from '@angular/core';
import {Config} from '../../../../../common/config/public/Config';
import {AuthenticationService} from '../../../model/network/authentication.service';
import {MediaDTO} from '../../../../../common/entities/MediaDTO';
import {Utils} from '../../../../../common/Utils';
import {MoveItem} from './file-edit.service';

/** The photos and videos the user selected in the gallery grid. */
@Injectable({providedIn: 'root'})
export class SelectionService {
  private authService = inject(AuthenticationService);
  private readonly items = signal<ReadonlyMap<string, MediaDTO>>(new Map());
  public readonly count = computed(() => this.items().size);
  public readonly active = computed(() => this.items().size > 0);

  /** 'a/./b/' -> 'a/b', the root ('.', './') -> '' */
  public static normalizeDir(dir: string): string {
    return (dir || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.').join('/');
  }

  public static dirOf(media: MediaDTO): string {
    return SelectionService.normalizeDir(Utils.concatUrls(media.directory.path, media.directory.name));
  }

  public static keyOf(media: MediaDTO): string {
    return SelectionService.dirOf(media) + '\u0000' + media.name;
  }

  /** Same permission as the upload. */
  public canEdit(): boolean {
    return Config.Upload.enabled &&
      this.authService.isAuthenticated() &&
      this.authService.user.value.role >= Config.Upload.minimumRole;
  }

  public isSelected(media: MediaDTO): boolean {
    return this.items().has(SelectionService.keyOf(media));
  }

  public toggle(media: MediaDTO): void {
    const next = new Map(this.items());
    const key = SelectionService.keyOf(media);
    if (!next.delete(key)) {
      next.set(key, media);
    }
    this.items.set(next);
  }

  public selectAll(media: MediaDTO[]): void {
    const next = new Map(this.items());
    for (const m of media) {
      next.set(SelectionService.keyOf(m), m);
    }
    this.items.set(next);
  }

  public allSelected(media: MediaDTO[]): boolean {
    return media.length > 0 && media.every((m) => this.isSelected(m));
  }

  public clear(): void {
    if (this.items().size > 0) {
      this.items.set(new Map());
    }
  }

  public toMoveItems(): MoveItem[] {
    return Array.from(this.items().values()).map((m) => ({
      directory: SelectionService.dirOf(m),
      name: m.name
    }));
  }
}
