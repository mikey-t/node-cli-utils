// runWhileParentAlive.ts
// Also referred to as "orphan protection" or "long running windows process workaround script"
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { config } from './NodeCliUtilsConfig.js'

const DEV_LOGGING = false // Set to true while developing this script to see more logging in the console
let loggingEnabled = true // Will be set below by process.argv[2] === 'true' from spawnAsync in generalUtils.js
let traceEnabled = true // Will be set below by process.argv[3] === 'true' from spawnAsync in generalUtils.js
let pollingMillis: number // Will be set by process.argv[4] from spawnAsync in generalUtils.js, or default to config value

function getLogPrefix() {
  const now = new Date()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  const seconds = now.getSeconds().toString().padStart(2, '0')
  const milliseconds = now.getMilliseconds().toString().padStart(3, '0')
  return `[${hours}:${minutes}:${seconds}:${milliseconds}] `
}

// Using this trace method instead of importing from generalUtils.js since config is not shared between processes
export function trace(message?: unknown, ...optionalParams: unknown[]) {
  const prefix = `[TRACE]`
  console.log(prefix, message, ...optionalParams)
}

function logToFile(message: string) {
  const logLine = `${getLogPrefix()}${message}` + (!message?.endsWith('\n') ? '\n' : '')
  fs.appendFileSync(config.orphanProtectionLoggingPath, logLine)
}

function traceAndLog(message: string, isDevTrace = false) {
  if (isDevTrace && !DEV_LOGGING) {
    return
  }
  if (isDevTrace && DEV_LOGGING) {
    trace(getLogPrefix() + message)
    logToFile(message)
    return
  }
  if (traceEnabled) {
    trace(getLogPrefix() + message)
  }
  if (loggingEnabled) {
    logToFile(message)
  }
}

function isParentProcessAlive(parentId: number) {
  try {
    const result = spawnSync('C:\\Windows\\system32\\tasklist.exe')
    const resultToLog = {
      status: result.status,
      stderr: result.stderr?.toString(),
      stdoutIncludesParentId: result.stdout?.toString().includes(parentId.toString()) ?? false
    }
    traceAndLog('tasklist result: ' + JSON.stringify(resultToLog), true)
    return resultToLog.stdoutIncludesParentId
  } catch (err) {
    if (err instanceof Error) {
      console.log(err.message)
      console.log(err.stack)
    } else {
      console.error(err)
    }
    traceAndLog(`Error attempting to get task list using 'tasklist' - returning false for isParentAlive(): ${err instanceof Error ? err.toString() : err}`)
    return false
  }
}

function killTree(pid: number) {
  try {
    spawnSync(`C:\\Windows\\system32\\taskkill.exe /pid ${pid} /T /F`)
    traceAndLog(`No errors running killTree`)
  } catch (err) {
    traceAndLog(`Error running taskkill with PID ${pid}: ${err instanceof Error ? err.toString() : err}`)
  }
}

try {
  loggingEnabled = process.argv[2] === 'true'
  traceEnabled = process.argv[3] === 'true'
  pollingMillis = Number(process.argv[4])
  if (Number.isNaN(pollingMillis) || pollingMillis < 0 || pollingMillis > (3600 * 1000)) {
    pollingMillis = config.orphanProtectionPollingIntervalMillis
  }
  const passthroughArgs = process.argv.slice(5)
  const command = passthroughArgs[0]
  let deserializedArgs: string[] = []
  if (passthroughArgs.length > 1) {
    deserializedArgs = (JSON.parse(Buffer.from(passthroughArgs[1], 'base64').toString('utf8')) as string[]).map(x => x.indexOf(' ') !== -1 && !x.startsWith('"') && !x.endsWith('"') ? `"${x}"` : x)
  }

  if (loggingEnabled) {
    traceAndLog(`Logging enabled with polling rate set to: ${pollingMillis}ms`)
    traceAndLog(`Trace enabled: ${traceEnabled}`)
  }

  if (DEV_LOGGING) {
    const argvString = JSON.stringify(process.argv)
    console.log(argvString)
    logToFile(argvString)
    traceAndLog(`process.argv[2] (logging enabled): ${process.argv[2]}`, true)
    traceAndLog(`process.argv[3]   (trace enabled): ${process.argv[3]}`, true)
    traceAndLog(`process.argv[4]  (polling millis): ${process.argv[4]}`, true)
    traceAndLog(`passed through command: ${command}`)
    traceAndLog(`passed through deserialized args: ${deserializedArgs}`)
  }

  const parentId = process.ppid
  if (!parentId) {
    const noParentIdMessage = `Middle process cannot continue - parent process id not found`
    console.error(noParentIdMessage)
    traceAndLog(noParentIdMessage)
    process.exit(1)
  }

  const child = spawn(command, deserializedArgs, { stdio: 'inherit', shell: 'cmd.exe' })

  const childId = child.pid
  if (!childId) {
    const noChildIdMessage = 'spawning ChildProcess failed - no pid on returned handle'
    console.error(noChildIdMessage)
    traceAndLog(noChildIdMessage)
    process.exit(1)
  }

  const interval = setInterval(() => {
    if (!isParentProcessAlive(parentId)) {
      traceAndLog('Parent process is not alive. Shutting down.')
      killTree(childId)
      clearInterval(interval)
      traceAndLog('Used taskkill and cleared interval - exiting...')
      process.exit(0)
    }
    if (DEV_LOGGING) {
      traceAndLog('Parent is alive, keep running.')
    }
  }, pollingMillis)

  child.on('exit', (code, signal) => {
    const andSignal = signal ? ` and signal ${signal}` : ''
    traceAndLog(`ChildProcess exit event emitted with code ${code}${andSignal} - exiting`)
    clearInterval(interval)
    process.exit(code ?? 1)
  })

  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT']

  signals.forEach((signal) => {
    process.on(signal, () => {
      traceAndLog(`Middle process received signal ${signal} - will attempt to kill child process tree, clear interval and exit`)
      try {
        clearInterval(interval)
        traceAndLog(`Ran clearInterval in signal event ${signal} - exiting`)
        process.exit(0)
      } catch (err: unknown) {
        traceAndLog(`Error attempting to run clearInterval during signal event ${signal}: ${err instanceof Error ? err.toString() : err}`)
        process.exit(1)
      }
    })
  })
} catch (err) {
  const msg = `Unexpected error in runWhileParentAlive: ${err instanceof Error ? err.toString() : err}`
  console.error(msg)
  logToFile(msg)
  process.exit(1)
}

