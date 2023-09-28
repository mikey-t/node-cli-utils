import { SpawnOptions, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { platform } from 'node:os'
import path, { resolve } from 'node:path'
import * as readline from 'readline'
import { config } from './NodeCliUtilsConfig.js'
import { SpawnOptionsInternal, copyEnv, dictionaryToEnvFileString, getEnvAsDictionary, spawnAsyncInternal, validateFindFilesRecursivelyParams } from './generalUtilsInternal.js'

// For JSDoc links
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { winInstallCert, winUninstallCert } from './certUtils.js'

const dockerComposeCommandsThatSupportDetached = ['exec', 'logs', 'ps', 'restart', 'run', 'start', 'stop', 'up']

/**
 * Just a wrapper for console.log() to type less.
 * @param data The data to log
 * @param moreData More data to log
 */
export function log(data: unknown, ...moreData: unknown[]) {
  console.log(data, ...moreData)
}

/**
 * Log conditionally. Useful for methods that have an option to either suppress output or to show it when it normally isn't.
 * @param data The data to log
 * @param moreData More data to log
 */
export function logIf(shouldLog: boolean, data: unknown, ...moreData: unknown[]) {
  if (shouldLog) {
    console.log(data, ...moreData)
  }
}

/**
 * Wrapper for console.log() that is suppressed if NodeCliUtilsConfig.logEnabled is false.
 * @param data The data to log
 * @param moreData More data to log
 */
export function trace(data?: unknown, ...moreData: unknown[]) {
  if (config.traceEnabled) {
    const prefix = `[TRACE]`
    console.log(prefix, data, ...moreData)
  }
}

/**
 * Type guard for a string keyed dictionary.
 */
export type StringKeyedDictionary = { [name: string]: string }

/**
 * Options for the {@link spawnAsync} wrapper function for NodeJS spawn.
 */
export interface SpawnResult {
  /**
   * The exit code of the spawned process. Rather than allowing null, this will be set to 1 if the process exits with null, or 0 if user cancels with ctrl+c.
   */
  code: number
  /**
   * The stdout of the spawned process. **Warning:** this will be empty by default without changing SpawnOptions stdio (see {@link spawnAsync}).
   */
  stdout: string
  /**
   * The stderr of the spawned process. **Warning:** this will be empty by default without changing SpawnOptions stdio (see {@link spawnAsync}).
   */
  stderr: string
  /**
   * Not an error from the child process stderr, but rather an error thrown when attempting to spawn the child process.
   */
  error?: Error,
  /**
   * The current working directory of the spawned process. Not changed by method, so just repeating your SpawnOptions.cwd back to you, but helpful for debugging.
   */
  cwd?: string
}

/**
 * Error throw by {@link spawnAsync} when the spawned process exits with a non-zero exit code and options.throwOnNonZero is true.
 * 
 * Contains a {@link SpawnResult} with the exit code, stdout, stderr, and error (if any).
 */
export class SpawnError extends Error {
  result: SpawnResult

  constructor(message: string, result: SpawnResult) {
    super(message)
    this.result = result
  }
}

/**
 * Spawn result for calls to {@link simpleSpawnSync} and {@link simpleCmdSync}.
 * 
 * Contains the same properties as {@link SpawnResult} plus stdoutLines, which is stdout split into lines from stdout that weren't empty.
 */
export interface SimpleSpawnResult extends SpawnResult {
  stdoutLines: string[]
}

/**
 * Error throw by {@link simpleSpawnSync} and {@link simpleCmdSync} when the spawned process exits with a non-zero exit code and throwOnNonZero param is true (the default).
 * 
 * Contains a {@link SimpleSpawnResult} with the exit code, stdout, stderr, and error (if any) in addition to stdoutLines, which is stdout split into lines from stdout that weren't empty.
 */
export class SimpleSpawnError extends Error {
  result: SimpleSpawnResult

  constructor(message: string, result: SimpleSpawnResult) {
    super(message)
    this.result = result
  }
}

/**
 * The result type for {@link whichSync}. Contains the location of the command, any additional locations, and an error if one occurred.
 */
export interface WhichResult {
  location: string | undefined
  additionalLocations: string[] | undefined
  error: Error | undefined
}

/**
 * Type guard for command passed to {@link spawnDockerCompose}.
 */
export type DockerComposeCommand = 'build' | 'config' | 'cp' | 'create' | 'down' | 'events' | 'exec' | 'images' | 'kill' | 'logs' | 'ls' | 'pause' | 'port' | 'ps' | 'pull' | 'push' | 'restart' | 'rm' | 'run' | 'start' | 'stop' | 'top' | 'unpause' | 'up' | 'version'

/**
 * Sleeps for the specified number of milliseconds.
 * @param ms The number of milliseconds to sleep
 * @returns A Promise that resolves after the specified number of milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * An extension of the built-in SpawnOptions with an extra option to specify whether a non-zero exit code should throw an error.
 */
export interface SpawnOptionsWithThrow extends SpawnOptions {
  throwOnNonZero: boolean
  simpleErrorMsg?: string
}

/**
 * This is a wrapper function for NodeJS spawn. Defaults stdio to inherit so that output is visible in the console,
 * but note that this means stdout and stderr will not be available in the returned SpawnResult. To hide the output
 * from the console but collect the stdout and stderr in the SpawnResult, use stdio: 'pipe'.
 * 
 * When spawning long-running processes, use {@link spawnAsyncLongRunning} instead so that unexpected
 * termination of the parent process will not orphan the child process tree on windows.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command The command to spawn
 * @param args The arguments to pass to the command
 * @param options The options to pass to the command
 * @returns A Promise that resolves to a {@link SpawnResult}
 */
export async function spawnAsync(command: string, args?: string[], options?: Partial<SpawnOptionsWithThrow>): Promise<SpawnResult> {
  return spawnAsyncInternal(command, args ?? [], options)
}

/**
 * Use this alternate spawn wrapper instead of {@link spawnAsync} when spawning long-running processes to
 * avoid orphaned child process trees on Windows.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command The command to spawn
 * @param args The arguments to pass to the command
 * @param cwd The current working directory to run the command from - defaults to process.cwd()
 * @returns A Promise that resolves to a {@link SpawnResult}
 */
export async function spawnAsyncLongRunning(command: string, args?: string[], cwd?: string): Promise<SpawnResult> {
  return spawnAsyncInternal(command, args ?? [], { cwd: cwd, isLongRunning: true })
}

/**
 * Ensure the directory exists. Similar to `mkdir -p` (creates parent directories if they don't exist).
 * @param dir The directory to ensure exists. If it does not exist, it will be created.
 */
export async function ensureDirectory(dir: string) {
  return await mkdirp(dir)
}

/**
 * Create a directory. Will create parent directory structure if it don't exist. Similar to `mkdir -p`.
 * @param dir The directory to create. 
 */
export async function mkdirp(dir: string) {
  requireString('dir', dir)
  await fsp.mkdir(dir, { recursive: true })
}

/**
 * Empties a directory of all files and subdirectories.
 * 
 * Optionally skips files and directories at the top level.
 * @param directoryToEmpty The directory to empty.
 * @param fileAndDirectoryNamesToSkip An optional array of file and directory names to skip, but only at the top level of the directoryToEmpty.
 */
export async function emptyDirectory(directoryToEmpty: string, fileAndDirectoryNamesToSkip?: string[]) {
  requireString('directoryToEmpty', directoryToEmpty)

  if (!fs.existsSync(directoryToEmpty)) {
    trace(`directoryToEmpty does not exist - creating directory ${directoryToEmpty}`)
    await mkdirp(directoryToEmpty)
    return
  }

  if (!fs.lstatSync(directoryToEmpty).isDirectory()) {
    throw new Error(`directoryToEmpty is not a directory: ${directoryToEmpty}`)
  }

  // Add some guardrails to prevent accidentally emptying the wrong directory
  const absolutePath = path.resolve(directoryToEmpty)
  log(`emptying directory: ${absolutePath}`)
  if (!absolutePath.startsWith(process.cwd())) {
    throw new Error(`directoryToEmpty must be a child of the current working directory: ${directoryToEmpty}`)
  }

  if (absolutePath === process.cwd()) {
    throw new Error(`directoryToEmpty cannot be the current working directory: ${directoryToEmpty}`)
  }

  const dir = await fsp.opendir(directoryToEmpty, { encoding: 'utf-8' })

  if (fileAndDirectoryNamesToSkip && !Array.isArray(fileAndDirectoryNamesToSkip)) {
    throw new Error('fileAndDirectoryNamesToSkip must be an array')
  }

  let dirEntry = await dir.read()

  while (dirEntry) {
    if (fileAndDirectoryNamesToSkip?.includes(dirEntry.name)) {
      dirEntry = await dir.read()
      continue
    }

    const direntPath = path.join(directoryToEmpty, dirEntry.name)

    if (dirEntry.isDirectory()) {
      await fsp.rm(direntPath, { recursive: true })
    } else {
      await fsp.unlink(direntPath)
    }

    dirEntry = await dir.read()
  }

  await dir.close()
}

/**
 * Copies the contents of a directory to another directory (not including the top-level directory itself).
 * 
 * If the destination directory does not exist, it will be created.
 * @param sourceDirectory Directory to copy from
 * @param destinationDirectory Directory to copy to
 */
export async function copyDirectoryContents(sourceDirectory: string, destinationDirectory: string) {
  requireString('sourceDirectory', sourceDirectory)
  requireString('destinationDirectory', destinationDirectory)

  if (!fs.existsSync(sourceDirectory)) {
    throw new Error(`sourceDirectory directory does not exist: ${sourceDirectory}`)
  }

  if (!fs.lstatSync(sourceDirectory).isDirectory()) {
    throw new Error(`sourceDirectory is not a directory: ${sourceDirectory}`)
  }

  if (!fs.existsSync(destinationDirectory)) {
    await mkdirp(destinationDirectory)
  }

  if (!fs.lstatSync(destinationDirectory).isDirectory()) {
    throw new Error(`destinationDirectory is not a directory: ${destinationDirectory}`)
  }

  const dir = await fsp.opendir(sourceDirectory, { encoding: 'utf-8' })

  let dirEntry = await dir.read()

  while (dirEntry) {
    const sourcePath = path.join(sourceDirectory, dirEntry.name)
    const destPath = path.join(destinationDirectory, dirEntry.name)

    if (dirEntry.isDirectory()) {
      await copyDirectoryContents(sourcePath, destPath)
    } else {
      await fsp.copyFile(sourcePath, destPath)
    }

    dirEntry = await dir.read()
  }
}

/**
 * Helper method to validate that a non-falsy and non-empty value is provided for a parameter that should be a string.
 * @param paramName The name of the parameter to be used in the error message
 * @param paramValue The value of the parameter
 */
export function requireString(paramName: string, paramValue: string) {
  if (paramValue === undefined || paramValue === null || paramValue === '' || typeof paramValue !== 'string' || paramValue.trim() === '') {
    throw new Error(`Required param '${paramName}' is missing`)
  }
}

/**
 * Helper method to validate that the path actually exists for the provided value.
 * @param paramName The name of the parameter, for logging purposes
 * @param paramValue The value of the parameter
 */
export function requireValidPath(paramName: string, paramValue: string) {
  requireString(paramName, paramValue)

  if (!fs.existsSync(paramValue)) {
    throw new Error(`Invalid or nonexistent path provided for param '${paramName}': ${paramValue}`)
  }
}

/**
 * Project names must contain only lowercase letters, decimal digits, dashes, and underscores, and must begin with a lowercase letter or decimal digit.
 * 
 * See https://docs.docker.com/compose/environment-variables/envvars/#compose_project_name.
 * @param projectName The string to validate
 * @returns `true` if it's a valid docker compose project name and `false` otherwise
 */
export function isDockerComposeProjectNameValid(projectName: string): boolean {
  requireString('projectName', projectName)

  // Ensure first char is a lowercase letter or digit
  if (!/^[a-z0-9]/.test(projectName[0])) {
    return false
  }

  // Ensure the rest of the chars are only lowercase letters, digits, dashes and underscores
  return /^[a-z0-9-_]+$/.test(projectName)
}

/**
 * Options for {@link spawnDockerCompose}.
 * @param projectName 
 * Note that there are other better options such as using the environment variable `COMPOSE_PROJECT_NAME`. See https://docs.docker.com/compose/environment-variables/envvars/#compose_project_name.
 * @param attached Default: false. All commands that support the detached option wil use it unless attached is specified as true (-d support: exec, logs, ps, restart, run, start, stop, up)
 * @param useDockerComposeFileDirectoryAsCwd Default: false. If true, the docker compose command will be run in the directory containing the docker compose file.
 */
export interface DockerComposeOptions {
  /** Additional arguments to pass to the docker-compose command. */
  args: string[]

  /**
   * Defaults to `false`. Controls whether or not the `--detach` option is passed. Note that this only applies to
   * some commands (exec, logs, ps, restart, run, start, stop, up).
   */
  attached: boolean

  /**
  * If not provided, it will default to using the directory that the docker-compose.yml is located in.
  * Specifies what current working directory to use with the spawn command.
  */
  cwd?: string

  /**
   * Optional. If provided, projectName will be passed as the `--project-name` param to `docker compose` so that generated containers will use it as a prefix
   * instead of the default, which is the directory name where the docker-compose.yml is located.
   * 
   * Alternate approaches for setting the docker compose project name:
   * 
   * - Locate your docker-compose.yml file in the root of your project so that docker will use that directory name for prefixing generated containers
   * - OR, locate your docker-compose.yml in a sub-directory named appropriately for use as a prefix for generated containers
   * - OR, put a `.env` file in the same directory as your docker-compose.yml
   * with the entry `COMPOSE_PROJECT_NAME=your-project-name`
   * 
   * Additional note on docker compose project names form the official docker compose docs: "Project names must contain only lowercase letters, decimal digits,
   * dashes, and underscores, and must begin with a lowercase letter or decimal digit". See https://docs.docker.com/compose/environment-variables/envvars/#compose_project_name.
   * 
   */
  projectName?: string

  /**
   * Optional. If provided, profile is passed to docker compose along with `--profile` param. Must match this regex: `[a-zA-Z0-9][a-zA-Z0-9_.-]+`.
   * 
   * See https://docs.docker.com/compose/profiles/.
   */
  profile?: string
}

/**
 * For docker compose commands, see https://docs.docker.com/compose/reference/. For available options for this wrapper function, see {@link DockerComposeOptions}.
 * 
 * The current working directory will be the directory of the {@link dockerComposePath} unless specified in the options. This ensures relative paths in the
 * docker compose file will be relative to itself by default.
 * 
 * See {@link DockerComposeOptions.projectName} for info on where to locate your docker compose file and how to specify the docker project name.
 * @param dockerComposePath Path to docker-compose.yml
 * @param dockerComposeCommand The docker-compose command to run
 * @param options {@link DockerComposeOptions} to use, including additional arguments to pass to the docker compose command and the project name
 */
export async function spawnDockerCompose(dockerComposePath: string, dockerComposeCommand: DockerComposeCommand, options?: Partial<DockerComposeOptions>): Promise<void> {
  requireValidPath('dockerComposePath', dockerComposePath)
  requireString('dockerComposeCommand', dockerComposeCommand)
  if (options?.cwd) {
    requireValidPath('cwd', options.cwd)
  }
  if (options?.projectName && !isDockerComposeProjectNameValid(options.projectName)) {
    throw new Error('Invalid docker compose project name specified for the projectName param. Project names must contain only lowercase letters, decimal digits, dashes, and underscores, and must begin with a lowercase letter or decimal digit.')
  }
  if (options?.profile && !/[a-zA-Z0-9][a-zA-Z0-9_.-]+/.test(options.profile)) {
    throw new Error('Invalid profile option - must match regex: [a-zA-Z0-9][a-zA-Z0-9_.-]+')
  }
  if (!await isDockerRunning()) {
    throw new Error('Docker is not running')
  }

  const defaultOptions: DockerComposeOptions = { args: [], attached: false, projectName: undefined, cwd: undefined }
  const mergedOptions = { ...defaultOptions, ...options }

  const dockerComposeDir = path.dirname(dockerComposePath)
  const dockerComposeFilename = path.basename(dockerComposePath)

  if (!mergedOptions.cwd) {
    mergedOptions.cwd = dockerComposeDir
  }

  let spawnArgs = ['compose', '-f', mergedOptions.cwd ? path.resolve(dockerComposePath) : dockerComposeFilename]

  if (mergedOptions.projectName) {
    spawnArgs.push('--project-name', mergedOptions.projectName)
  }

  if (mergedOptions.profile) {
    spawnArgs.push('--profile', mergedOptions.profile)
  }

  spawnArgs.push(dockerComposeCommand)

  if (!mergedOptions.attached && dockerComposeCommandsThatSupportDetached.includes(dockerComposeCommand)) {
    spawnArgs.push('--detach')
  }

  if (mergedOptions.args) {
    spawnArgs = spawnArgs.concat(mergedOptions.args)
  }

  trace(`running command in ${mergedOptions.cwd}: docker ${spawnArgs.join(' ')}`)

  const longRunning = dockerComposeCommandsThatSupportDetached.includes(dockerComposeCommand) && options?.attached === true

  trace(`docker compose command will be configured to use long running options: ${longRunning}`)

  const spawnOptions: Partial<SpawnOptionsInternal> = {
    cwd: mergedOptions.cwd,
    shell: isPlatformWindows(), // Early termination with ctrl + C on windows will not be graceful unless the shell option is set to true
    isLongRunning: longRunning
  }

  const spawnResult = await spawnAsyncInternal('docker', spawnArgs, spawnOptions)

  if (spawnResult.code !== 0) {
    throw new Error(`docker compose command failed with code ${spawnResult.code}`)
  }
}

/**
 * Splits a string into lines, removing empty lines and carriage return characters.
 * @param str String to split into lines
 * @returns An array of lines from the string, with empty lines removed
 */
export function stringToNonEmptyLines(str: string): string[] {
  if (!str) { return [] }
  return str.split('\n').filter(line => line?.trim()).map(line => line.replace('\r', ''))
}

/**
 * Runs the requested command using NodeJS spawnSync wrapped in an outer Windows CMD.exe command and returns the result with stdout split into lines.
 * 
 * Use this for simple quick commands that don't require a lot of control.
 * 
 * For commands that aren't Windows and CMD specific, use {@link simpleSpawnSync}.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command Command to run
 * @param args Arguments to pass to the command
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero is true
 */
export function simpleCmdSync(command: string, args?: string[], throwOnNonZero: boolean = true): SimpleSpawnResult {
  if (!isPlatformWindows()) {
    throw new Error('getCmdResult is only supported on Windows')
  }
  return simpleSpawnSync('cmd', ['/D', '/S', '/C', command, ...(args ?? [])], throwOnNonZero)
}

/**
 * Runs the requested command using {@link spawnAsync} wrapped in an outer Windows CMD.exe command and returns the result with stdout split into lines.
 * 
 * Use this for simple quick commands that don't require a lot of control.
 * 
 * For commands that aren't Windows and CMD specific, use {@link simpleSpawnAsync}.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command Command to run
 * @param args Arguments to pass to the command
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero is true
 */
export async function simpleCmdAsync(command: string, args?: string[], throwOnNonZero: boolean = true): Promise<SimpleSpawnResult> {
  if (!isPlatformWindows()) {
    throw new Error('getCmdResult is only supported on Windows')
  }
  return await simpleSpawnAsync('cmd', ['/D', '/S', '/C', command, ...(args ?? [])], throwOnNonZero)
}

/**
 * Runs the requested command using NodeJS spawnSync and returns the result with stdout split into lines.
 * 
 * Use this for simple quick commands that don't require a lot of control.
 * 
 * For commands that are Windows and CMD specific, use {@link simpleCmdSync}.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command Command to run
 * @param args Arguments to pass to the command
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero is true
 */
export function simpleSpawnSync(command: string, args?: string[], throwOnNonZero: boolean = true): SimpleSpawnResult {
  requireString('command', command)
  const result = spawnSync(command, args ?? [], { encoding: 'utf-8' })

  const spawnResult: SimpleSpawnResult = {
    code: result.status ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stdout.toString(),
    stdoutLines: stringToNonEmptyLines(result.stdout.toString()),
    error: result.error,
    cwd: process.cwd()
  }

  if (spawnResult.code !== 0 && throwOnNonZero) {
    throw new SimpleSpawnError(`spawned process failed with code ${spawnResult.code}`, spawnResult)
  }

  return spawnResult
}

/**
 * Runs the requested command using {@link spawnAsync} and returns the result with stdout split into lines.
 * 
 * Use this for simple quick commands that don't require a lot of control.
 * 
 * For commands that are Windows and CMD specific, use {@link simpleCmdSync}.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command Command to run
 * @param args Arguments to pass to the command
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero is true
 */
export async function simpleSpawnAsync(command: string, args?: string[], throwOnNonZero: boolean = true): Promise<SimpleSpawnResult> {
  requireString('command', command)

  const result = await spawnAsync(command, args, { stdio: 'pipe' })

  const spawnResult: SimpleSpawnResult = {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stdout,
    stdoutLines: stringToNonEmptyLines(result.stdout),
    error: result.error,
    cwd: process.cwd()
  }

  if (spawnResult.code !== 0 && throwOnNonZero) {
    throw new SimpleSpawnError(`spawned process failed with code ${spawnResult.code}`, spawnResult)
  }

  return spawnResult
}

/**
 * @returns `true` if platform() is 'win32', `false` otherwise
 */
export function isPlatformWindows() {
  return platform() === 'win32'
}

/**
 * 
 * @returns `true` if platform() is 'darwin', `false` otherwise
 */
export function isPlatformMac() {
  return platform() === 'darwin'
}

/**
 * 
 * @returns `true` if {@link isPlatformWindows} and {@link isPlatformMac} are both `false, otherwise returns `false`
 */
export function isPlatformLinux() {
  return !isPlatformWindows() && !isPlatformMac()
}

/**
 * This is a cross-platform method to get the location of a system command. Useful for checking if software
 * is installed, where it's installed and whether there are multiple locations for a command.
 * @param commandName The name of the command to find
 * @returns The location of the command, any additional locations, and an error if one occurred
 */
export function whichSync(commandName: string): WhichResult {
  if (isPlatformWindows()) {
    const result = simpleCmdSync('where', [commandName])
    return {
      location: result.stdoutLines[0],
      additionalLocations: result.stdoutLines.slice(1),
      error: result.error
    }
  } else {
    const result = simpleSpawnSync('which', ['-a', commandName])
    return {
      location: result.stdoutLines[0],
      additionalLocations: result.stdoutLines.slice(1),
      error: result.error
    }
  }
}

/**
 * This is a cross-platform method to get the location of a system command. Useful for checking if software
 * is installed, where it's installed and whether there are multiple locations for a command.
 * @param commandName The name of the command to find
 * @returns The location of the command, any additional locations, and an error if one occurred
 */
export async function whichAsync(commandName: string): Promise<WhichResult> {
  if (isPlatformWindows()) {
    const result = await simpleCmdAsync('where', [commandName])
    return {
      location: result.stdoutLines[0],
      additionalLocations: result.stdoutLines.slice(1),
      error: result.error
    }
  } else {
    const result = await simpleSpawnAsync('which', ['-a', commandName])
    return {
      location: result.stdoutLines[0],
      additionalLocations: result.stdoutLines.slice(1),
      error: result.error
    }
  }
}

/**
 * First checks if docker is installed and if not immediately returns false. Then runs the `docker info`
 * command and looks for "error during connect" in the output to determine if docker is running.
 * @returns `true` if docker is installed and running, `false` otherwise
 */
export async function isDockerRunning(): Promise<boolean> {
  if (!whichSync('docker').location) {
    trace('whichSync will not check if docker is running because docker does not appear to be installed - returning false')
    return false
  }

  try {
    const result = await simpleSpawnAsync('docker', ['info'])
    return !result.stdout.includes('error during connect')
  } catch (err) {
    return false
  }
}

/**
 * Uses built-in NodeJS readline to ask a question and return the user's answer.
 * @param query The question to ask
 * @returns A Promise that resolves to the user's answer
 */
export function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve =>
    rl.question(`\n${query}\n`, ans => {
      rl.close()
      resolve(ans)
    })
  )
}

