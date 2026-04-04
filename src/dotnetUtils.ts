import fs from 'fs'
import path from 'node:path'
import { getInstalledSdkVersions } from './DotnetSdkUtility.js'
import { getLatestNugetPackageVersion, validatePackageName } from './NugetUtility.js'
import { Emoji, log, requireString, requireValidPath, simpleSpawnAsync, spawnAsync, trace } from './generalUtils.js'

const toolManifestPartialPath = '.config/dotnet-tools.json'

// For JSDoc link
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { SpawnError } from './generalUtils.js'

export { getInstalledSdkVersions, isSdkMajorVersionInstalled, isSdkMajorVersionOrGreaterInstalled } from './DotnetSdkUtility.js'
export { getLatestNugetPackageVersion, getLatestMajorNugetPackageVersion } from './NugetUtility.js'

/**
 * Runs dotnet build on the specified project.
 * @param projectPath Path to project file (like .csproj) or directory of project to build
 * @throws A {@link SpawnError} if the spawned process exits with a non-zero exit code
 */
export async function dotnetBuild(projectPath: string) {
  requireValidPath('projectPath', projectPath)
  await spawnAsync('dotnet', ['build', projectPath], { throwOnNonZero: true })
}

/**
 * Helper method to spawn a process and run 'dotnet publish'.
 * @param projectPath Path to project file (like .csproj) or directory of project to build
 * @param configuration Build configuration, such as 'Release'
 * @param outputDir The relative or absolute path for the build output
 * @param cwd Optionally run the command from another current working directory
 */
export async function dotnetPublish(projectPath: string = './', configuration: string = 'Release', outputDir: string = 'publish', cwd?: string) {
  requireValidPath('projectPath', projectPath)
  requireString('outputDir', outputDir)
  requireString('configuration', configuration)
  if (cwd) {
    requireValidPath('cwd', cwd)
  }
  const args = ['publish', projectPath, '-c', configuration, '-o', outputDir]
  const traceMessage = `running dotnet ${args.join(' ')}`
  const traceAdditional = cwd ? ` in cwd ${cwd}` : ''
  trace(`${traceMessage}${traceAdditional}`)
  await spawnAsync('dotnet', args, { cwd: cwd })
}

export interface EnsureDotnetToolOptions {
  /** Defaults to `false`. */
  global: boolean,
  /** Optionally specify a dotnet version instead of using the latest installed version. */
  dotnetMajorVersion?: number,
  /**
   * Current working directory to run the commands. Defaults to process current working directory.
   * 
   * **Note:** this option is only relevant if the `global` option is `false`.
   * */
  cwd: string
}

/**
 * Installs or updates a dotnet CLI tool. Only supports dotnet 5+. Runs a combination of `dotnet --list-sdks`, `dotnet new tool-manifest`,
 * `dotnet tool uninstall` and `dotnet tool install`. Nuget.org will be queried to determine the latest compatible version of the tool for your
 * latest installed dotnet SDK version, or the dotnet SDK version specified in options (the version passed in options must also be installed).
 * 
 * Defaults that can be overridden with options ({@link EnsureDotnetToolOptions}):
 * - Local install
 * - Uses latest installed dotnet SDK version
 * - Runs in the current working directory
 * 
 * For local installs, a new tool manifest will be created with the command `dotnet new tool-manifest` if it doesn't already exist. Note that dotnet
 * searches up the directory tree until it finds a tool manifest.
 * 
 * If the tool is already installed and the version installed is newer (because an older dotnet version was specified in the options), the installed
 * version will be overwritten with the latest compatible version for the dotnet version specified in the options rather than trying to simply run the
 * `dotnet tool update` command, which would throw an error in this scenario.
 * 
 * Docs for dotnet tools: https://learn.microsoft.com/en-us/dotnet/core/tools/global-tools
 * 
 * Docs for `dotnet tool install`: https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install
 */
