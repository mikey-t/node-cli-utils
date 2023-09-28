import 'dotenv/config'
import { emptyDirectory, log, spawnAsync, spawnAsyncLongRunning, spawnDockerCompose } from './src/generalUtils.js'
import { series, parallel } from 'swig-cli'
import fsp from 'node:fs/promises'
import { config } from './src/NodeCliUtilsConfig.js'

config.traceEnabled = false

// Using direct paths to node_modules to skip the startup delay of using npm
const tscPath = './node_modules/typescript/lib/tsc.js'
const eslintPath = './node_modules/eslint/bin/eslint.js'
const typedocPath = './node_modules/typedoc/dist/lib/cli.js'
const c8Path = './node_modules/c8/bin/c8.js'
const loaderArgsTsx = ['--no-warnings', '--loader', 'tsx']
const loaderArgsTsNode = ['--no-warnings', '--loader', 'ts-node/esm']
const testFiles = [
  './test/generalUtils.test.ts',
  './test/findFilesRecursively.test.ts',
  './test/TarballUtility.test.ts',
]
const adminTestFiles = [
  './test/certUtils.test.ts' // Note that these tests only currently work on windows and are quite slow
]
const dockerComposePath = './docker-compose.yml'

export const build = series(cleanDist, parallel(buildEsm, series(buildCjs, copyCjsPackageJson)))
export const buildEsmOnly = series(cleanDist, buildEsm)
export const buildCjsOnly = series(cleanDist, buildCjs)

export async function lint() {
  await spawnAsync('node', [eslintPath, '--ext', '.ts', './src', './test'], { throwOnNonZero: true })
}

export async function genDocs() {
  await spawnAsync('node', [typedocPath], { throwOnNonZero: true })
}

export async function test(additionalTestFiles: string[] = []) {
  if ((await spawnAsync('node', [...loaderArgsTsx, '--test', ...testFiles, ...additionalTestFiles])).code !== 0) {
    throw new Error('Tests failed')
  }
}

export async function testAll() {
  await test(adminTestFiles)
}

export async function testWatch() {
  const args = [...loaderArgsTsx, '--test', '--watch', ...testFiles]
  if ((await spawnAsyncLongRunning('node', args)).code !== 0) {
    throw new Error('Tests failed')
  }
}

export async function testOnly() {
  const args = [...loaderArgsTsx, '--test-only', '--test', ...testFiles]
  if ((await spawnAsync('node', args)).code !== 0) {
    throw new Error('Tests failed')
  }
}

export async function testOnlyWatch() {
  const args = [...loaderArgsTsx, '--test-only', '--test', '--watch', ...testFiles]
  if ((await spawnAsyncLongRunning('node', args)).code !== 0) {
    throw new Error('Tests failed')
  }
}

export async function testCoverage(additionalTestFiles: string[] = []) {
  const args = [c8Path, 'node', ...loaderArgsTsNode, '--test', ...testFiles, ...additionalTestFiles]
  if ((await spawnAsync('node', args, { env: { ...process.env, NODE_V8_COVERAGE: './coverage' } })).code !== 0) {
    throw new Error('Tests failed')
  }
}

export async function testCoverageOnly() {
  const args = [c8Path, 'node', ...loaderArgsTsNode, '--test-only', '--test', ...testFiles, ...adminTestFiles]
  if ((await spawnAsync('node', args, { env: { ...process.env, NODE_V8_COVERAGE: './coverage' } })).code !== 0) {
    throw new Error('Tests failed')
  }
}

export async function testCoverageAll() {
  await testCoverage(adminTestFiles)
}

export async function cleanDist() {
  await emptyDirectory('./dist')
}

export async function dockerUp() {
  await printSonarQubeStartupMessage()
  await spawnDockerCompose(dockerComposePath, 'up')
}

export async function dockerUpAttached() {
  await printSonarQubeStartupMessage()
  await spawnDockerCompose(dockerComposePath, 'up', { attached: true })
}

export async function dockerDown() {
  await spawnDockerCompose(dockerComposePath, 'down')
}

export async function scan() {
  await spawnDockerCompose(dockerComposePath, 'run', { args: ['sonar-scanner'], attached: true })
}

export async function bashIntoSonar() {
  await spawnDockerCompose(dockerComposePath, 'exec', { args: ['-it', 'sonarqube', 'bash'], attached: true })
}

async function buildEsm() {
  log('Building ESM')
  await spawnAsync('node', [tscPath, '--p', 'tsconfig.esm.json'], { throwOnNonZero: true })
}

async function buildCjs() {
  log('Building CJS')
  await spawnAsync('node', [tscPath, '--p', 'tsconfig.cjs.json'], { throwOnNonZero: true })
}

async function copyCjsPackageJson() {
  await fsp.copyFile('./package.cjs.json', './dist/cjs/package.json')
}

async function printSonarQubeStartupMessage() {
  console.log(`SonarQube url after it finishes initializing: http://localhost:${process.env.SONAR_PORT || 9000}`)
}