/**
 * A simple CLI prompt using the built-in NodeJS readline functionality to ask for confirmation.
 * @param question The question to ask
 * @returns A Promise that resolves to true if the user answers 'y' or 'yes', false otherwise
 */
export function getConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(`\n  ${Emoji.RedQuestion} ${question}\n  ${Emoji.RightArrow} Proceed? (yes/no): `, (answer) => {
      rl.close()
      const confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
      log(confirmed ? `  ${Emoji.GreenCheck} Proceeding\n` : `  ${Emoji.RedX} Aborting\n`)
      resolve(confirmed)
    })
  })
}

/**
 * Example of using {@link getConfirmation}.
 */
export async function getConfirmationExample() {
  if (await getConfirmation('Do you even?')) {
    log('you do even')
  } else {
    log('you do not even')
  }
}

/**
 * Copy entries from a source .env file to a destination .env file for which the destination .env file does not already have entries.
 * If the destination .env file does not exist, it will be created and populated with the source .env file's values.
 * 
 * This is useful for copying values from a .env.template file to a root .env file.
 * 
 * For copying root .env files to other locations, use {@link overwriteEnvFile}.
 * @param sourcePath The path to the source .env file such as a `.env.template` file (use {@link overwriteEnvFile} for copying root .env files to other locations)
 * @param destinationPath The path to the destination .env file, such as the root .env file
 */