export async function ensureDotnetTool(toolName: string, options?: Partial<EnsureDotnetToolOptions>) {
  validatePackageName(toolName)

  const globalInstall = options?.global ?? false

  let cwd: string
  if (options?.cwd) {
    cwd = options.cwd
    requireValidPath('options.cwd', cwd)
  } else {
    cwd = process.cwd()
  }

  const dotnetVersions = await getInstalledSdkVersions()
  if (dotnetVersions.length === 0) {
    throw new Error('dotnet is not installed')
  }

  let dotnetVersion: number
  if (options?.dotnetMajorVersion) {
    // Use dotnet version specified in options
    dotnetVersion = options.dotnetMajorVersion
    if (!dotnetVersions.some(v => v.major === dotnetVersion)) {
      throw new Error(`Cannot install tool with options specified - dotnet version ${dotnetVersion} is not installed`)
    }
  } else {
    // Or, latest installed version
    dotnetVersion = [...dotnetVersions].sort((a, b) => b.major - a.major)[0].major
  }

  if (dotnetVersion < 5) {
    throw new Error('Only dotnet 5 and above is supported for this utility method')
  }

  const tfm = sdkVersionToTfm(dotnetVersion)
  log(`using dotnet version ${dotnetVersion} (TFM: ${tfm})`)

  log(`ensuring dotnet tool "${toolName}" is installed ${globalInstall ? 'global' : 'local'}ly with the latest compatible version for dotnet ${dotnetVersion}`)

  log(`looking up latest compatible version in Nuget repository for tool "${toolName}"`)
  const latestToolVersion = await getLatestNugetPackageVersion(toolName, tfm)
  if (latestToolVersion === null) {
    throw new Error(`No compatible version of ${toolName} was found for TFM ${tfm}`)
  }

  log(`found compatible tool version: ${latestToolVersion}`)

  log(`checking if ${globalInstall ? 'global' : 'local'} dotnet tool is installed`)
  const installedVersion = await getDotnetToolInstalledVersion(toolName, globalInstall, cwd)

  const commandLocalitySwitch = globalInstall ? '--global' : '--local'
  if (installedVersion === null) {
    log(`dotnet tool is not installed, attempting to install`)
    if (!globalInstall) {
      await ensureDotnetToolManifest(cwd)
    }
    const command = `dotnet tool install ${toolName} ${commandLocalitySwitch} --version ${latestToolVersion}`
    log(`installing with command: ${command}`)
    await spawnAsync('dotnet', command.split(' '), { throwOnNonZero: true, cwd: cwd })
    log(`finished tool install`)
  } else {
    log(`found installed dotnet tool "${toolName}" version ${installedVersion}`)
    if (installedVersion === latestToolVersion) {
      log(`the most recent version of the tool is already installed - finished`)
      return
    }
    log(`latest version and installed version do not match - uninstalling the existing version before re-installing`)
    if (!globalInstall) {
      await ensureDotnetToolManifest()
    }
    const uninstallCommand = `dotnet tool uninstall ${toolName} ${commandLocalitySwitch}`
    log(`uninstalling with command: ${uninstallCommand}`)
    await spawnAsync('dotnet', uninstallCommand.split(' '), { throwOnNonZero: true, cwd: cwd })
    const command = `dotnet tool install ${toolName} ${commandLocalitySwitch} --version ${latestToolVersion}`
    log(`installing with command: ${command}`)
    await spawnAsync('dotnet', command.split(' '), { throwOnNonZero: true, cwd: cwd })
    log(`finished tool install`)
  }
}

/**
 * Runs `dotnet new tool-manifest` if `./.config/dotnet-tools.json` does not exist. Uses the current working directory.
 * 
 * The tool manifest is required when installing local dotnet tools. Note that dotnet searches up the directory tree
 * for a tool manifest, so tools can be installed in a solution root directory and be picked up by dotnet when run
 * in subdirectories.
 */
