import type {Mocked} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {HttpEventType} from '@angular/common/http';
import {BehaviorSubject, Subject} from 'rxjs';
import {UploaderService} from './uploader.service';
import {NetworkService} from '../../../model/network/network.service';
import {NotificationService} from '../../../model/notification.service';
import {AuthenticationService} from '../../../model/network/authentication.service';
import {ContentLoaderService} from '../contentLoader.service';
import {ToastService} from '../../toast/toast.service';
import {Config} from '../../../../../common/config/public/Config';
import {UserRoles} from '../../../../../common/entities/UserDTO';

class MockNetworkService {
  requests: Subject<unknown>[] = [];

  forms: FormData[] = [];
  urls: string[] = [];

  postFormData(url?: string, form?: FormData): Subject<unknown> {
    const request = new Subject<unknown>();
    this.requests.push(request);
    this.forms.push(form);
    this.urls.push(url);
    return request;
  }
}

class MockContentLoaderService {
  content = new BehaviorSubject({directory: {path: '.', name: 'Balaton', media: [{name: 'exists.jpg'}], metaFile: []}});
  reloadCurrentContent = vi.fn().mockResolvedValue(undefined);
}

class MockAuthenticationService {
  user = new BehaviorSubject({name: 'admin', role: UserRoles.Admin});

  isAuthenticated(): boolean {
    return !!this.user.value;
  }
}