export async function copyNewEnvValues(sourcePath: string, destinationPath: string) {
  await copyEnv(sourcePath, destinationPath, false)
}

/**
 * Copy entries from a source .env file to a destination .env file, overwriting any existing entries in the destination .env file.
 * If the destination .env file does not exist, it will be created and populated with the source .env file's values.
 * 
 * This is useful for copying values from a root .env file to additional locations (server, client, docker-compose directory, etc.)
 * throughout your solution so you only have to manage one .env file.
 * 
 * Note that this does not delete any existing entries in the destination .env file, which is useful if you have additional entries in
 * the destination .env file that you don't want to overwrite.
 * 
 * For copying .env.template files to root .env files, use {@link copyNewEnvValues}.
 * @param sourcePath The path to the source .env file such as a root .env file (use {@link copyNewEnvValues} for .env.template files)
 * @param destinationPath The path to the destination .env file
 * @param suppressAddKeysMessages If true, messages about adding missing keys will not be logged (useful if you're always calling {@link copyModifiedEnv} after this call)
 */
export async function overwriteEnvFile(sourcePath: string, destinationPath: string, suppressAddKeysMessages = false) {
  await copyEnv(sourcePath, destinationPath, true, suppressAddKeysMessages)
}

/**
 * Copy entries from a source .env file to a destination .env file, but only for the keys specified in keepKeys.
 * Will also modify entries in the destination .env file as specified in modifyEntries.
 * @param sourcePath The path to the source .env file
 * @param destinationPath The path to the destination .env file
 * @param keepKeys The keys to keep from the source .env file
 * @param modifyEntries The entries to modify in the destination .env file
 */
