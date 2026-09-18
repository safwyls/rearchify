import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A Windows PATH may resolve bash to WSL, which cannot use the native fixture
// paths. Use tools shipped with the same native Git that creates the fixtures.
export function gitTool(name) {
  if (process.platform !== 'win32') return name;
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const tool = path.resolve(execPath, '../../..', name === 'bash' ? 'bin/bash.exe' : `usr/bin/${name}.exe`);
  if (!fs.existsSync(tool)) throw new Error(`Git for Windows tool unavailable: ${tool}`);
  return tool;
}
