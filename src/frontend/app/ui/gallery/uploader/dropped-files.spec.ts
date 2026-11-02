import {collectEntries, entriesFromPicker, getDroppedRoots} from './dropped-files';

const fileEntry = (name: string): FileSystemEntry => ({
  isFile: true, isDirectory: false, name,
  file: (ok: (f: File) => void): void => ok(new File(['x'], name))
} as unknown as FileSystemEntry);

// returns the children in batches, like browsers do (about 100 per call)
const dirEntry = (name: string, children: FileSystemEntry[], batch = 2): FileSystemEntry => ({
  isFile: false, isDirectory: true, name,
  createReader: (): unknown => {
    let i = 0;
    return {
      readEntries: (ok: (e: FileSystemEntry[]) => void): void => {
        const part = children.slice(i, i + batch);
        i += batch;
        ok(part);
      }
    };
  }
} as unknown as FileSystemEntry);

describe('dropped files', () => {
  it('should walk folders recursively, with batched reads, and keep the folder of every file', async () => {
    const tree = dirEntry('Holiday', [
      fileEntry('1.jpg'), fileEntry('2.jpg'), fileEntry('3.jpg'),
      dirEntry('Day 1', [fileEntry('4.jpg'), dirEntry('Deep', [fileEntry('5.jpg')])]),
    ]);
    const entries = await collectEntries({entries: [tree], files: [new File(['x'], 'loose.jpg')]});
    expect(entries.map(e => e.relativeDir + '|' + e.file.name).sort()).toEqual([
      '|loose.jpg', 'Holiday/Day 1/Deep|5.jpg', 'Holiday/Day 1|4.jpg', 'Holiday|1.jpg', 'Holiday|2.jpg', 'Holiday|3.jpg'
    ].sort());
  });

  it('should read the dropped items synchronously, folders as entries and files as files', () => {
    const folder = dirEntry('F', []);
    const loose = new File(['x'], 'a.jpg');
    const dt = {
      items: [
        {kind: 'file', webkitGetAsEntry: (): unknown => folder, getAsFile: (): unknown => null},
        {kind: 'file', webkitGetAsEntry: (): unknown => null, getAsFile: (): unknown => loose},
        {kind: 'string', webkitGetAsEntry: (): unknown => null, getAsFile: (): unknown => null},
      ],
      files: []
    } as unknown as DataTransfer;
    const roots = getDroppedRoots(dt);
    expect(roots.entries).toEqual([folder]);
    expect(roots.files).toEqual([loose]);
  });

  it('should fall back to the file list when folders are not supported', () => {
    const f = new File(['x'], 'a.jpg');
    const roots = getDroppedRoots({items: [], files: [f]} as unknown as DataTransfer);
    expect(roots.files).toEqual([f]);
  });

  it('should take the folder from the path of the picked files', () => {
    const f = new File(['x'], 'a.jpg');
    Object.defineProperty(f, 'webkitRelativePath', {value: 'Holiday/Day 1/a.jpg'});
    const g = new File(['x'], 'b.jpg');
    expect(entriesFromPicker([f, g]).map(e => e.relativeDir)).toEqual(['Holiday/Day 1', '']);
  });
});