export async function copyModifiedEnv(sourcePath: string, destinationPath: string, keepKeys: string[], modifyEntries?: StringKeyedDictionary) {
  requireValidPath('sourcePath', sourcePath)
  const destPathDir = path.dirname(destinationPath)
  if (!fs.existsSync(destPathDir)) {
    await ensureDirectory(destPathDir)
  }

  const sourceDict = getEnvAsDictionary(sourcePath)
  const newDict: StringKeyedDictionary = filterDictionary(sourceDict, key => keepKeys.includes(key))

  if (modifyEntries && Object.keys(modifyEntries).length > 0) {
    for (const [key, value] of Object.entries(modifyEntries)) {
      newDict[key] = value
    }
  }

  const newSortedDict = sortDictionaryByKeyAsc(newDict)
  const newEnvFileContent = dictionaryToEnvFileString(newSortedDict)
  await fsp.writeFile(destinationPath, newEnvFileContent)
}

/**
 * Filters a dictionary by key.
 * @param dict The dictionary to filter
 * @param predicate A function that returns true if the key should be included in the filtered dictionary
 * @returns A new dictionary with only the keys that passed the predicate
 */
export function filterDictionary(dict: StringKeyedDictionary, predicate: (key: string) => boolean): StringKeyedDictionary {
  // Notes to self:
  // - The second param of reduce is the initial value of the accumulator
  // - Reduce processes each element of the array and returns the accumulator for the next iteration
  // - In our case, the accumulator is a new dictionary that we're building up
  return Object.keys(dict)
    .filter(predicate)
    .reduce((accumulator, key) => {
      accumulator[key] = dict[key]
      return accumulator
    }, {} as StringKeyedDictionary)
}