export async function ensureDotnetToolManifest(cwd: string = process.cwd()) {
  requireValidPath('cwd', cwd)
  const toolsManifestPath = path.join(cwd, toolManifestPartialPath)
  log(`checking if tool manifest exists at ${toolsManifestPath}`)
  const toolManifestExists = fs.existsSync(toolsManifestPath)
  if (toolManifestExists) {
    log(`tool manifest already exists`)
  } else {
    log(`tool manifest does not exist, attempting to create with command: dotnet new tool-manifest`)
    await spawnAsync('dotnet', ['new', 'tool-manifest'], { throwOnNonZero: true, cwd })
    log(`created tool manifest at ${toolsManifestPath}`)
  }
}

interface DotnetToolListItem {
  packageId: string
  version: string
  commands?: string
  manifest?: string
}

async function getDotnetToolInstalledVersion(toolName: string, globalInstall: boolean, cwd: string): Promise<string | null> {
  validatePackageName(toolName)
  requireValidPath('cwd', cwd)

  const result = await simpleSpawnAsync('dotnet', ['tool', 'list', globalInstall ? '--global' : '--local'], { cwd: cwd })

  // The dotnet CLI can output an initial welcome message on first use - find the actual first line of output that we're looking for
  let lines = result.stdoutLines
  let columnHeaderLineIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Package Id')) {
      columnHeaderLineIndex = i
      break
    }
  }

  const errorMessagePrefix = 'Unexpected output for command "dotnet tool list" -'
  if (columnHeaderLineIndex === -1) {
    throw new Error(`${errorMessagePrefix} expected a line with the column header "Package Id": ${JSON.stringify(lines)}`)
  }
  lines = lines.slice(columnHeaderLineIndex)
  if (!lines[1].startsWith('-')) {
    throw new Error(`${errorMessagePrefix} expected a divider line: ${JSON.stringify(lines)}`)
  }
  if (lines.length < 3) {
    return null
  }

  const versionColumnIndex = lines[0].indexOf('Version')
  const commandsColumnIndex = lines[0].indexOf('Commands')
  const manifestColumnIndex = lines[0].indexOf('Manifest')

  if (versionColumnIndex === -1) {
    throw new Error(`Unexpectedly missing "Version" header in "dotnet tool list" output: ${JSON.stringify(lines)}`)
  }

  const tools: DotnetToolListItem[] = []
  for (let i = 2; i < lines.length; i++) {
    const packageId = lines[i].substring(0, versionColumnIndex).trim()
    const version = lines[i].substring(versionColumnIndex, commandsColumnIndex !== -1 ? commandsColumnIndex : lines[i].length - 1).trim()
    const commands = commandsColumnIndex !== -1 ? lines[i].substring(commandsColumnIndex, manifestColumnIndex !== -1 ? manifestColumnIndex : lines[i].length - 1).trim() : undefined
    const manifest = manifestColumnIndex !== -1 ? lines[i].substring(manifestColumnIndex).trim() : undefined
    tools.push({
      packageId,
      version,
      commands,
      manifest
    })
  }

  const match = tools.find(t => t.packageId === toolName)
  if (match === undefined) {
    return null
  }

  // For a local install, dotnet will search up in the directory tree until it finds a ".config" directory with a tool manifest, but
  // that might not be obvious to the caller, so log a warning with the path to the manifest that was used if it's not int the cwd.
  if (!globalInstall && !fs.existsSync(path.join(cwd, toolManifestPartialPath))) {
    log(`${Emoji.Warning} local tool install is not in the current working directory - it is listed as ${match.manifest}`)
  }

  return match.version
}

/**
 * Ensures the latest version of `dotnet-reportgenerator-globaltool` is installed as a "dotnet local tool" in the current
 * working directory with the latest version that is compatible with the latest dotnet SDK version currently installed.
 * 
 * This package is used to convert code coverage data into a human-readable report: https://github.com/danielpalme/ReportGenerator
 * 
 * Unsure why the name of the tool has "global" in it - it is neither local nor global (can be installed as either).
 * 
 * Use {@link ensureDotnetTool} directly for different options.
 */
export async function ensureReportGeneratorTool() {
  await ensureDotnetTool('dotnet-reportgenerator-globaltool')
}

