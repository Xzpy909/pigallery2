import {ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Subscription} from 'rxjs';
import {NgIcon} from '@ng-icons/core';
import {FrameComponent} from '../frame/frame.component';
import {NetworkService} from '../../model/network/network.service';
import {ScheduledJobsService} from '../settings/scheduled-jobs.service';
import {PiTitleService} from '../../model/pi-title.service';
import {EncryptionStatusDTO} from '../../../../common/entities/EncryptionStatusDTO';
import {DefaultsJobs} from '../../../../common/entities/job/JobDTO';
import {JobProgressStates, OnTimerJobProgressDTO} from '../../../../common/entities/job/JobProgressDTO';

@Component({
  selector: 'app-encryption',
  templateUrl: './encryption.component.html',
  styleUrl: './encryption.component.css',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FrameComponent, FormsModule, NgIcon]
})
export class EncryptionComponent implements OnInit, OnDestroy {
  private networkService = inject(NetworkService);
  private jobsService = inject(ScheduledJobsService);
  private piTitleService = inject(PiTitleService);

  public status: EncryptionStatusDTO = null;
  public password = '';
  public busy = false;
  public error: string = null;
  public progress: OnTimerJobProgressDTO = null;
  public readonly jobName = DefaultsJobs[DefaultsJobs['Media Encryption']];
  private subscription: Subscription;

  ngOnInit(): void {
    this.piTitleService.setTitle($localize`Encrypt media files`);
    this.subscription = this.jobsService.progress.subscribe((all) => {
      this.progress = Object.values(all).find(p => p.jobName === this.jobName) || null;
    });
    this.jobsService.subscribeToProgress();
    this.jobsService.getAvailableJobs().catch(console.error);
    this.loadStatus().catch(console.error);
  }

  ngOnDestroy(): void {
    this.jobsService.unsubscribeFromProgress();
    this.subscription?.unsubscribe();
  }

  get running(): boolean {
    return this.progress?.state === JobProgressStates.running ||
      this.progress?.state === JobProgressStates.cancelling;
  }

  get finished(): boolean {
    return this.progress?.state === JobProgressStates.finished;
  }

  get failed(): boolean {
    return this.progress?.state === JobProgressStates.failed;
  }

  get canSetup(): boolean {
    return !!this.password && this.password.length >= (this.status?.minPasswordLength ?? 8);
  }

  async loadStatus(): Promise<void> {
    this.status = await this.networkService.getJson<EncryptionStatusDTO>('/admin/encryption/status');
  }

  /** First time: the password becomes the key, then everything is encrypted. */
  async setup(): Promise<void> {
    this.busy = true;
    this.error = null;
    try {
      await this.networkService.postJson('/admin/encryption/setup', {password: this.password});
      this.password = '';
      await this.loadStatus();
      await this.jobsService.getAvailableJobs();
      await this.jobsService.start(this.jobName);
    } catch (e) {
      this.error = (e as { message?: string })?.message || $localize`Could not start the encryption.`;
    } finally {
      this.busy = false;
    }
  }

  /** Encrypts the files that are not encrypted yet. */
  async encrypt(): Promise<void> {
    this.busy = true;
    this.error = null;
    try {
      await this.jobsService.start(this.jobName);
    } catch (e) {
      this.error = (e as { message?: string })?.message || $localize`Could not start the encryption.`;
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    await this.jobsService.stop(this.jobName);
  }
}