/**
 * Sorts a dictionary by key in ascending order.
 * @param dict The dictionary to sort
 * @returns A new dictionary sorted by key in ascending order
 */
export function sortDictionaryByKeyAsc(dict: StringKeyedDictionary): StringKeyedDictionary {
  const newSortedDict = Object.entries(dict).sort((a, b) => {
    if (a < b) {
      return -1
    }
    if (a > b) {
      return 1
    }
    return 0
  })

  return Object.fromEntries(newSortedDict)
}

/**
 * Helper method to delete a .env file if it exists.
 * @param envPath The path to the .env file to delete
 */
export async function deleteEnvIfExists(envPath: string) {
  // Just protecting ourselves from accidentally deleting something we didn't mean to
  if (envPath.endsWith('.env') === false) {
    throw new Error(`envPath must end with '.env': ${envPath}`)
  }
  // Using fsp.unlink will throw an error if it's a directory
  if (fs.existsSync(envPath)) {
    await fsp.unlink(envPath)
  }
}


export interface FindFilesOptions {
  maxDepth: number
  excludeDirectoryNames: string[],
  returnForwardSlashRelativePaths: boolean
}

/**
 * Searches a directory recursively for files that match the specified pattern.
 * The filenamePattern is a simple text string with asterisks (*) for wildcards.
 * @param dir The directory to find files in
 * @param filenamePattern The pattern to match files against
 * @param options Specify a max depth to search, defaults to 5
 * @returns A Promise that resolves to an array of file paths that match the pattern
 */