describe('UploaderService', () => {
  let service: UploaderService;
  let toasts: ToastService;
  let network: MockNetworkService;
  let notification: Mocked<NotificationService>;
  let uploadEnabled: boolean;

  const file = (name: string): File => new File(['x'], name);
  const finish = (i: number): void => {
    network.requests[i].next({type: HttpEventType.Response, body: {result: []}});
    network.requests[i].complete();
  };
  const fail = (i: number): void => network.requests[i].error({message: 'Disk full'});
  const toast = (title: string) => toasts.toasts().find((t) => t.title === title);

  beforeEach(() => {
    uploadEnabled = Config.Upload.enabled;
    Config.Upload.enabled = true;
    network = new MockNetworkService();
    notification = {success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn()} as unknown as Mocked<NotificationService>;
    TestBed.configureTestingModule({
      providers: [
        {provide: NetworkService, useValue: network},
        {provide: NotificationService, useValue: notification},
        {provide: AuthenticationService, useClass: MockAuthenticationService},
        {provide: ContentLoaderService, useClass: MockContentLoaderService}
      ]
    });
    service = TestBed.inject(UploaderService);
    toasts = TestBed.inject(ToastService);
  });

  afterEach(() => {
    Config.Upload.enabled = uploadEnabled;
    vi.useRealTimers();
  });

  it('should show the progress of each file at the bottom right', async () => {
    await service.uploadFiles([file('Tihany.jpg'), file('Hévíz.jpg')]);
    expect(toast('Tihany.jpg')).toEqual(expect.objectContaining({type: 'progress', text: '0%', placement: 'bottom-right'}));
    expect(toast('Hévíz.jpg')).toEqual(expect.objectContaining({type: 'progress', text: 'Queued', closable: false}));
    network.requests[0].next({type: HttpEventType.UploadProgress, loaded: 45, total: 100});
    expect(toast('Tihany.jpg')).toEqual(expect.objectContaining({progress: 45, text: '45%'}));
  });

  it('should hide a successful file after a while and report the batch', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    finish(0);
    expect(toast('Tihany.jpg').type).toBe('success');
    expect(notification.success).toHaveBeenCalledWith('Uploaded files: 1', 'Upload completed.');
    await vi.advanceTimersByTimeAsync(ToastService.TIMEOUT);
    expect(toast('Tihany.jpg')).toBeUndefined();
  });

  it('should keep a failed file until it is closed and report errors in the batch', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg'), file('Hévíz.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    fail(0);
    finish(1);
    expect(toast('Tihany.jpg')).toEqual(expect.objectContaining({type: 'error', text: 'Disk full', closable: true}));
    expect(notification.warning).toHaveBeenCalledWith('Uploaded: 1, failed: 1', 'Upload completed with errors');
    await vi.advanceTimersByTimeAsync(60000);
    expect(toast('Tihany.jpg')).toBeDefined();
  });

  it('should report a batch where everything failed', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    fail(0);
    expect(notification.error).toHaveBeenCalledWith('Failed files: 1', 'Upload failed.');
  });

  it('should cancel a queued file without sending it', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg'), file('Hévíz.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    toast('Hévíz.jpg').onCancel();
    expect(toast('Hévíz.jpg')).toBeUndefined();
    finish(0);
    expect(network.requests.length).toBe(1);
    expect(notification.success).toHaveBeenCalledWith('Uploaded files: 1', 'Upload completed.');
  });

  it('should abort a file while it is sent and start the next one', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg'), file('Hévíz.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    network.requests[0].next({type: HttpEventType.UploadProgress, loaded: 30, total: 100});
    toast('Tihany.jpg').onCancel();
    expect(network.requests[0].observed).toBe(false); // unsubscribed: the request is aborted
    expect(toast('Tihany.jpg')).toBeUndefined();
    expect(network.requests.length).toBe(2);
    expect(toast('Hévíz.jpg').text).toBe('0%');
  });

  it('should not offer canceling once a file is sent completely', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(toast('Tihany.jpg').onCancel).toBeDefined();
    network.requests[0].next({type: HttpEventType.UploadProgress, loaded: 100, total: 100});
    expect(toast('Tihany.jpg').onCancel).toBeUndefined();
    service.cancelAll();
    expect(network.requests[0].observed).toBe(true);
  });

  it('should cancel everything and say so', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('Tihany.jpg'), file('Hévíz.jpg'), file('Eger.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    service.cancelAll();
    expect(toasts.toasts().length).toBe(0);
    expect(network.requests.length).toBe(1); // the queued ones never started
    expect(notification.info).toHaveBeenCalledWith('Upload canceled.');
  });

  it('should warn about an existing file instead of failing it', async () => {
    vi.useFakeTimers();
    service.uploadFiles([file('exists.jpg')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(toast('exists.jpg')).toEqual(expect.objectContaining({type: 'warning', placement: 'bottom-right'}));
    expect(network.requests.length).toBe(0);
    await vi.advanceTimersByTimeAsync(ToastService.TIMEOUT);
    expect(toast('exists.jpg')).toBeUndefined();
  });

  it('should send the folder of a file, and show it in the title', async () => {
    vi.useFakeTimers();
    service.uploadEntries([
      {file: file('a.jpg'), relativeDir: 'Holiday/Day 1'},
      {file: file('b.jpg'), relativeDir: ''},
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(toast('Holiday/Day 1/a.jpg')).toBeDefined();
    expect(network.forms[0].get('relativeDir')).toBe('Holiday/Day 1');
    expect((network.forms[0].get('files') as File).name).toBe('a.jpg');
    expect(network.urls[0]).toContain('Balaton');
  });

  it('should not skip a file in a new folder only because the current directory has one with the same name', async () => {
    vi.useFakeTimers();
    service.uploadEntries([{file: file('exists.jpg'), relativeDir: 'New'}]);
    await vi.advanceTimersByTimeAsync(0);
    expect(network.requests.length).toBe(1);
  });

  it('should treat a file that exists on the server as skipped, not failed', async () => {
    vi.useFakeTimers();
    service.uploadEntries([{file: file('a.jpg'), relativeDir: 'Old'}]);
    await vi.advanceTimersByTimeAsync(0);
    network.requests[0].next({
      type: HttpEventType.Response,
      body: {result: [{filename: 'a.jpg', error: 'File already exists: /x/a.jpg'}]}
    });
    network.requests[0].complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(toast('Old/a.jpg')).toEqual(expect.objectContaining({type: 'warning'}));
    expect(notification.error).not.toHaveBeenCalled();
  });

  describe('big batches', () => {
    const many = (n: number): File[] => Array.from({length: n}, (_, i) => file('p' + i + '.jpg'));

    it('should show one toast for the whole batch instead of one per file', async () => {
      vi.useFakeTimers();
      service.uploadFiles(many(UploaderService.BULK_THRESHOLD + 10));
      await vi.advanceTimersByTimeAsync(0);
      expect(toasts.toasts().length).toBe(1);
      expect(toasts.toasts()[0].title).toContain(String(UploaderService.BULK_THRESHOLD + 10));
      expect(toasts.toasts()[0].progress).toBe(0);
    });

    it('should show the overall progress, throttled, and close the toast when done', async () => {
      vi.useFakeTimers();
      const n = UploaderService.BULK_THRESHOLD + 10;
      service.uploadFiles(many(n));
      await vi.advanceTimersByTimeAsync(0);
      // one upload runs at a time at first: finish them one after the other
      for (let i = 0; i < n; i++) {
        finish(i);
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(300);
      expect(toasts.toasts().length).toBe(0);
      expect(notification.success).toHaveBeenCalled();
    });

    it('should keep individual toasts for a small batch', async () => {
      vi.useFakeTimers();
      service.uploadFiles(many(3));
      await vi.advanceTimersByTimeAsync(0);
      expect(toasts.toasts().length).toBe(3);
    });

    it('should not open a toast per failed file, but report the number', async () => {
      vi.useFakeTimers();
      const n = UploaderService.BULK_THRESHOLD + 1;
      service.uploadFiles(many(n));
      await vi.advanceTimersByTimeAsync(0);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (let i = 0; i < n; i++) {
        fail(i);
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(300);
      expect(toasts.toasts().length).toBe(0);
      expect(notification.error).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
