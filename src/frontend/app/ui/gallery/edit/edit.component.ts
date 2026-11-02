import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Router} from '@angular/router';
import {NgIconComponent} from '@ng-icons/core';
import {MediaDTO} from '../../../../../common/entities/MediaDTO';
import {Utils} from '../../../../../common/Utils';
import {FileEditService} from './file-edit.service';
import {SelectionService} from './selection.service';

/** The toolbar of the selected photos and the dialogs: new folder, rename folder, move to folder. */
@Component({
  selector: 'app-gallery-edit',
  templateUrl: './edit.component.html',
  styleUrl: './edit.component.css',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FormsModule, NgIconComponent],
  host: {'(document:keydown.escape)': 'onEscape()'}
})
export class GalleryEditComponent {
  public readonly selection = inject(SelectionService);
  public readonly edit = inject(FileEditService);
  private router = inject(Router);

  /** All the media on the page, for "select all" */
  readonly media = input<MediaDTO[]>([]);

  name = '';
  busy = false;
  error = '';

  // folder picker of the move dialog
  readonly browsePath = signal('');
  readonly folders = signal<string[]>([]);
  readonly browseLabel = computed(() => this.browsePath() || '/');

  constructor() {
    effect(() => {
      const d = this.edit.dialog();
      this.error = '';
      this.busy = false;
      this.name = d?.type === 'rename' ? d.name : '';
      if (d?.type === 'move') {
        this.browse(this.edit.currentDirectory() || '').catch(console.error);
      }
    });
    // a selection is only meaningful on the page it was made
    this.router.events.subscribe((e) => {
      if ((e as { type?: number }).type === 1 /* NavigationEnd */ && this.selection.active()) {
        if (!(e as { url?: string }).url?.includes('media=')) { // opening the lightbox keeps it
          this.selection.clear();
        }
      }
    });
  }

  get allSelected(): boolean {
    return this.selection.allSelected(this.media());
  }

  toggleAll(): void {
    if (this.allSelected) {
      this.selection.clear();
    } else {
      this.selection.selectAll(this.media());
    }
  }

  async browse(path: string): Promise<void> {
    try {
      this.folders.set(await this.edit.listFolders(path));
      this.browsePath.set(path);
      this.error = '';
    } catch (e) {
      this.error = this.message(e);
    }
  }

  up(): void {
    const parts = this.browsePath().split('/').filter(Boolean);
    parts.pop();
    this.browse(parts.join('/')).catch(console.error);
  }

  enter(folder: string): void {
    this.browse(Utils.concatUrls(this.browsePath(), folder).replace(/\/$/, '')).catch(console.error);
  }

  async submit(): Promise<void> {
    const d = this.edit.dialog();
    if (!d || this.busy) {
      return;
    }
    this.busy = true;
    this.error = '';
    try {
      if (d.type === 'newFolder') {
        const created = await this.edit.createFolder(d.parent, this.name.trim());
        this.edit.closeDialog();
        await this.router.navigate(['/gallery', created.replace(/\\/g, '/')]);
      } else if (d.type === 'rename') {
        await this.edit.renameFolder(d.path, this.name.trim());
        this.edit.closeDialog();
      } else {
        await this.edit.moveSelected(this.browsePath());
        this.edit.closeDialog();
      }
    } catch (e) {
      this.error = this.message(e);
    } finally {
      this.busy = false;
    }
  }

  onEscape(): void {
    if (this.edit.dialog()) {
      this.edit.closeDialog();
    } else {
      this.selection.clear();
    }
  }

  private message(e: unknown): string {
    return (e as { message?: string })?.message || String(e);
  }
}