export async function findFilesRecursively(dir: string, filenamePattern: string, options?: Partial<FindFilesOptions>): Promise<string[]> {
  validateFindFilesRecursivelyParams(dir, filenamePattern)

  const defaultOptions: FindFilesOptions = { maxDepth: 5, excludeDirectoryNames: [], returnForwardSlashRelativePaths: false }
  const mergedOptions = { ...defaultOptions, ...options }

  // Convert the pattern to a regex
  const regex = new RegExp('^' + filenamePattern.split(/\*+/).map(escapeStringForRegex).join('.*') + '$')

  const matches: string[] = []

  // Recursive function to search within directories
  async function searchDirectory(directory: string, depth: number): Promise<void> {
    if (depth > mergedOptions.maxDepth) return

    const entries = await fsp.readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name)

      if (entry.isDirectory()) {
        // Check if directory is in the exclude list
        if (!mergedOptions.excludeDirectoryNames?.includes(entry.name)) {
          await searchDirectory(fullPath, depth + 1)
        }
      } else if (entry.isFile() && regex.test(entry.name)) {
        if (mergedOptions.returnForwardSlashRelativePaths) {
          matches.push(path.relative(dir, fullPath).replace(/\\/g, '/'))
        } else {
          matches.push(fullPath)
        }
      }
    }
  }

  await searchDirectory(dir, 1)  // Start search from the first depth

  return matches
}

