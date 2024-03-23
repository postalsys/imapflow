import { defineConfig } from 'tsup';

export default defineConfig({
    entryPoints: ['lib/index.ts'],
    format: ['cjs'],
    target: 'node20',
    outDir: 'build'
});
