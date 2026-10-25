// Build ES modules and CommonJS from one source: dist/esm (with types) and dist/cjs.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')
rmSync('dist', { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--module', 'CommonJS', '--moduleResolution', 'Node10', '--outDir', 'dist/cjs', '--declaration', 'false'], { stdio: 'inherit' })
mkdirSync('dist/cjs', { recursive: true })
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n')
console.log('built dist/esm and dist/cjs')