/** Utility function to escape a string for use within regex */
export function escapeStringForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Logs the provided 2-dimensional string array as a formatted table.
 * 
 * @param data 2-dimensional string array where the first row is the column headers
 * @example
 * 
 * logTable([
 *   ['Name', 'Age', 'Country'],
 *   ['Alice', '28', 'USA'],
 *   ['Bob', '22', 'Canada']
 * ])
 */
export function logTable(data: string[][]): void {
  if (data.length === 0 || data[0].length === 0) return

  const numColumns = data[0].length
  const columnWidths: number[] = []
  for (let i = 0; i < numColumns; i++) {
    columnWidths[i] = Math.max(...data.map(row => row[i]?.length || 0))
  }

  const lineSeparator = columnWidths.map(width => '-'.repeat(width)).join(' + ')

  for (let i = 0; i < data.length; i++) {
    const paddedRowArray = data[i].map((cell, colIdx) => cell.padEnd(columnWidths[colIdx], ' '))
    log(paddedRowArray.join(' | '))
    if (i === 0) log(lineSeparator)
  }
}

/**
 * See {@link getPowershellHackArgs}.
 */
export const powershellHackPrefix = `$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); `

/**
 * Powershell doesn't load the system PSModulePath when running in a non-interactive shell.
 * This is a workaround to set the PSModulePath environment variable to the system value before running a powershell command.
 * 
 * **Warning:** Do NOT use this for generating commands dynamically from user input as it could be used to execute arbitrary code.
 * This is meant solely for building up known commands that are not made up of unsanitized user input, and only at compile time.
 * See {@link winInstallCert} and {@link winUninstallCert} for examples of taking user input and inserting it safely into known commands.
 * @param command The powershell command to run
 * @returns An array of arguments to pass to {@link spawnAsync} with the "powershell" command as the first argument
 */
