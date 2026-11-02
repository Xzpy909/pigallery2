// Reads the files of dropped (or picked) folders, with the folder they are in.

export interface UploadEntry {
  file: File;
  /** The folder of the file inside the folder that is uploaded to, without leading and trailing slash. '' for a plain file. */
  relativeDir: string;
}

export interface DroppedRoots {
  entries: FileSystemEntry[];
  files: File[];
}

/**
 * The dropped items are only valid during the drop event, so read them synchronously,
 * and walk the folders (collectEntries) afterwards.
 */
export const getDroppedRoots = (dataTransfer: DataTransfer): DroppedRoots => {
  const roots: DroppedRoots = {entries: [], files: []};
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  if (items.length === 0 || typeof items[0].webkitGetAsEntry !== 'function') {
    roots.files = Array.from(dataTransfer.files || []);
    return roots;
  }
  for (const item of items) {
    if (item.kind !== 'file') {
      continue;
    }
    const entry = item.webkitGetAsEntry();
    if (entry) {
      roots.entries.push(entry);
    } else {
      const file = item.getAsFile();
      if (file) {
        roots.files.push(file);
      }
    }
  }
  return roots;
};

const readAllEntries = async (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries returns the entries in batches (about 100) until it returns an empty one
  for (; ;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) {
      return all;
    }
    all.push(...batch);
  }
};

const walk = async (entry: FileSystemEntry, dir: string, out: UploadEntry[]): Promise<void> => {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({file, relativeDir: dir});
  } else if (entry.isDirectory) {
    const sub = dir ? dir + '/' + entry.name : entry.name;
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await walk(child, sub, out);
    }
  }
};

export const collectEntries = async (roots: DroppedRoots): Promise<UploadEntry[]> => {
  const out: UploadEntry[] = roots.files.map(file => ({file, relativeDir: ''}));
  for (const entry of roots.entries) {
    await walk(entry, '', out);
  }
  return out;
};

/** Files of an <input type="file" webkitdirectory>: webkitRelativePath is "Folder/sub/name.jpg". */
export const entriesFromPicker = (files: FileList | File[]): UploadEntry[] =>
  Array.from(files).map(file => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const i = rel.lastIndexOf('/');
    return {file, relativeDir: i > 0 ? rel.substring(0, i) : ''};
  });
