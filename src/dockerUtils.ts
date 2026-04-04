import { execSync } from 'child_process'
import fs from 'node:fs'
import path from 'path'
import { config } from './NodeCliUtilsConfig.js'
import { Emoji, ExtendedError, SimpleSpawnResult, getNormalizedError, getPowershellHackArgs, isPlatformLinux, isPlatformWindows, log, requireString, requireValidPath, simpleSpawnAsync, spawnAsync, toWslPath, trace, which, withRetryAsync, wslPathExists } from './generalUtils.js'
import { SpawnOptionsInternal, spawnAsyncInternal, throwIfDockerNotReady } from './generalUtilsInternal.js'

/**
 * Type guard for command passed to {@link spawnDockerCompose}.
 */
export type DockerComposeCommand = 'build' | 'config' | 'cp' | 'create' | 'down' | 'events' | 'exec' | 'images' | 'kill' | 'logs' | 'ls' | 'pause' | 'port' | 'ps' | 'pull' | 'push' | 'restart' | 'rm' | 'run' | 'start' | 'stop' | 'top' | 'unpause' | 'up' | 'version'

const dockerComposeCommandsThatSupportDetached: DockerComposeCommand[] = ['exec', 'logs', 'ps', 'restart', 'run', 'start', 'stop', 'up']

/**
 * Check if the string is a valid docker compose project name:
 * 
 * - Must contain only lowercase letters, digits, dashes and underscores
 * - Must start with a lowercase letter or digit
 * 
 * See https://docs.docker.com/compose/environment-variables/envvars/#compose_project_name.
 * @param projectName The string to validate
 * @returns `true` if the string is a valid docker compose project name, `false` otherwise
 */
export function isValidDockerComposeProjectName(projectName: string): boolean {
  requireString('projectName', projectName)

  // Ensure first char is a lowercase letter or digit
  if (!/^[a-z0-9]/.test(projectName[0])) {
    return false
  }

  // Ensure the rest of the chars are only lowercase letters, digits, dashes and underscores
  return /^[a-z0-9-_]+$/.test(projectName)
}

/**
 * Check if the string is a valid docker container name:
 * 
 * - Must start with a letter or digit
 * - Contain only letters, digits, underscores and periods
 * - Must not end with a period
 * @param containerName The docker container name to validate.
 * @returns `true` if valid, `false otherwise
 */
