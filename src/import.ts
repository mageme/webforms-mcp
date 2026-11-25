/**
 * Reading a file the model asked for is a different kind of trust than talking to the store: store
 * credentials say nothing about which files on this machine may be read. So an import file must live
 * under a directory the operator nominated, be an ordinary file, and — the part that is easy to get
 * wrong — the bytes that are hashed must be the bytes that are sent.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { configDir } from './config.js';

export class ImportFileError extends Error {
  /** True when the file is not in this directory at all (missing, or named outside it), as opposed to being there and unusable. */
  constructor(message: string, readonly absent = false) {
    super(message);
  }
}

/** Raw bytes per request: base64 grows by a third, and the store refuses bodies over 2 MB. */
export const CHUNK_BYTES = 1_000_000;
export const FILE_BYTES_MAX = 64 * 1024 * 1024;

/** Refusing to follow a link at open time is what makes the check above hold at read time. */
const NOFOLLOW = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;

export const importRoot = (): string =>
  resolve(process.env.WEBFORMS_MCP_IMPORT_ROOT ?? join(configDir(), 'import'));

/** Each store stages its own files: the same name and digest must not be confirmable against another. */
export const siteImportRoot = (siteKey: string): string => join(importRoot(), siteKey);

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export interface ImportFile {
  path: string;
  size: number;
  digest: string;
  /** The one open file this import reads from, start to finish. */
  handle: FileHandle;
}

/**
 * Opens the file once, and keeps that handle. Everything afterwards — the size, the digest, the bytes
 * that go to the store — comes from this descriptor, so a path swapped for a symlink between the
 * check and the read has nothing to swap: the descriptor still points at the file that was checked.
 */
const openFromRoot = async (raw: string, root: string, sharedOnly: boolean): Promise<ImportFile> => {
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new ImportFileError(`The import directory ${root} does not exist. Create it, or point WEBFORMS_MCP_IMPORT_ROOT at the directory holding the file.`, true);
  }
  if (!within(rootReal, candidate) && !within(root, candidate)) {
    throw new ImportFileError(`Import files are read from ${root} only; ${candidate} is outside it.`, true);
  }
  // The shared root is only a migration path for files staged before stores had their own inbox, so it
  // holds loose files and never reaches down into a sibling store's directory.
  if (sharedOnly && dirname(candidate) !== root && dirname(candidate) !== rootReal) {
    throw new ImportFileError(`${candidate} is not in this store's import directory.`);
  }

  let handle: FileHandle;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new ImportFileError(`${candidate} is a symbolic link; import files must be ordinary files.`);
    if (code === 'ENOENT') throw new ImportFileError(`No such file: ${candidate}`, true);
    throw new ImportFileError(`${candidate} cannot be read: ${code ?? String(e)}`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new ImportFileError(`${candidate} is not an ordinary file.`);
    if (stats.size === 0) throw new ImportFileError(`${candidate} is empty.`);
    if (stats.size > FILE_BYTES_MAX) throw new ImportFileError(`${candidate} is larger than the ${FILE_BYTES_MAX} byte limit.`);

    // Where the opened file really lives, in case a parent directory was a link.
    const real = await realpath(candidate);
    if (!within(rootReal, real)) throw new ImportFileError(`${candidate} resolves outside ${root}.`);

    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { path: real, size: stats.size, digest: hash.digest('hex'), handle };
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
};

/**
 * Streams the same descriptor the digest was taken from, in pieces the store will accept.
 */
/**
 * Reads a staged import file. A store looks in its own inbox first; the shared root beneath it stays
 * readable for files that were put there before stores had inboxes of their own, but only while the process
 * serves one store: with several, a file in the shared root says nothing about which store it was meant for.
 */
export const openImportFile = async (raw: string, siteKey?: string, sharedRoot = true): Promise<ImportFile> => {
  if (siteKey === undefined) return openFromRoot(raw, importRoot(), false);
  const siteRoot = siteImportRoot(siteKey);
  // O_NOFOLLOW guards the file itself, and realpath would happily resolve a linked directory: without
  // this, import/<site> pointing at a sibling would let one store read another store's staged files.
  try {
    if ((await lstat(siteRoot)).isSymbolicLink()) {
      throw new ImportFileError(`${siteRoot} is a symbolic link; a store's import directory must be a real directory.`);
    }
  } catch (e) {
    if (e instanceof ImportFileError) throw e;
    // no such directory yet: fall through to the shared root
  }
  try {
    return await openFromRoot(raw, siteRoot, false);
  } catch (e) {
    // Only a file the store's directory does not have is looked for in the shared root; one it has and cannot use is reported as it is.
    if (!(e instanceof ImportFileError) || !e.absent) throw e;
    if (!sharedRoot) throw new ImportFileError(`${e.message} This process serves several stores, so the shared import directory is not read for any of them: put the file in ${siteRoot}.`);
    return openFromRoot(raw, importRoot(), true);
  }
};

export const readChunks = async function* (file: ImportFile): AsyncGenerator<string> {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = 0;
  while (position < file.size) {
    const { bytesRead } = await file.handle.read(buffer, 0, CHUNK_BYTES, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead).toString('base64');
  }
  if (position !== file.size) {
    throw new ImportFileError('The import file changed while it was being read; the upload was abandoned.');
  }
};

export const closeImportFile = async (file: ImportFile): Promise<void> => {
  await file.handle.close().catch(() => undefined);
};
