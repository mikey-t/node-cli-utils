import { randomInt } from 'crypto'
import * as net from 'net'
import { SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { platform } from 'node:os'
import path, { resolve } from 'node:path'
import * as readline from 'readline'
import { config } from './NodeCliUtilsConfig.js'
import { copyEnv, dictionaryToEnvFileString, getEnvAsDictionary, simpleSpawnAsyncInternal, simpleSpawnSyncInternal, spawnAsyncInternal, validateFindFilesRecursivelyParams, whichInternal } from './generalUtilsInternal.js'

// For JSDoc links
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { winInstallCert, winUninstallCert } from './certUtils.js'

export type Func<T> = (...args: unknown[]) => T
export type AsyncFunc<T> = (...args: unknown[]) => Promise<T>
export type FuncOrAsyncFunc<T> = Func<T> | AsyncFunc<T>
export type AsyncBooleanFunc = AsyncFunc<boolean>

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
 * Error thrown by {@link spawnAsync} when the spawned process exits with a non-zero exit code and options.throwOnNonZero is true.
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
 * Error thrown by {@link simpleSpawnSync} and {@link simpleCmdSync} when the spawned process exits with a non-zero exit code and throwOnNonZero param is true.
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
 * Used with method {@link spawnAsync}.
 */
export interface SpawnOptionsWithThrow extends SpawnOptions {
  throwOnNonZero: boolean
  simpleErrorMsg?: string
}

/**
 * Options interface for methods {@link simpleSpawnSync}, {@link simpleSpawnAsync}, {@link simpleCmdSync} and {@link simpleCmdAsync}.
 */
export interface SimpleSpawnOptions {
  /** Defaults to `true`. */
  throwOnNonZero: boolean
  /** Optional current working directory. Defaults to `process.cwd()`. */
  cwd: string
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
  try {
    await fsp.mkdir(dir, { recursive: true })
  } catch (err) {
    // Must catch and re-throw in order to get a stack trace: https://github.com/nodejs/node/issues/30944
    throw new ExtendedError('Error creating directory', getNormalizedError(err))
  }

}

/**
 * Create a directory. Will create parent directory structure if it don't exist. Similar to `mkdir -p`.
 * @param dir The directory to create. 
 */
export async function mkdirpSync(dir: string) {
  requireString('dir', dir)
  fs.mkdirSync(dir, { recursive: true })
}

export interface EmptyDirectoryOptions {
  /** An optional array of file and directory names to skip, but only at the top level of the directoryToEmpty. */
  fileAndDirectoryNamesToSkip: string[]
  force: boolean
  throwIfNotExists: boolean
}

/**
 * Empties a directory of all files and subdirectories. Optionally skips files and directories at the top level. For other
 * options, see {@link EmptyDirectoryOptions}.
 * @param directoryToEmpty The directory to empty.
 * @param options See {@link EmptyDirectoryOptions}.
 */
export async function emptyDirectory(directoryToEmpty: string, options?: Partial<EmptyDirectoryOptions>) {
  requireString('directoryToEmpty', directoryToEmpty)

  const defaultOptions: EmptyDirectoryOptions = { fileAndDirectoryNamesToSkip: [], force: false, throwIfNotExists: false }
  const mergedOptions: EmptyDirectoryOptions = { ...defaultOptions, ...options }

  if (!fs.existsSync(directoryToEmpty)) {
    if (mergedOptions.throwIfNotExists) {
      throw new Error('Directory does not exist and throwIfNotExists was set to true')
    }
    trace(`directoryToEmpty does not exist - creating directory ${directoryToEmpty}`)
    await mkdirp(directoryToEmpty)
    return
  }

  if (!fs.lstatSync(directoryToEmpty).isDirectory()) {
    throw new Error(`directoryToEmpty is not a directory: ${directoryToEmpty}`)
  }

  // Add some guardrails to prevent accidentally emptying the wrong directory
  const absolutePath = path.resolve(directoryToEmpty)
  trace(`emptying directory: ${absolutePath}`)
  if (!absolutePath.startsWith(process.cwd())) {
    throw new Error(`directoryToEmpty must be a child of the current working directory: ${directoryToEmpty}`)
  }

  if (absolutePath === process.cwd()) {
    throw new Error(`directoryToEmpty cannot be the current working directory: ${directoryToEmpty}`)
  }

  const dir = await fsp.opendir(directoryToEmpty, { encoding: 'utf-8' })

  if (mergedOptions.fileAndDirectoryNamesToSkip && !Array.isArray(mergedOptions.fileAndDirectoryNamesToSkip)) {
    throw new Error('fileAndDirectoryNamesToSkip must be an array')
  }

  let dirEntry = await dir.read()

  while (dirEntry) {
    if (mergedOptions.fileAndDirectoryNamesToSkip?.includes(dirEntry.name)) {
      dirEntry = await dir.read()
      continue
    }

    const direntPath = path.join(directoryToEmpty, dirEntry.name)

    if (dirEntry.isDirectory()) {
      await fsp.rm(direntPath, { recursive: true, force: mergedOptions.force })
    } else {
      await fsp.rm(direntPath, { force: mergedOptions.force })
    }

    dirEntry = await dir.read()
  }

  await dir.close()
}

export interface CopyDirectoryOptions {
  exclusions?: string[]
}

/**
 * Copies the contents of a directory to another directory (not including the top-level directory itself). Optionally
 * pass a list of file or directory names to skip using `CopyDirectoryOptions` -> `exclusions`.
 * 
 * If the destination directory does not exist, it will be created.
 * @param sourceDirectory Directory to copy from
 * @param destinationDirectory Directory to copy to
 */
export async function copyDirectoryContents(sourceDirectory: string, destinationDirectory: string, options?: Partial<CopyDirectoryOptions>) {
  requireString('sourceDirectory', sourceDirectory)
  requireString('destinationDirectory', destinationDirectory)

  const exclusions = options?.exclusions ?? []

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


    if (!exclusions.some(exclusion => destPath.endsWith(exclusion))) {
      if (dirEntry.isDirectory()) {
        await copyDirectoryContents(sourcePath, destPath, { exclusions })
      } else {
        await fsp.copyFile(sourcePath, destPath)
      }
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
 * Splits a string into lines, removing `\n` and `\r` characters. Does not return empty lines. Also see {@link stringToLines}.
 * @param str String to split into lines
 * @returns An array of lines from the string, with empty lines removed
 */
export function stringToNonEmptyLines(str: string): string[] {
  if (!str) { return [] }
  return str.split('\n').filter(line => line?.trim()).map(line => line.replace('\r', ''))
}

/**
 * Splits a string into lines, removing `\n` and `\r` characters. Returns empty lines. Also see {@link stringToNonEmptyLines}.
 * @param str String to split into lines
 * @returns An array of lines from the string, with empty lines removed
 */
export function stringToLines(str: string): string[] {
  if (!str) { return [] }
  return str.split('\n').map(line => line.replace('\r', ''))
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
 * @param options Optional {@link SimpleSpawnOptions} options
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero option is `true`
 */
export function simpleCmdSync(command: string, args?: string[], options?: Partial<SimpleSpawnOptions>): SimpleSpawnResult {
  if (!isPlatformWindows()) {
    throw new Error('getCmdResult is only supported on Windows')
  }

  const throwOnNonZero = options?.throwOnNonZero !== undefined ? options?.throwOnNonZero : true
  const cwd = options?.cwd ? options.cwd : process.cwd()

  // Was previously spawning 'cmd' directly with params '/D', '/S', '/C' - but we may as well let NodeJS do the work of escaping args to work correctly with cmd
  return simpleSpawnSyncInternal(command, args, throwOnNonZero, cwd, true)
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
 * @param options Optional {@link SimpleSpawnOptions} options
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero option is `true`
 */
export async function simpleCmdAsync(command: string, args?: string[], options?: Partial<SimpleSpawnOptions>): Promise<SimpleSpawnResult> {
  if (!isPlatformWindows()) {
    throw new Error('getCmdResult is only supported on Windows')
  }

  const throwOnNonZero = options?.throwOnNonZero !== undefined ? options?.throwOnNonZero : true
  const cwd = options?.cwd ? options.cwd : process.cwd()

  // Was previously spawning 'cmd' directly with params '/D', '/S', '/C' - but we may as well let NodeJS do the work of escaping args to work correctly with cmd
  return await simpleSpawnAsyncInternal(command, args, throwOnNonZero, cwd, true)
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
 * @param options Optional {@link SimpleSpawnOptions} options
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero option is `true`
 */
export function simpleSpawnSync(command: string, args?: string[], options?: Partial<SimpleSpawnOptions>): SimpleSpawnResult {
  const throwOnNonZero = options?.throwOnNonZero !== undefined ? options?.throwOnNonZero : true
  const cwd = options?.cwd ? options.cwd : process.cwd()
  return simpleSpawnSyncInternal(command, args, throwOnNonZero, cwd)
}

/**
 * Runs the requested command using {@link spawnAsync} and returns the result with stdout split into non-empty lines.
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
 * @param options Optional {@link SimpleSpawnOptions} options
 * @returns An object with the status code, stdout, stderr, and error (if any)
 * @throws {@link SimpleSpawnError} if the command fails and throwOnNonZero option is `true`
 */
export async function simpleSpawnAsync(command: string, args?: string[], options?: Partial<SimpleSpawnOptions>): Promise<SimpleSpawnResult> {
  const throwOnNonZero = options?.throwOnNonZero !== undefined ? options.throwOnNonZero : true
  const cwd = options?.cwd ? options.cwd : process.cwd()
  return await simpleSpawnAsyncInternal(command, args, throwOnNonZero, cwd)
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
 * @returns `true` if {@link isPlatformWindows} and {@link isPlatformMac} are both `false, otherwise returns `true`
 */
export function isPlatformLinux() {
  return !isPlatformWindows() && !isPlatformMac()
}

/**
 * This is a cross-platform method to get the location of a system command. Useful for checking if software
 * is installed, where it's installed and whether there are multiple locations.
 * @param commandName The name of the command to find
 * @returns The location of the command, any additional locations, and an error if one occurred
 */
export async function which(commandName: string): Promise<WhichResult> {
  return whichInternal(commandName, simpleCmdAsync, simpleSpawnAsync)
}

/**
 * Get the location of a system command within WSL. Call from non-WSL context like Powershell or CMD to see if a command
 * exists within your default wsl installation. See also: {@link which}.
 * @param commandName The name of the command to find within WSL installation
 * @returns The first location of the command, any additional locations, and an error if one occurred
 * @throws If run from non-windows platform or wsl is not installed/accessible/configured
 */
export async function whichWsl(commandName: string): Promise<WhichResult> {
  return whichInternal(commandName, simpleCmdAsync, simpleSpawnAsync, true)
}

/**
 * This is a cross-platform method to get the location of a system command. Useful for checking if software
 * is installed, where it's installed and whether there are multiple locations.
 * @param commandName The name of the command to find
 * @returns The location of the command, any additional locations, and an error if one occurred
 */
export function whichSync(commandName: string): WhichResult {
  return whichInternal(commandName, simpleCmdSync, simpleSpawnSync) as WhichResult
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

export interface CopyEnvOptions {
  /**  Defaults to `false`. If `true`, messages about adding missing keys will not be logged (useful if you're always calling {@link copyModifiedEnv} after this call). */
  suppressAddKeysMessages: boolean
  /** Defaults to `false`. If `true`, an error will be thrown if the destinationPath does not exist. If `false`, a message will be logged and no error will be thrown. */
  throwIfDestinationDirectoryMissing: boolean
}

/**
 * Copy entries from a source .env file to a destination .env file for which the destination .env file does not already have entries.
 * 
 * If the destination directory does not exist, a message will be logged and no other action will be taken. Alternatively, to throw an exception
 * when the destination directory does not exist, set the {@link CopyEnvOptions.throwIfDestinationDirectoryMissing} option to `true`.
 * 
 * If the destination .env file does not exist, it will be created and populated with the source .env file's values.
 * 
 * This is useful for copying values from a .env.template file to a root .env file.
 * 
 * For copying root .env files to other locations, use {@link overwriteEnvFile}.
 * @param sourcePath The path to the source .env file such as a `.env.template` file (use {@link overwriteEnvFile} for copying root .env files to other locations)
 * @param destinationPath The path to the destination .env file, such as the root .env file
 * @param options Optional {@link CopyEnvOptions} options.
 */
export async function copyNewEnvValues(sourcePath: string, destinationPath: string, options?: Partial<CopyEnvOptions>) {
  await copyEnv(sourcePath, destinationPath, false, options?.suppressAddKeysMessages, options?.throwIfDestinationDirectoryMissing)
}

/**
 * Copy entries from a source .env file to a destination .env file, overwriting any existing entries in the destination .env file.
 * 
 * If the destination directory does not exist, a message will be logged and no other action will be taken. Alternatively, to throw an exception
 * when the destination directory does not exist, set the {@link CopyEnvOptions.throwIfDestinationDirectoryMissing} option to `true`.
 * 
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
 * @param options Optional {@link CopyEnvOptions} options.
 */
export async function overwriteEnvFile(sourcePath: string, destinationPath: string, options?: Partial<CopyEnvOptions>) {
  await copyEnv(sourcePath, destinationPath, true, options?.suppressAddKeysMessages, options?.throwIfDestinationDirectoryMissing)
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
  directoryNamesToSkip: string[],
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

  const defaultOptions: FindFilesOptions = { maxDepth: 5, directoryNamesToSkip: [], returnForwardSlashRelativePaths: false }
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
        if (!mergedOptions.directoryNamesToSkip?.includes(entry.name)) {
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

export function getHostname(url: string): string {
  requireString('url', url)
  trace(`attempting to convert url to hostname: ${url}`)
  try {
    const encodedUrl = encodeURI(url)
    const parsedUrl = new URL(encodedUrl.startsWith('http') ? encodedUrl : 'https://' + encodedUrl)
    trace(`parsed url: ${parsedUrl}`)
    return parsedUrl.hostname
  } catch (e) {
    throw new ExtendedError("Invalid URL", e as Error)
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  if (!fs.existsSync(path)) {
    trace(`isDirectory returning false because path does not exist`)
    return false
  }
  try {
    const stats = await fsp.stat(path)
    return stats.isDirectory()
  } catch (err) {
    trace('error checking idDirectory (returning false)', err)
    return false
  }
}

export function isDirectorySync(path: string): boolean {
  try {
    const stats = fs.statSync(path)
    return stats.isDirectory()
  } catch (err) {
    trace('error checking idDirectory (returning false)', err)
    return false
  }
}

export type PlatformCode = 'win' | 'linux' | 'mac'

/**
 * This is a somewhat naive method but is useful if you rarely or never deal with unusual operating systems.
 * @returns `win`, `mac` or `linux`
 */
export function getPlatformCode(): PlatformCode {
  if (isPlatformWindows()) {
    return 'win'
  }
  if (isPlatformMac()) {
    return 'mac'
  }
  if (isPlatformLinux()) {
    return 'linux'
  }
  throw new Error('unrecognized platform: ' + platform())
}

/**
 * Tries connecting to a port to see if it's being listened on or not. It's likely that this won't work in a lot of scenarios, so use it at your own risk.
 * @param port The port to check
 * @returns `true` if the port is available, `false` otherwise
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.connect(port, '127.0.0.1')

    tester.on('connect', () => {
      tester.destroy()
      resolve(false) // port is in use
    })

    tester.on('error', (err: NodeJS.ErrnoException) => {
      tester.destroy()
      if (err.code === 'ECONNREFUSED') {
        resolve(true) // port is available
      } else {
        resolve(false) // some other error occurred, assume port is in use
      }
    })
  })
}

/**
 * Returns the value for an environment variable or throws if it's undefined or null. Pass optional `throwOnEmpty` param to throw when the key exists but has an empty value.
 * @param varName The name of the environment variable to get.
 * @param throwOnEmpty Throw an error if key exists (not undefined or null) but is empty.
 * @returns 
 */
export function getRequiredEnvVar(varName: string, throwOnEmpty = true): string {
  requireString('varName', varName)
  const val = process.env[varName]
  if (val === undefined || val === null) {
    throw new Error(`Missing required environment variable: ${varName}`)
  }
  if (throwOnEmpty && val.trim() === '') {
    throw new Error(`Required environment variable is empty: ${varName}`)
  }
  return val
}

export function getNormalizedError(err: unknown): Error {
  if (err instanceof Error) {
    return err
  }

  let normalizedError: Error
  if (err === undefined) {
    normalizedError = new Error('error was undefined')
  } else if (err === null) {
    normalizedError = new Error('error was null')
  } else if (err instanceof Error) {
    normalizedError = err
  } else if (typeof err === 'string') {
    normalizedError = new Error(err)
  } else if (err instanceof Object) {
    try {
      normalizedError = new Error(JSON.stringify(err))
    } catch {
      normalizedError = new Error('Object could not be serialized - could not normalize')
    }
  } else {
    normalizedError = new Error(`Unknown error of type ${typeof err} - could not normalize`)
  }
  return normalizedError
}

/** Options for {@link withRetryAsync}. */
export interface WithRetryOptions {
  /**
   * Number of milliseconds to wait before the first attempt.
   */
  initialDelayMilliseconds: number
  /**
   * Use this in log messages instead of the function name (useful for passing lambdas which would otherwise display as "anonymous").
   */
  functionLabel?: string
  /**
   * If NodeCliUtilsConfig.traceEnabled is `true` then messages will be logged even if this option is `false`.
   * Set to `true` to log messages even if Node ]
   */
  traceEnabled: boolean
  /**
   * Log all errors rather than just the last one after all retries fail. If `true`, this setting overrides library trace and this method's traceEnabled option.
   */
  logIntermediateErrors: boolean
}

/**
 * Call a function until it succeeds. Will stop after the number of calls specified by `maxCalls` param, or forever if -1 is passed.
 * @param func The function to call
 * @param maxCalls The maximum number of times to call the function before giving up. Pass -1 to retry forever.
 * @param delayMilliseconds The number of milliseconds to wait between calls
 * @param options Options for controlling the behavior of the retry. See {@link WithRetryOptions}.
 */
export async function withRetryAsync(func: () => Promise<void>, maxCalls: number, delayMilliseconds: number, options?: Partial<WithRetryOptions>) {
  let attemptNumber = 0
  let lastError: unknown
  const forever = maxCalls === -1

  const defaultOptions: WithRetryOptions = { initialDelayMilliseconds: 0, traceEnabled: false, logIntermediateErrors: false }
  const mergedOptions: WithRetryOptions = { ...defaultOptions, ...options }

  const shouldLog = config.traceEnabled || mergedOptions.traceEnabled
  const retryLog = shouldLog ? log : () => { }
  const funcName = mergedOptions.functionLabel ?? func.name ?? 'anonymous'

  if (mergedOptions.initialDelayMilliseconds > 0) {
    retryLog(`initialDelayMilliseconds set to ${mergedOptions.initialDelayMilliseconds} - waiting before first try`)
    await sleep(mergedOptions.initialDelayMilliseconds)
  }

  while (true) {
    attemptNumber++
    retryLog(`calling ${funcName} - attempt number ${attemptNumber}`)
    try {
      await func()
      retryLog(`attempt ${attemptNumber} was successful`)
      break
    } catch (err) {
      if (mergedOptions.logIntermediateErrors || shouldLog) {
        console.error(err)
      }
      lastError = err
    }

    if (!forever && attemptNumber === maxCalls) {
      throw new ExtendedError(`Failed to run method with retry after ${maxCalls} attempts`, getNormalizedError(lastError))
    }

    retryLog(`attempt number ${attemptNumber} failed - waiting ${delayMilliseconds} milliseconds before trying again`)
    await sleep(delayMilliseconds)
  }
}

/**
 * Collapses each instance of consecutive whitespace characters into a single space.
 */
export function collapseWhitespace(str: string): string {
  return str.replace(/\s+/g, ' ')
}

/**
 * Check if a string is a valid directory name. This is a very simple check that just makes sure the string doesn't contain any invalid characters.
 * @param dirName The directory name to check
 * @returns `true` if the directory name is valid, `false` otherwise
 */
export function isValidDirName(dirName: string): boolean {
  // List of generally invalid characters for directory names in Windows, macOS, and Linux
  const invalidChars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']

  for (const char of dirName) {
    if (invalidChars.includes(char) || char.charCodeAt(0) <= 31) {
      return false
    }
  }

  return true
}

export function hasWhitespace(str: string): boolean {
  return /\s/.test(str)
}

// Currently only used by whichInternal, which needs to be re-worked
export function stripShellMetaCharacters(input: string): string {
  const metaCharacters = [
    '\\', '`', '$', '"', "'", '<', '>', '|', ';', ' ', '&', '(', ')', '[', ']', '{', '}', '?', '*', '#', '~', '^', '\n', '\r'
  ]
  const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`[${metaCharacters.map(escapeRegex).join('')}]`, 'g')
  return input.replace(regex, '')
}

const unquotedCmdCommandPattern = /^[a-zA-Z0-9._:\\/-]+(?:\.exe|\.cmd|\.bat)?$/i
const quotedCmdCommandPattern = /^"[a-zA-Z0-9._:\\/-][a-zA-Z0-9._:\\/ -]*(?:\.exe|\.cmd|\.bat)?"$/i

export function isNonEmptyDoubleQuotedString(value: string): boolean {
  return /^"[^"]*"$/.test(value)
}

export function assertReasonablySafeCmdCommand(command: string): void {
  if (command.length === 0) {
    throw new Error('Cmd.exe command is empty')
  }

  const hasQuotes = command.includes('"')

  if (hasQuotes) {
    if (!quotedCmdCommandPattern.test(command)) {
      throw new Error('Quoted cmd.exe command must start and end with one double quote, contain no other double quotes, and only contain safe path characters')
    }
    return
  }

  if (!unquotedCmdCommandPattern.test(command)) {
    throw new Error(`Cmd.exe command has unexpected format: ${command}`)
  }
}

const unsafeCmdArgChars = /[&|<>^%!"\r\n]/

export function assertSafeCmdArg(arg: string): void {
  if (arg.length === 0) {
    throw new Error('Empty cmd.exe arg is not allowed')
  }

  if (unsafeCmdArgChars.test(arg)) {
    throw new Error(`Unsafe cmd.exe argument: ${arg}`)
  }
}

export function assertSafeCmdArgs(args?: string[]): void {
  if (!args || args.length === 0) return
  for (const arg of args) {
    assertSafeCmdArg(arg)
  }
}

export enum Emoji {
  RightArrow = '➡️',
  LeftArrow = '⬅️',
  GreenCheck = '✅',
  BlueCheck = '☑️',
  GreenCheckPlain = '✔️',
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
  Document = '📄',
  Certificate = '📜',
  Key = '🔑',
  Scull = '☠️',
  Finish = '🏁',
  Trophy = '🏆',
  StartButton = '▶️',
  PauseButton = '⏸️',
  StopButton = '⏹️',
  PlayPauseButton = '⏯️',
  RecordButton = '⏺️',
  EjectButton = '⏏️',
  NextTrack = '⏭️',
  PreviousTrack = '⏮️',
  FastForwardButton = '⏩',
  ShuffleButton = '🔀',
  RepeatButton = '🔁',
  Ok = '🆗',
  New = '🆕',
  LightBulb = '💡',
  Party = '🎉',
  Plus = '➕',
  Minus = '➖',
  Multiply = '✖️',
  Divide = '➗',
  RedCircle = '🔴',
  BlueCircle = '🔵',
  FloppyDisk = '💾',
  Explosion = '💥',
  Sparkles = '✨'
}

/**
 * Converts a windows path to a WSL path (Windows Subsystem for Linux) if it's an absolute path, otherwise returns it unchanged.
 * 
 * Normally you can use `path.resolve()` to convert paths to whatever is appropriate for the OS, but if you're running on Windows and need to spawn a
 * command with `wsl yourCommand`, then you'll want to use this function to convert any parameters that are paths so that they can be resolved within WSL.
 * Because the intended use of this function is for passing params around, most use cases will also require paths with spaces or single quotes to be
 * wrapped in quotes, so `wrapInQuotesIfSpaces` defaults to true.
 * @param winPath The Windows path.
 * @param wrapInQuotesIfSpaces Defaults to `true`. If `true` and the `winPath` passed has spaces, the returned string will be wrapped in quotes.
 * Single quotes will be used unless there are single quote characters within the path, in which case it will be wrapped in double quotes.
 * @returns The wsl equivalent path.
 */
export function toWslPath(winPath: string, wrapInQuotesIfSpaces: boolean = true): string {
  if (!path.isAbsolute(winPath)) {
    return winPath
  }
  const drive = winPath.charAt(0).toLowerCase()
  const remainingPath = winPath.substring(2).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const wslPath = path.posix.join(`/mnt/${drive}`, remainingPath)

  if (!wrapInQuotesIfSpaces) {
    return wslPath
  }

  if (wslPath.includes("'")) {
    return `"${wslPath}"`
  }

  if (wslPath.includes(' ')) {
    return `'${wslPath}'`
  }

  return wslPath
}

/**
 * Spawns a process that runs `wsl test -e <wslPath>` to determine if a wsl path exists.
 * @param wslPath WSL path to check
 * @returns `true` if the wsl path exists, `false` otherwise
 * @throws Error if executed on non-windows platform
 * @throws Error if wsl is not installed
 */
export function wslPathExists(wslPath: string): boolean {
  if (!isPlatformWindows()) {
    throw new Error('Cannot check for the existence of a WSL path on a non-windows platform')
  }

  if (!whichSync('wsl').location) {
    throw new Error('Cannot check wsl path - wsl is not installed')
  }

  if (!wslPath || typeof wslPath !== 'string' || wslPath.length === 0 || wslPath.trim().length === 0) {
    return false
  }

  const pathWithoutDoubleQuotes = wslPath.replaceAll('"', '')

  return simpleSpawnSync('wsl', ['test', '-e', pathWithoutDoubleQuotes], { throwOnNonZero: false }).code === 0
}

/**
 * Serialize a class instance. Ignore properties with underscore prefix and include getters. Useful for overriding the `toJSON` function of
 * a class so that calls to `JSON.stringify()` will generate more appropriate JSON.
 * 
 * @example
 * ```
 * class MyClass {
 *   //...
 *   toJSON = () => classToJson(this)
 *   //...
 * }
 * ```
 * @param instance A class instance, usually `this` if `classToJson` is being used as a class method.
 * @returns Json serialization of the class instance.
 */
export function classToJson(instance: object) {
  const jsonObj: { [key: string]: unknown } = {}

  for (const [key, value] of Object.entries(instance)) {
    if (!key.startsWith('_')) {
      jsonObj[key] = value
    }
  }

  const proto = Object.getPrototypeOf(instance)
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key.startsWith('_')) continue
    const desc = Object.getOwnPropertyDescriptor(proto, key)
    const hasGetter = desc && typeof desc.get === 'function'
    if (hasGetter) {
      jsonObj[key] = (instance as Record<string, unknown>)[key]
    }
  }
  return jsonObj
}

/**
 * Get's the value for the CLI param at process.argv[`argvIndex`] and throws the specified optional `errorMessage`
 * or a default error message if the CLI arg is missing.
 * 
 * Notes on common index position values:
 * 
 * - `0`: NodeJS path
 * - `1`: Script path
 * - `2`: First script param - for `swig` this will be the task name
 * @param errorMessage 
 * @returns 
 */
export function getRequiredCliParam(argvIndex: number, errorMessage?: string) {
  if (argvIndex < 0) {
    throw new Error('The argvIndex must be greater than or equal to 0')
  }
  const defaultErrorMessage = `Missing required CLI param at argv index ${argvIndex}`
  const paramValue = process.argv[argvIndex]
  // Allow falsy values like "0" - it can be anything except undefined
  if (paramValue === undefined) {
    throw new Error(errorMessage ?? defaultErrorMessage)
  }
  return paramValue
}

/**
 * Executes an asynchronous function conditionally.
 *
 * @overload
 * @template T The type of value that the `asyncFunc` returns.
 * @param condition A boolean that determines if the `asyncFunc` should be executed.
 * @param asyncFunc The async function to execute if the condition is true.
 * @param logEnabled Optional. Determines whether to enable logging. Defaults to `false`.
 * @returns Returns a Promise resolving to the value returned by `asyncFunc` if the condition is true, otherwise returns `undefined`.
 */
export async function conditionallyAsync<T>(condition: boolean, asyncFunc: AsyncFunc<T>, logEnabled?: boolean): Promise<T | undefined>

/**
 * Executes an asynchronous function conditionally.
 *
 * @overload
 * @template T The type of value that the `asyncFunc` returns.
 * @param conditionAsyncFunc An async function that returns a boolean that determines whether `asyncFunc` should be executed.
 * @param asyncFunc The async function to execute if the condition is true.
 * @param logEnabled Optional. Determines whether to enable logging. Defaults to `false`.
 * @returns Returns a Promise resolving to the value returned by `asyncFunc` if the condition is true, otherwise returns `undefined`.
 */
export async function conditionallyAsync<T>(conditionAsyncFunc: AsyncBooleanFunc, asyncFunc: AsyncFunc<T>, logEnabled?: boolean): Promise<T | undefined>

// JSDoc is covered by function overloads above
export async function conditionallyAsync<T>(conditionOrConditionAsyncFunc: boolean | AsyncBooleanFunc, asyncFunc: () => Promise<T>, logEnabled: boolean = false): Promise<T | undefined> {
  let resolvedCondition: boolean

  if (typeof conditionOrConditionAsyncFunc === 'function') {
    resolvedCondition = await conditionOrConditionAsyncFunc()
  } else {
    resolvedCondition = conditionOrConditionAsyncFunc
  }

  if (resolvedCondition) {
    logIf(logEnabled, 'conditional check is true - running')
    return await asyncFunc()
  } else {
    logIf(logEnabled, 'conditional check is false - skipping')
  }
}

/**
 * Type guard function to check if an Error is a `NodeJS.ErrnoException`.
 * @param err The Error object to check.
 * @returns `true` if it's a NodeJS.ErrnoException and `false` otherwise.
 */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error
    && 'code' in err
    && 'errno' in err
    && 'path' in err
    && 'syscall' in err
}

/**
 * Return `true` if `err` is a `NodeJS.ErrnoException` and has a `code` property equal to `ENOENT`.
 */
export function isErrorEnoent(err: unknown): boolean {
  return isErrnoException(err) && err.code === 'ENOENT'
}

/**
 * Get a timestamp string with no punctuation in the format `YYYYMMDDHHmmss`.
 * @param date An optional Date object to generate the timestamp string from, instead of using "now".
 * @returns String in the format `YYYYMMDDHHmmss`.
 */
export function getTimestampUnformatted(date?: Date): string {
  const d = date ?? new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  return `${year}${month}${day}${hours}${minutes}${seconds}`
}

/**
 * Wrapper function for built-in crypto lib `randomInt`, but `min` and `max` are both inclusive.
 */
export function getRandomIntInclusive(min: number, max: number): number {
  return randomInt(min, max + 1)
}

/**
 * Check if `child` path is a file or subdirectory underneath the `parentDir` directory. The `parentDir` param must be
 * a valid path and a directory. The `child` path does not need to exist, but note that if the child path is relative,
 * it will be resolved using the current working directory. Transform or resolve the child path before passing into this
 * method to avoid using current working directory.
 * @param parentDir An existing directory to check the `child` path against.
 * @param child An existing or non-existent path to check against the `parentDir` path.
 * @param requireChildExists Pass `true` if you want an exception to be thrown in the `child` path does not exist. Defaults to `false`.
 * @returns `true` if the `child` path is a descendant of `parentDir`
 */
export function isChildPath(parentDir: string, child: string, requireChildExists = false): boolean {
  requireValidPath('parentDir', parentDir)
  if (!fs.statSync(parentDir).isDirectory()) {
    throw new Error('The parentDir param must be an existing directory')
  }
  if (requireChildExists && !fs.existsSync(child)) {
    throw new Error('The child path passed does not exist and requireChildExists was set to true')
  }

  const parentPath = path.normalize(path.resolve(parentDir))
  const childPath = path.normalize(path.resolve(child))

  trace(`parentPath: ${parentPath}`)
  trace(`childPath: ${childPath}`)

  return (
    childPath !== parentPath &&
    childPath.startsWith(parentPath + path.sep)
  )
}

/**
 * Returns `true` if `value` is a string that contains only digits (regex used: `/^\d+$/`).
 */
export function hasOnlyDigits(value: string) {
  if (!value || typeof value !== 'string') {
    return false
  }
  return /^\d+$/.test(value)
}

/**
 * @param input A string to search.
 * @param substring The substring to find indexes for.
 * @returns An array of numbers representing the indexes for the substring within the input string.
 */
export function findAllIndexes(input: string, substring: string): number[] {
  const indexes: number[] = []
  let index = input.indexOf(substring)

  while (index !== -1) {
    indexes.push(index)
    index = input.indexOf(substring, index + 1)
  }

  return indexes
}

/**
 * @param input A string to split.
 * @returns An array of each of the input string's sets of consecutive non-whitespace characters.
 */
export function splitByWhitespace(input: string): string[] {
  if (!input) {
    return []
  }
  return input.match(/\S+/g) ?? []
}