export function isValidDockerContainerName(containerName: string) {
  return /[a-zA-Z0-9][a-zA-Z0-9_.-]+/.test(containerName) && !containerName.endsWith('.')
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
  * 
  * **Important:**: this only affects the current working directory of the spawned process itself. The docker command will still only pull in env values from a `.env`
  * file in the same directory as the docker-compose.yml, NOT the cwd passed here. If a different `.env` file path is needed, use the {@link altEnvFilePath} option. If
  * you use the {@link altEnvFilePath} option with a relative path, ensure that it is relative to the current working directory passed with this option.
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

  /**
   * The option `useWslPrefix` set to `true` can be used If Docker Desktop is not installed on Windows and docker commands need to execute via wsl.
   */
  useWslPrefix?: boolean

  /**
   * Specify an alternative env file. This is useful since docker will normally only use a `.env` file in the same directory as the docker-compose.yml file,
   * regardless of the current working directory of the running command. This path will be passed to docker compose using the `--env-file` option.
   * 
   * **Important:** if using a relative path, be sure pass the appropriate value for {@link cwd} to this method so that the relative path can correctly be resolved.
   */
  altEnvFilePath?: string
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
  if (options?.altEnvFilePath) {
    requireValidPath('altEnvFilePath', options.altEnvFilePath)
  }
  if (options?.projectName && !isValidDockerComposeProjectName(options.projectName)) {
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
  if (!options || options.useWslPrefix === undefined) {
    mergedOptions.useWslPrefix = config.useWslPrefixForDockerCommandsOnWindows
  }

  const dockerComposeDir = path.dirname(dockerComposePath)
  const dockerComposeFilename = path.basename(dockerComposePath)

  if (!mergedOptions.cwd) {
    mergedOptions.cwd = dockerComposeDir
  }

  let dockerComposePathResolved = mergedOptions.cwd ? path.resolve(dockerComposePath) : dockerComposeFilename
  if (mergedOptions.useWslPrefix) {
    dockerComposePathResolved = toWslPath(dockerComposePathResolved)
    if (!wslPathExists(dockerComposePathResolved)) {
      log(`${Emoji.Warning} Warning: spawnDockerCompose is using the wsl command prefix but the wsl path to the docker compose isn't accessible: ${dockerComposePathResolved}`)
      log(`Sometimes wsl "crashes" so that parts of it's filesystem disappear. If the windows version of the path definitely exists, try one of these options:`)
      log(`- Restart wsl (first run "wsl --shutdown", wait a few seconds, and then "wsl")`)
      log(`- Pass the 'useWslPrefix' option as 'false' to spawnDockerCompose`)
      log(`- Import 'config' from node-cli-utils and set 'useWslPrefixForDockerCommandsOnWindows' to false`)
    }
  }

  let spawnArgs = ['compose', '-f', dockerComposePathResolved]

  if (mergedOptions.projectName) {
    spawnArgs.push('--project-name', mergedOptions.projectName)
  }

  if (mergedOptions.profile) {
    spawnArgs.push('--profile', mergedOptions.profile)
  }

  if (mergedOptions.altEnvFilePath) {
    spawnArgs.push('--env-file', mergedOptions.useWslPrefix ? toWslPath(mergedOptions.altEnvFilePath) : mergedOptions.altEnvFilePath)
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

  trace(`docker compose command will be configured to use long running option: ${longRunning}`)

  const spawnOptions: Partial<SpawnOptionsInternal> = {
    cwd: mergedOptions.cwd,
    shell: isPlatformWindows(), // Early termination with ctrl + C on windows will not be graceful unless the shell option is set to true
    isLongRunning: longRunning,
    throwOnNonZero: false
  }

  const spawnResult = mergedOptions.useWslPrefix ?
    await spawnAsyncInternal('wsl', ['docker', ...spawnArgs], spawnOptions) :
    await spawnAsyncInternal('docker', spawnArgs, spawnOptions)

  // Code 130 is the code for ctrl-c, which we don't want to consider an error
  if (spawnResult.code !== 0 && spawnResult.code !== 130) {
    throw new Error(`docker compose command failed with code ${spawnResult.code}`)
  }
}

/**
 * Similar to {@link simpleSpawnAsync} but meant for `docker` calls only. Determines whether to run `docker` or `wsl docker` based
 * on platform being windows and config setting `useWslPrefixForDockerCommands`.
 * @param args The args to be passed to the docker command.
 */
export async function simpleSpawnDockerAsync(args: string[]): Promise<SimpleSpawnResult> {
  const command = config.useWslPrefixForDockerCommandsOnWindows ? 'wsl' : 'docker'
  const spawnArgs = command === 'docker' ? args : ['docker', ...args]
  return await simpleSpawnAsync(command, spawnArgs)
}

/**
* Uses {@link which} to determine if docker is installed. If the `which` call doesn't find docker and the platform
* is Windows, then this will check the output of `wsl docker --version` to see if just the engine is installed.
* @returns `true` if docker is installed, `false` otherwise
*/
export async function isDockerInstalled(): Promise<boolean> {
  if ((await which('docker')).location) {
    return true
  }
  if (isPlatformWindows()) {
    const result = await simpleSpawnAsync('wsl', ['docker', '--version'])
    return result.code === 0
  }
  return false
}

/**
 * Runs the `docker info` command and looks for "error during connect" in the output to determine if docker is running. If you
 * want to check if docker is installed, use {@link isDockerInstalled}.
 * @returns `true` if docker is installed and running, `false` otherwise
 */
export async function isDockerRunning(): Promise<boolean> {
  try {
    const result = isPlatformWindows() ?
      await simpleSpawnAsync('wsl', ['docker', 'info']) :
      await simpleSpawnAsync('docker', ['info'])
    return result.code === 0 && !result.stdout.includes('error during connect')
  } catch {
    return false
  }
}

/**
 * Attempt to start the docker service if it isn't running. Whether it's running is determined by a call to {@link isDockerRunning}.
 * 
 * Notes on docker startup command:
 * - May require entering a password
 * - On Windows with Docker Desktop and from within powershell or cmd it will run in powershell: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -NoNewWindow`
 * - On Windows without Docker Desktop from within powershell or cmd it will run: `sudo service docker start`
 * - On Linux (including WSL) it will run: `sudo systemctl start docker`
 * - Not currently supported on Mac
 * - If you're on Windows and have Docker Desktop but it is stopped and you're in a WSL shell, docker will appear as if it's not installed and this method will throw
 * 
 * @throws An {@link Error} If docker is not detected on the system.
 * @throws An {@link Error} if docker is detected as installed and not running but the OS is Mac.
 */
export async function ensureDockerRunning(): Promise<void> {
  if (!await isDockerInstalled()) {
    throw new Error('Docker does not appear to be installed')
  }

  if (await isDockerRunning()) {
    return
  }

  let command: string
  let args: string[] = []
  const isWindows = isPlatformWindows()
  const isLinux = isPlatformLinux()
  const dockerDesktopPath = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
  let useExec = false

  if (isWindows) {
    if (fs.existsSync(dockerDesktopPath)) {
      command = 'powershell'
      args = getPowershellHackArgs(`Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' -NoNewWindow`)
    } else {
      command = 'C:\\windows\\system32\\wsl.exe -u root -e sh -c "service docker start"'
      useExec = true
    }
  } else if (isLinux) {
    command = 'sudo'
    args = ['service', 'docker', 'start']
  } else {
    throw new Error('Starting docker within ensureDockerRunning is only supported on Windows and Linux - you will have to start docker manually')
  }

  if (useExec) {
    try {
      execSync(command, { stdio: 'inherit' })
    } catch (err) {
      throw new ExtendedError('Unable to start docker', getNormalizedError(err))
    }
  } else {
    const result = await spawnAsync(command, args, { shell: isWindows })
    if (result.code !== 0) {
      throw new Error('Unable to start docker - see error above')
    }
  }

  // Wait for docker to be up and ready before continuing
  await withRetryAsync(throwIfDockerNotReady, 6, 3000, { initialDelayMilliseconds: 3000 })
}

/**
 * The name of a docker volume to delete. Respects the config value `useWslPrefixForDockerCommands`.
 * @param volumeName The name of the docker volume to delete.
 * @throws An {@link ExtendedError} if the volume does not exist or the volume is in use.
 */
export async function deleteDockerComposeVolume(volumeName: string): Promise<void> {
  requireString('volumeName', volumeName)

  // Docker compose volume names will have the same character restrictions as docker compose project names
  if (!isValidDockerComposeProjectName(volumeName)) {
    throw new Error(`Invalid volume name: ${volumeName}`)
  }

  try {
    const composeVolumeName = await getDockerComposeVolumeName(volumeName)

    if (!composeVolumeName) {
      log(`volume ${volumeName} not found in docker compose config - skipping`)
      return
    }

    if (!await dockerVolumeExists(composeVolumeName)) {
      log(`docker compose volume ${composeVolumeName} does not appear to exist - skipping`)
      return
    }

    await deleteDockerVolume(composeVolumeName)
  } catch (err) {
    throw new ExtendedError(`Error removing the volume ${volumeName}`, getNormalizedError(err))
  }
}

/**
 * This function will take the volume name as you defined it in `docker-compose.yml` and try getting the actual volume name that docker
 * compose will use. This is needed because docker compose will prefix the volume name with the compose project name (directory name or env
 * `COMPOSE_PROJECT_NAME` or `-p` passed to docker compose commands).
 * 
 * This function respects the `useWslPrefixForDockerCommands` config option. See also: {@link deleteDockerComposeVolume}.
 * @param volumeName The volume name as defined in the `docker-compose.yml` file.
 * @returns The full name of the docker-compose-actualized docker volume.
 */
export async function getDockerComposeVolumeName(volumeName: string): Promise<string | undefined> {
  const result = await simpleSpawnDockerAsync(['compose', 'config', '--format', 'json'])
  const composeConfigJson = JSON.parse(result.stdout)
  return composeConfigJson?.volumes?.[volumeName]?.name
}

/**
 * Check if a docker volume exists based on inclusion of the specified `volumeName` in any of the output lines of `docker volume ls`.
 * 
 * This function respects the `useWslPrefixForDockerCommands` config option. See also: {@link deleteDockerComposeVolume}.
 * @param volumeName The docker volume name to check.
 * @returns `true` if the docker volume exists, otherwise `false`.
 */
export async function dockerVolumeExists(volumeName: string): Promise<boolean> {
  const result = await simpleSpawnDockerAsync(['volume', 'ls'])
  return result.stdoutLines.filter(ln => ln.includes(volumeName)).length > 0
}

/**
 * This will attempt to delete a docker volume using the `docker volume rm` command.
 * 
 * **Warning: ** there will be no prompt or confirmation before attempting to delete the volume.
 * 
 * This function respects the `useWslPrefixForDockerCommands` config option. See also: {@link deleteDockerComposeVolume}.
 * @param volumeName The name of the docker volume to delete.
 * @throws An {@link Error} if the volume doesn't exist or is in use.
 */
export async function deleteDockerVolume(volumeName: string): Promise<void> {
  trace(`deleting docker compose volume ${volumeName}`)
  await simpleSpawnDockerAsync(['volume', 'rm', volumeName])
}

/**
 * Helper method to attach to a running docker container and open a shell.
 * 
 * Requirements:
 * - Docker must be running
 * - The container must be running
 * - The docker compose file provided must exist and be valid
 * - The `containerName` passed must match what is in the docker compose file
 * - The running container must have `bash` installed and available to login to
 * @param dockerComposePath Path to the docker compose file to use (i.e. `docker-compose.yml`)
 * @param containerName The name of the container to attach to and start a shell
 */
export async function dockerComposeBash(dockerComposePath: string, containerName: string) {
  requireValidPath('dockerComposePath', dockerComposePath)
  requireString('containerName', containerName)
  if (containerName.indexOf(' ') !== -1 || containerName.indexOf(`'`) !== -1) {
    throw new Error(`Invalid containerName: ${containerName}`)
  }
  await spawnDockerCompose(dockerComposePath, 'exec', { args: ['-it', containerName, 'bash'], attached: true })
}