/**
 * Spawns a process that runs the following commands to clean and re-install the dotnet dev certs:
 * - dotnet dev-certs https --clean
 * - dotnet dev-certs https -t
 */
export async function configureDotnetDevCerts() {
  await spawnAsync('dotnet', ['dev-certs', 'https', '--clean'])
  await spawnAsync('dotnet', ['dev-certs', 'https', '-t'])
}

// This immutable const is used for the type guard.
// There is also a non-immutable array to allow something like: const isValidTfm = targetFrameworkMonikers.includes(someStringVar)
// See link on type TargetFrameworkMoniker
const targetFrameworkMonikersImmutable = [
  'netcoreapp1.0',
  'netcoreapp1.1',
  'netcoreapp2.0',
  'netcoreapp2.1',
  'netcoreapp2.2',
  'netcoreapp3.0',
  'netcoreapp3.1',
  'net5.0',
  'net6.0',
  'net7.0',
  'net8.0',
  'net9.0',
  'net10.0',
  'netstandard1.0',
  'netstandard1.1',
  'netstandard1.2',
  'netstandard1.3',
  'netstandard1.4',
  'netstandard1.5',
  'netstandard1.6',
  'netstandard2.0',
  'netstandard2.1',
  'net11',
  'net20',
  'net35',
  'net40',
  'net403',
  'net45',
  'net451',
  'net452',
  'net46',
  'net461',
  'net462',
  'net47',
  'net471',
  'net472',
  'net48',
  'netcore',
  'netcore45',
  'netcore451',
  'netmf',
  'sl4',
  'sl5',
  'wp',
  'wp7',
  'wp75',
  'wp8',
  'wp81',
  'wpa81',
  'uap',
  'uap10.0',
  'net5.0-windows',
  'net6.0-android',
  'net6.0-ios',
  'net6.0-maccatalyst',
  'net6.0-macos',
  'net6.0-tvos',
  'net6.0-windows',
  'net7.0-android',
  'net7.0-ios',
  'net7.0-maccatalyst',
  'net7.0-macos',
  'net7.0-tvos',
  'net7.0-windows',
  'net8.0',
  'net8.0-android',
  'net8.0-browser',
  'net8.0-ios',
  'net8.0-maccatalyst',
  'net8.0-macos',
  'net8.0-tvos',
  'net8.0-windows',
  'net9.0-android',
  'net9.0-browser',
  'net9.0-ios',
  'net9.0-maccatalyst',
  'net9.0-macos',
  'net9.0-tizen',
  'net9.0-tvos',
  'net9.0-windows',
  'net10.0-android',
  'net10.0-browser',
  'net10.0-ios',
  'net10.0-maccatalyst',
  'net10.0-macos',
  'net10.0-tizen',
  'net10.0-tvos',
  'net10.0-windows'
] as const

/**
 * Type guard for valid .net framework TFMs (target framework moniker).
 * 
 * See https://learn.microsoft.com/en-us/dotnet/standard/frameworks
 */
export type TargetFrameworkMoniker = typeof targetFrameworkMonikersImmutable[number]

/**
 * Scraped from https://learn.microsoft.com/en-us/dotnet/standard/frameworks.
 * No intention to actually support operations for all of these, but having a list allows checking if a string
 * is a valid TFM (target framework moniker) - see type guard: {@link TargetFrameworkMoniker}.
 * 
 * @example
 * ```
 * const isValidTfm = targetFrameworkMonikers.includes(someStringVar)
 * ```
 */
export const targetFrameworkMonikers: string[] = [...targetFrameworkMonikersImmutable]

export function isValidTargetFrameworkMoniker(targetFrameworkMoniker: string) {
  return targetFrameworkMonikers.includes(targetFrameworkMoniker)
}

const dotnetCoreTargetFrameworkMonikersImmutable = [
  'net5.0',
  'net6.0',
  'net7.0',
  'net8.0',
  'net9.0',
  'net10.0'
] as const

/**
 * Type guard for {@link dotnetCoreTargetFrameworkMonikers}.
 */
