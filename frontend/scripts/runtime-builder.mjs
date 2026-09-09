import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite'))('esbuild');
export async function compileRuntime(source) {
  const result=await build({stdin:{contents:source,resolveDir:resolve('src/app/components/visualization'),loader:'ts'},bundle:true,format:'esm',write:false});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
