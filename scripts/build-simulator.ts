import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildSimulator(watch = false): Promise<void> {
  const options: esbuild.BuildOptions = {
    absWorkingDir: root,
    entryPoints: {
      'lab.bundle': join(root, 'simulator/boot.ts'),
      'backtest.worker': join(root, 'simulator/backtest.worker.ts'),
      'scenario.worker': join(root, 'simulator/scenario.worker.ts'),
    },
    outdir: join(root, 'public'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    const sweepCtx = await esbuild.context(sweepOptions());
    await sweepCtx.watch();
    return;
  }
  await esbuild.build(options);
  await esbuild.build(sweepOptions());
}

function sweepOptions(): esbuild.BuildOptions {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, 'src/footprint/sweep.ts')],
    outfile: join(root, 'public/sweep.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'warning',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildSimulator(process.argv.includes('--watch'));
}
