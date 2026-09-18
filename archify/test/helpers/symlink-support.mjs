import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Windows file symlinks require a privilege that is not present on every host.
// Probe it instead of skipping Windows wholesale; directory tests use junctions.
export function fileSymlinkSkip() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-symlink-probe-'));
  try {
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'link'), 'file');
    return false;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return `File symlinks unavailable: ${error.code}`;
    throw error;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
