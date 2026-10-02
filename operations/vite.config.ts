import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const packagePath = existsSync(path.join(root, 'node_modules/vite')) ? path.join(root, 'package.json') : path.join(root, '../frontend/package.json');
const require = createRequire(packagePath);
const react = require('@vitejs/plugin-react').default;
const dependencies = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'lucide-react', 'recharts', '@supabase/supabase-js'];
function moduleEntry(name: string) {
  if (['lucide-react', 'recharts', '@supabase/supabase-js'].includes(name)) {
    const location = require.resolve(name + '/package.json');
    const pkg = require(location);
    if (pkg.module) return path.resolve(path.dirname(location), pkg.module);
  }
  return require.resolve(name);
}

export default {
  root,
  envDir: path.join(root, '../frontend'),
  plugins: [react()],
  resolve: { alias: dependencies.map(name => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: moduleEntry(name) })) },
  server: {
    host: '127.0.0.1', port: 5174, strictPort: true,
    fs: { allow: [path.join(root, '..')] },
    proxy: { '/api': { target: process.env.OPS_API_TARGET || 'http://127.0.0.1:8002', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } },
  },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': { target: process.env.OPS_API_TARGET || 'http://127.0.0.1:8002', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } } },
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { output: { manualChunks(id: string) {
    if (id.includes('node_modules') && /recharts|d3-|victory|decimal\.js|react-smooth/.test(id)) return 'charts';
    if (id.includes('node_modules') && id.includes('@supabase')) return 'auth';
  } } } },
};
