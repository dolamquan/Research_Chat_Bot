import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const own = path.join(root, 'node_modules/vite/package.json');
const require = createRequire(existsSync(own) ? path.join(root, 'package.json') : path.join(root, '../frontend/package.json'));
const command = process.argv[2] || 'dev';
let binary, args;
if (command === 'typecheck') {
  binary = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  args = ['--noEmit', '-p', path.join(root, 'tsconfig.json')];
} else if (command === 'test') {
  binary = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  args = ['run', '--config', path.join(root, 'vitest.config.ts')];
} else {
  binary = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  args = [command === 'dev' ? root : command, ...(command === 'dev' ? [] : [root]), '--config', path.join(root, 'vite.config.ts')];
}
const child = spawn(process.execPath, [binary, ...args, ...process.argv.slice(3)], { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 1));
child.on('error', error => { console.error(error.message); process.exit(1); });
