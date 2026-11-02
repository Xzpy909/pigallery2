import {TestBed} from '@angular/core/testing';
import {SelectionService} from './selection.service';
import {AuthenticationService} from '../../../model/network/authentication.service';
import {MediaDTO} from '../../../../../common/entities/MediaDTO';

describe('SelectionService', () => {
  const media = (name: string, path = './', dir = 'Trip'): MediaDTO =>
    ({name, directory: {path, name: dir}} as MediaDTO);

  let s: SelectionService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{provide: AuthenticationService, useValue: {isAuthenticated: () => false}}]
    });
    s = TestBed.inject(SelectionService);
  });

  it('toggles and counts', () => {
    const a = media('a.jpg');
    expect(s.active()).toBe(false);
    s.toggle(a);
    expect(s.active()).toBe(true);
    expect(s.count()).toBe(1);
    expect(s.isSelected(media('a.jpg'))).toBe(true);
    s.toggle(a);
    expect(s.active()).toBe(false);
  });

  it('selects all and clears', () => {
    const all = [media('a.jpg'), media('b.jpg')];
    s.selectAll(all);
    expect(s.allSelected(all)).toBe(true);
    expect(s.count()).toBe(2);
    s.clear();
    expect(s.count()).toBe(0);
    expect(s.allSelected([])).toBe(false);
  });

  it('tells apart files with the same name in different folders', () => {
    s.toggle(media('a.jpg', './', 'One'));
    expect(s.isSelected(media('a.jpg', './', 'Two'))).toBe(false);
  });

  it('builds move items with normalized folders', () => {
    s.toggle(media('a.jpg', './Holiday/', 'Day 1'));
    s.toggle(media('r.jpg', '.', '.'));
    expect(s.toMoveItems()).toEqual([
      {directory: 'Holiday/Day 1', name: 'a.jpg'},
      {directory: '', name: 'r.jpg'},
    ]);
  });

  it('normalizes folder paths', () => {
    expect(SelectionService.normalizeDir('./a//b/./')).toBe('a/b');
    expect(SelectionService.normalizeDir('.')).toBe('');
    expect(SelectionService.normalizeDir('./')).toBe('');
  });
});