export function getPowershellHackArgs(command: string): string[] {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${powershellHackPrefix}${command}`]
}

/**
 * Returns a humanized string representation of the number of milliseconds using ms, seconds, minutes, or hours.
 * @param milliseconds The number of milliseconds to humanize
 * @returns A humanized string representation of the number
 */
export function humanizeTime(milliseconds: number) {
  let value: number
  let unit: string

  if (milliseconds < 1000) {
    return `${milliseconds} ms`
  }

  if (milliseconds < 60000) {
    value = milliseconds / 1000
    unit = 'second'
  } else if (milliseconds < 3600000) {
    value = milliseconds / 60000
    unit = 'minute'
  } else {
    value = milliseconds / 3600000
    unit = 'hour'
  }

  let stringValue = value.toFixed(2)

  if (stringValue.endsWith('.00')) {
    stringValue = stringValue.slice(0, -3)
  } else if (stringValue.endsWith('0')) {
    stringValue = stringValue.slice(0, -1)
  }

  if (stringValue !== '1') {
    unit += 's'
  }

  return `${stringValue} ${unit}`
}

export class ExtendedError extends Error {
  public innerError: Error | null

  constructor(message: string, innerError?: Error) {
    super(message)
    this.innerError = innerError ?? null
    Object.setPrototypeOf(this, ExtendedError.prototype)
  }
}

export enum AnsiColor {
  RESET = '\x1b[0m',
  RED = '\x1b[31m',
  GREEN = '\x1b[32m',
  YELLOW = '\x1b[33m',
  CYAN = '\x1b[96m',
  GRAY = '\x1b[90m',
  PURPLE = '\x1b[35m'
}

export const color = (str: string, colorAnsiCode: AnsiColor): string => {
  return `${colorAnsiCode}${str}${AnsiColor.RESET}`
}

export const red = (str: string) => color(str, AnsiColor.RED)
export const green = (str: string) => color(str, AnsiColor.GREEN)
export const cyan = (str: string) => color(str, AnsiColor.CYAN)
export const gray = (str: string) => color(str, AnsiColor.GRAY)
export const purple = (str: string) => color(str, AnsiColor.PURPLE)
export const yellow = (str: string) => color(str, AnsiColor.YELLOW)

export enum Emoji {
  RightArrow = '➡️',
  LeftArrow = '⬅️',
  GreenCheck = '✅',
  Warning = '⚠️',
  Lightning = '⚡',
  Exclamation = '❗',
  RedQuestion = '❓',
  RedX = '❌',
  Info = 'ℹ️',
  SadFace = '😢',
  Tools = '🛠️',
  NoEntry = '⛔',
  Stop = '🛑',
  Certificate = '📜',
  Key = '🔑',
}
