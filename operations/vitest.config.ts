import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(existsSync(path.join(root, 'node_modules/vitest')) ? path.join(root, 'package.json') : path.join(root, '../frontend/package.json'));
export default { root, resolve: { alias: { vitest: path.join(path.dirname(require.resolve('vitest/package.json')), 'dist/index.js') } }, test: { environment: 'node', include: ['src/**/*.test.ts'] } };
