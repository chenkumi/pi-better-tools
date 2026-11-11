import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ToolError } from '../../../shared/src/tool-error/index.ts';
import type { ImageInfo } from './images.ts';

export interface OutputTarget { root: string; dir: string }
export interface SavedFile { path: string; bytes: number; sha256: string; mime: ImageInfo['mime']; width?: number; height?: number }

/**
 * The project's output directory, created one segment at a time: any existing segment that is a link or not a directory
 * is refused, so a link can never move the files outside the project. `root` is the real project directory.
 */
export async function prepareOutputDir(cwd: string, relativeDir: string, create = true): Promise<OutputTarget> {
  const root = await realpath(cwd);
  let current = root;
  for (const segment of relativeDir.split('/')) {
    current = join(current, segment);
    let info = await lstat(current).catch(() => undefined);
    if (!info && !create) return { root, dir: current }; // validated so far; nothing below exists yet and nothing is created
    if (!info) {
      await mkdir(current).catch(error => { if ((error as { code?: string }).code !== 'EEXIST') throw new ToolError('IMAGE_OUTPUT_DIR', 'The output directory could not be created.'); });
      info = await lstat(current).catch(() => undefined);
    }
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new ToolError('IMAGE_OUTPUT_DIR', `The output directory is not usable: "${relativeDir}" must be a real directory inside the project (no links).`);
  }
  const real = await realpath(current);
  if (!samePath(real, current) || (real !== root && !real.startsWith(root + sep))) throw new ToolError('IMAGE_OUTPUT_DIR', 'The output directory resolves outside the project.');
  return { root, dir: real };
}

/** Windows and macOS file systems ignore case, and realpath returns the on-disk spelling. */
const samePath = (a: string, b: string) => a === b || (process.platform !== 'linux' && a.toLowerCase() === b.toLowerCase());

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Adds files only (`wx`): a name that exists is never replaced. Files of a failed save are removed again. */
export async function saveImages(target: OutputTarget, images: ReadonlyArray<{ bytes: Buffer; info: ImageInfo }>, now: Date): Promise<SavedFile[]> {
  const saved: SavedFile[] = [];
  const created: string[] = [];
  try {
    for (const [index, image] of images.entries()) {
      let file = '';
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      for (let attempt = 1; attempt <= 99 && !handle; attempt++) {
        file = join(target.dir, `IMG-${stamp(now)}-${index + 1}${attempt > 1 ? `-${attempt}` : ''}.${image.info.ext}`);
        try { handle = await open(file, 'wx'); }
        catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; }
      }
      if (!handle) throw new ToolError('IMAGE_OUTPUT_DIR', 'No free file name in the output directory.');
      created.push(file);
      try { await handle.writeFile(image.bytes); } finally { await handle.close(); }
      saved.push({
        path: relative(target.root, file).split(sep).join('/'), bytes: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex'), mime: image.info.mime,
        ...(image.info.width ? { width: image.info.width, height: image.info.height } : {}),
      });
    }
  } catch (error) {
    for (const file of created) await unlink(file).catch(() => undefined);
    if (error instanceof ToolError) throw error;
    throw new ToolError('IMAGE_OUTPUT_DIR', 'The image could not be written to the output directory.');
  }
  return saved;
}