export type DotnetCoreTargetFrameworkMoniker = typeof dotnetCoreTargetFrameworkMonikersImmutable[number]

/**
 * Subset of {@link targetFrameworkMonikers} with modern dotnet core versions.
 * 
 * Most of my scripting will only support modern versions of dotnet core, so this will often be used for checks instead of the full list.
 */
export const dotnetCoreTargetFrameworkMonikers: string[] = [...dotnetCoreTargetFrameworkMonikersImmutable]

/**
 * Check if a string is a valid TFM (Target Framework Moniker) in the form "netX.Y" where X is a number >= 5 and Y is any number.
 * @param targetFrameworkMoniker The dotnet target framework moniker to check.
 * @returns `true` if the string is a properly formatted "netX.Y" TFM, `false` otherwise
 */
export function isTfmNet5Plus(targetFrameworkMoniker: string) {
  requireString('targetFrameworkMoniker', targetFrameworkMoniker)
  const netFormatPattern = /^net([5-9]|\d{2,})\.\d+$/
  return netFormatPattern.test(targetFrameworkMoniker)
}

/**
 * Simple helper method to convert one of the newer dotnet core TFM's to the major SDK version number in a safe way.
 */
export function netCoreTfmToSdkMajorVersion(tfm: TargetFrameworkMoniker) {
  if (!targetFrameworkMonikers.includes(tfm)) {
    throw new Error(`Invalid TFM: ${tfm}`)
  }
  if (!dotnetCoreTargetFrameworkMonikers.includes(tfm)) {
    throw new Error(`TFM "${tfm}" is not supported - this method only allows newer dotnet core versions: ${dotnetCoreTargetFrameworkMonikers.join(', ')}`)
  }
  return parseInt(tfm[3], 10)
}

/**
 * Get sorted SDK version numbers for dotnet core 5+ (from {@link dotnetCoreTargetFrameworkMonikers}).
 */
export function getDotnetCoreSdkVersions() {
  const versions: number[] = []
  for (const tfm of dotnetCoreTargetFrameworkMonikers) {
    const dotIndex = tfm.indexOf('.')
    if (dotIndex === -1 || !tfm.startsWith('net')) {
      continue
    }
    const numString = tfm.substring(3, dotIndex)
    versions.push(parseInt(numString, 10))
  }
  return [...versions].sort((a, b) => a - b)
}

/**
 * Simple helper method to convert an SDK version to the TFM (target framework moniker). Only supporting new dotnet core versions.
 */
export function sdkVersionToTfm(sdkVersion: number): TargetFrameworkMoniker {
  if (typeof sdkVersion !== 'number' || sdkVersion < 5 || sdkVersion > 8) {
    throw new Error(`Invalid SDK version: ${sdkVersion} (only supports version >= 5 and <= 8)`)
  }
  return `net${sdkVersion}.0` as TargetFrameworkMoniker
}

// See https://learn.microsoft.com/en-us/dotnet/core/rid-catalog
// Also called "RUNTIME_IDENTIFIER" or RID.
const runtimeIdsImmutable = [
  'win-x64',
  'win-x86',
  'win-arm64',
  'linux-x64', // Most desktop distributions like CentOS, Debian, Fedora, Ubuntu, and derivatives
  'linux-musl-x64', // Lightweight distributions using musl like Alpine Linux
  'linux-musl-arm64', // Used to build Docker images for 64-bit Arm v8 and minimalistic base images
  'linux-arm', // Linux distributions running on Arm like Raspbian on Raspberry Pi Model 2+
  'linux-arm64', // Linux distributions running on 64-bit Arm like Ubuntu Server 64-bit on Raspberry Pi Model 3+
  'linux-bionic-arm64', // Distributions using Android's bionic libc, for example, Termux
  'osx-x64', // Minimum OS version is macOS 10.12 Sierra
  'osx-arm64',
  'ios-arm64',
  'android-arm64'
] as const

export const runtimeIds: string[] = [...runtimeIdsImmutable]

export type DotnetRuntimeIdentifier = typeof runtimeIdsImmutable[number]
