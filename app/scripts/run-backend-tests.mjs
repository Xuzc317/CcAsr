/*
 * 跨平台调用后端测试（Windows / macOS / Linux 通用）。
 *
 * 为什么不用 npm script 直接写命令：
 *   "cd .. && .venv/Scripts/python.exe ..." 只适用于 Windows，
 *   换成 bin/python 又只适用 Unix。这里用 node 探测解释器路径。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');

const CANDIDATES = [
  path.join(ROOT, '.venv', 'Scripts', 'python.exe'),  // Windows
  path.join(ROOT, '.venv', 'bin', 'python'),          // macOS / Linux
];

const py = CANDIDATES.find((p) => existsSync(p));
if (!py) {
  console.error('未找到虚拟环境 Python，请先执行 `uv sync`。已尝试：');
  for (const c of CANDIDATES) console.error('  ' + c);
  process.exit(1);
}

const runner = path.join(ROOT, 'backend', 'tests', 'run_all.py');
const r = spawnSync(py, [runner], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});

process.exit(r.status ?? 1);
