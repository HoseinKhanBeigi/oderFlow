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
      'sim-live.bundle': join(root, 'simulator/live-embed.ts'),
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
    return;
  }
  await esbuild.build(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildSimulator(process.argv.includes('--watch'));
}
