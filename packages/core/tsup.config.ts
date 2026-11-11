import { defineConfig } from 'tsup';
import fs from'fs';
// Identify which build we're running using an environment variable
const isWorkerBuild = process.env.BUILD_TARGET === 'worker';

let config: any = undefined
if (isWorkerBuild) {

    config = defineConfig(
        // First config for worker
        {
            entry: {
                worker: 'src/worker-entry.ts'
            },
            format: ['iife'],
            globalName: 'OpenWebContainer',
            // minify: true,
            platform: 'browser',
            bundle: true,
            sourcemap: true,
            outDir: 'dist',
            onSuccess: async () => {
                const workerCode = fs.readFileSync('dist/worker.global.js', 'utf-8');
                /* The guest snippets are joined into one IIFE. A bundle built
                   from two source revisions can join a loader that lacks
                   settleIO to a buffer-fs and globals that call it; the first
                   async readdir then dies inside a package the user installed
                   with a bare ReferenceError, far from the mixed join that
                   caused it. Refuse to emit that bundle and name the missing
                   piece before src/generated/worker-code.ts is written. */
                const settleIODefinitions = (workerCode.match(/function settleIO\(/g) ?? []).length;
                if (settleIODefinitions !== 1) {
                    process.stderr.write(
                        'mixed guest bundle: expected exactly one function settleIO( definition in dist/worker.global.js, found ' +
                        settleIODefinitions + '\n' +
                        'Rebuild every guest snippet from one source revision: pnpm build:worker && pnpm build:main in packages/core.\n'
                    );
                    process.exit(1);
                }
                fs.writeFileSync(
                    'src/generated/worker-code.ts',
                    `// Generated file - do not edit\nexport default ${JSON.stringify(workerCode)};\n`
                );
            }
        })
} else {
    // Second config for main package
    config = defineConfig(
        {
            entry: {
                index: 'src/index.ts',
                'worker-code': 'src/generated/worker-code.ts'
            },
            format: ['esm', 'cjs'],
            dts: true,
            clean: false,
            sourcemap: true
        }
    )
}
export default config;
