# DevNotes for node-cli-utils

Writing down reminders and things I learned for future projects.

- [DevNotes for node-cli-utils](#devnotes-for-node-cli-utils)
  - [Reminders](#reminders)
  - [Change Release Checklist](#change-release-checklist)
  - [Local Npm Package Testing](#local-npm-package-testing)
  - [Unit Test Notes](#unit-test-notes)
    - [Test Command Notes](#test-command-notes)
    - [Test Command Examples](#test-command-examples)
    - [Test Framework and Test Execution](#test-framework-and-test-execution)
    - [Misc Testing Notes](#misc-testing-notes)
    - [Mocking Strategy (Dependency Injection)](#mocking-strategy-dependency-injection)
    - [Test Coverage Report](#test-coverage-report)
  - [Package Consumer Notes](#package-consumer-notes)
    - [Enable Trace](#enable-trace)
  - [Docker Desktop vs Daemon Only on Windows](#docker-desktop-vs-daemon-only-on-windows)
  - [SonarQube Quality/Security Scanning](#sonarqube-qualitysecurity-scanning)
  - [Updating API Docs](#updating-api-docs)
  - [Reasoning](#reasoning)
  - [NugetUtility Notes](#nugetutility-notes)
  - [Noteworthy Features](#noteworthy-features)
    - [Process Spawning Cross-Platform Workarounds](#process-spawning-cross-platform-workarounds)


## Reminders

New source files need to be referenced in `c8rc.json` to get code coverage analysis.

## Change Release Checklist

- Bump version in package.json
- (optional) `swig publishCheck` (⚠️ Requires admin shell - takes about 1:15 if sonar isn't up yet)
    - Runs lint
    - Runs build (esm and cjs)
    - Runs all tests (including integration tests, tar tests and cert tests)
    - Collects test coverage
    - Starts docker
    - Stars SonarQube (and waits for it to be ready)
    - Runs sonar scan
- `swig publish` (⚠️ It's required to first manually run `npm login`)
    - Runs lint and build
    - Runs subset of tests ("normal" tests only)
    - Runs npm publish command (it will prompt for multi-factor auth)
- (optional) `swig publishDocs` (⚠️ It's required to first manually run `npm login`)
    - Requires that you have the `node-cli-utils-docs` repo cloned as a sibling to this project repo on your machine
    - Runs the command to generate new docs (with the output being `../node-cli-utils-docs/docs`, which is configured in the `typedoc.json` file)
    - Uses the tsconfig.esm.json file
    - Commits and pushes to github, which will be automatically picked up by the "github pages" website (https://mikey-t.github.io/node-cli-utils-docs/)

## Local Npm Package Testing

TODO: update this section after experimenting with new tools/processes.

Steps to link:

- Check what is already linked: `npm ls --link=true`
- Within publishing package:
    - `npm link`
    - `swig build` OR `swig watch`
- Within consuming project:
    - Ensure you have already added the dependency normally (`npm i -D @mikeyt23/node-cli-utils`) and that the version semver notation allows the newest version (perhaps change version to "*" if testing a new major version)
    - `npm link @mikeyt23/node-cli-utils`

Steps to unlink:

- Within consuming package: `npm unlink @mikeyt23/node-cli-utils`
- Within publishing package: `npm unlink`
- Verify it's no longer linked: `npm ls --link=true`

## Unit Test Notes

Testing is wired up through the swig task called `test`. Test files are grouped into categories by directory under `./test/categories/` for easy lookup by the swig task.

### Test Command Notes

Test category params:

| Param  | Notes                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------- |
| `n`    | Normal tests. These will also be run if no other tests are specified.                             |
| `i`    | Integration tests. These will make live http calls to third parties and run real system commands. |
| `tar`  | Tarball tests that call actual system tar command. Adds 5-10 seconds.                             |
| `cert` | Cert tests. ⚠️Requires windows elevated prompt. ⚠️Windows only. Adds 20+ seconds.                   |

Special params:

| Param  | Notes                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `full` | Runs all tests including cert, tar and integration tests. Collects code coverage data. ⚠️Requires windows elevated prompt. ⚠️Windows only. |
| `o`    | Tests marked as "only" in the NodeJS test runner style: `{ only : true }`                                                                |
| `c`    | Collect code coverage data and output to `./coverage`. An html report will be generated at `./coverage/lcov-report/index.html`.          |
| `w`    | Run tests in watch mode for hot reload functionality.                                                                                    |

Misc test command notes:

- Params can be passed in any order
- The `full` param will override other params
- Watch param (`w`) notes:
  - Watch mode for the NodeJS test runner is listed as "experimental"
  - You may have to periodically restart for some types of file changes that break hot reloading
  - Watch mode param will be ignored if the `c` param or `full` params are passed

### Test Command Examples

Run all tests and collect coverage (requires admin prompt):

```
swig test full
```

Run all normal tests:

```
swig test
```

Run normal and integration tests in watch mode that are marked with `only`:

```
swig test n i w o
```

### Test Framework and Test Execution

I'm using the [built-in NodeJS test runner](https://nodejs.org/docs/latest-v18.x/api/test.html). I'm utilizing loaders to parse and run my typescript directly using [tsx](https://github.com/esbuild-kit/tsx). Tsx here doesn't stand for typescript JSX, but rather TypeScript eXecute. It's really, really fast. However, note that because it uses esbuild, if you switch between windows and WSL to run tests (which I do so I can verify my stuff works on windows and ubuntu), then you may need to run `npm install` when switching. This is because of the esbuild dependency.

### Misc Testing Notes

- The built-in NodeJS test runner is a bit lacking in some areas, but so far it seems to work ok
- The syntax for "only" testing is a little wonky (have to pass `{ only: true }` as a second param to `test` or `it`), so to ease that a bit I added this to testUtils.ts: `export const only = { only: true }`
- Note that using the "only" functionality requires adding the "only" option to both the test and it's parent (like a `describe` call) if it has one
- Using "only" on one test within a describe will cause any `beforeEach` and `afterEach` hooks to run for every other method in the `describe` block, even thought they're skipped. This can cause confusion if you're looking for some test output. The easiest way I found to workaround this is just to move your "only" test outside the describe block temporarily.

### Mocking Strategy (Dependency Injection)

Rather than using one of the "conventional" hacks to override the import system for mocking, I'm going to try using standard dependency injection patterns. But rather than exporting these new classes, I'll still export only the utility methods and not each entire class by re-exporting individual methods of a singleton class. This way the extra classes and dependency injection are invisible to consumers. For an example see [TarballUtility.ts](./src/TarballUtility.ts) and [TarballUtility.test.ts](./test/categories/normal/TarballUtility.test.ts) and where it's re-exported in [./src/index.ts](./src/index.ts).

This strategy has also been used for [NugetUtility.ts](./src/NugetUtility.ts) which is exporting functions in [dotnetUtils.ts](./src/dotnetUtils.ts). See normal unit tests in [NugetUtility.test.ts](./test/categories/normal/NugetUtility.test.ts) and integration tests in [NugetUtility.integration.test.ts](./test/categories/integration/NugetUtility.integration.test.ts).

### Test Coverage Report

I'm using [c8](https://github.com/bcoe/c8) for generating code coverage reports. Some notes on this:

- Config file is `.c8rc.json` and accepts the same args as the CLI (see docs linked above)
- Added, removed or renamed test files need to be updated in both `swigfile.ts` and `.c8rc.json`
- Generate a report by passing "c" to `swig test` (in addition to any other params wanted)
- Html report is generated in the `./coverage` directory (entry point: `./coverage/index.html`)
- I was previously using `ts-node/esm` when running coverage because it seemed to be more accurate, but it no longer functions as of node 24, so I've removed that and am only running with `tsx`
- Somewhat hilariously, c8 counts comments as lines of covered code, so adding comments increases percentage of coverage. Oof.
    - See https://github.com/bcoe/c8/issues/182
    - For now I'm ignoring the percentage and really just using the tool to tell me "number of uncovered lines", for which it's accurate
    - I may look into using some other tool if accuracy in the percentage numbers becomes more important to me

## Package Consumer Notes

When using the `node-cli-utils` functionality in my test project ([dotnet-react-sandbox](https://github.com/mikey-t/dotnet-react-sandbox)), I found that the code is more readable if I use namespace imports so that it's super clear when these utility methods are being called and aren't confused with other internal helper methods.

So the imports would look like this:

```javascript
import * as nodeCliUtils from '@mikeyt23/node-cli-utils'
import * as certUtils from '@mikeyt23/node-cli-utils/certUtils'
import * as dotnetUtils from '@mikeyt23/node-cli-utils/dotnetUtils'
```

And calls would like like this:

```javascript
await nodeCliUtils.ensureDirectory(releaseDir)
await certUtils.generateCertWithOpenSsl(url)
// etc
```

But you can also import individual methods.

### Enable Trace

Given this import:

```javascript
import * as nodeCliUtils from '@mikeyt23/node-cli-utils'
```

set trace enabled with:

```javascript
nodeCliUtils.config.traceEnabled = true
```

Or with this import:

```
import { config } from '@mikeyt23/node-cli-utils'
```

set trace enabled with:

```javascript
config.traceEnabled = true
```

## Docker Desktop vs Daemon Only on Windows

Due to Docker's change in license policy, more people are installing Docker on Windows without the full "Docker Desktop" functionality. Because of this it's important to be able to spawn docker commands with either `docker` OR `wsl docker`. I added functionality to all the docker utility functions to use `wsl docker` if the platform is detected as Windows. If you want the docker utility functions to use just `docker` instead of `wsl docker`, you can change a config value like this:

```javascript
import { config, isPlatformWindows } from '@mikeyt23/node-cli-utils'
config.useWslPrefixForDockerCommandsOnWindows = false
```

## SonarQube Quality/Security Scanning

Initial setup:

- We need to setup a kernel config value for elasticsearch to work. If on windows 10 and WSL 2:
    - Ensure `%USERPROFILE%/.wslconfig` has these lines:
    ```
    [wsl2]
    kernelCommandLine = "sysctl.vm.max_map_count=262144"
    ```
    - Restart WSL (shutdown with `wsl.exe shutdown`, wait 10 seconds, then open an ubuntu shell to trigger startup)
    - Start docker again if it isn't set to start automatically
- Copy `.env.template` to `.env`
- Start SonarQube for the first time: `swig dockerUp`
- Hit `http://localhost:9000` and wait for it to initialize (~15 seconds)
- Login with `admin`/`admin` and change password when it prompts
- Navigate to My Account -> Security and generate a new user token
- Add new token to `SONAR_TOKEN` in `.env`

Scan:

- In admin terminal, run: `swig test full`
- Run: `swig scan` (this also attempts to start docker and runs dockerUp and waits for sonar to be ready)
- Evaluate results at http://localhost:9000 (login with credentials you setup)
- When done with SonarQube, you can bring it down by running: `swig dockerDown`

Misc notes on SonarQube setup:

- Docker compose notes:
    - Syntax for using a default if not specified: `${SONAR_PORT:-9000}`
    - Syntax for requiring a env var and throwing if not set: `${SONAR_TOKEN:?}`
    - Unclear exactly what this does, but docs suggested setting the cache volume: `sonar_scanner_cache:/opt/sonar-scanner/.sonar/cache`
    - Setting the cache volume required setting the user to `root` so it could read/write to/from the cache. This probably isn't optimal - will re-visit later.
    - I wanted to define both services in a single docker compose so that the scanner can reference the server URL by docker service name, but I don't actually want both of them to run at the same time when running "docker compose up". Setting a profile on the scanner makes it so it doesn't start unless that profile flag is passed, or if the run command is called directly.
- Scanner run time was incredibly slow (5 minutes) until I set the `sonar.working.directory` to a directory within the docker container and then it runs in a reasonable amount of time (26 seconds). The relevant docker-compose.yml entry: `command: sh -c "mkdir -p /tmp/sonar-scanner && sonar-scanner -Dsonar.working.directory=/tmp/sonar-scanner"`

## Updating API Docs

- Ensure `typedoc.json` is up to date and has any new entry points
- Run: `swig genDocs`
- Commit and push the other repository these files get dumped into [node-cli-utils-docs](https://github.com/mikey-t/node-cli-utils-docs)

## Reasoning

NodeJS projects are out-of-control with the depth of their dependency trees. Rather than giving in to that trend, I'm attempting to maintain a collection of utilities using only built-in NodeJS functionality whenever possible, and only importing dependencies when I can't easily reproduce the functionality myself. And when I do import a dependency, it will preferably be one with a shallow dependency tree.

It's easy to argue that this solution isn't optimal, but there are some other reasons to re-invent the wheel sometimes:

- Sometimes counterintuitively, there's actually less work to keep things up to date because I don't have to audit dozens or hundreds or thousands of dependency and transitive dependency updates on a regular basis
- Significantly less (close to zero) risk of NPM supply chain attacks (which are getting more common by the day)
- Keeping NodeJS and Typescript skills up to date
- Control - do I know who to talk to for bug fixes or feature improvements? Of course I know him - he's me!

Originally I made an exception to this rule of no dependencies for [node-tar](https://github.com/isaacs/node-tar). However, I replaced this with a system call to the OS built-in `tar` utility since even Windows has this built-in since 2018.

Another package I included for a while was axios. I had a todo task for a long time to replace it, and the recent npm supply chain attack on it (April 2026) is what finally got that dependency removal task to the top of my list.

## NugetUtility Notes

TODO:
  - Research the Nuget query API and/or utilization of legacy V2 endpoints
  - If no better way is found, at least re-work this code to be more efficient to avoid 429 rate limiting errors, and to generally be more clean and maintainable

The Nuget utility functions exist because v3 of the Nuget API doesn't natively have the ability to provide the latest working version of a package given a target dotnet version (TFM or Target Framework Moniker). A Microsoft rep said in a github issue comment (https://github.com/NuGet/NuGetGallery/issues/9627#issuecomment-1972187467) that they would implement this functionality, but they don't seem to have ever gotten around to it.

A note on how the method `getLatestNugetPackageVersion` works: it essentially get's all versions via an http call to `https://api.nuget.org/v3-flatcontainer/{package_id}/index.json`, and for each major version starting with the latest and working backwards, it does an http call to the Nuget landing page (`https://www.nuget.org/packages/${packageName}/${packageVersion}`) and checks the "Frameworks" tab for the TFM in question. For example, calling this:
```TypeScript
await getLatestNugetPackageVersion('Microsoft.EntityFrameworkCore.Design', 'net8.0')
```

... will return a 9.x version instead of the previously returned 8.x version because it will get all major versions (10, 9, 8, etc) have accessed the latest 10.x landing page first (i.e. https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Design/10.0.5) and seen that 'net8.0' was not in the list of frameworks and then tried the latest 9.x landing page (i.e. https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Design/9.0.14#supportedframeworks-body-tab) and seen that 'net8.0' is in fact there, so it will return that 9.x version instead of continuing to lower versions (in this case, "9.0.14").

## Misc Reminders

### April 2026 Updates

After upgrading to Typescript 6, I had to adjust a couple things:
- Build versions of tsconfig files needed explicit rootDir and node types reference:
    ```json
    "compilerOptions": {
      //...
      "rootDir": "./src",
      //...
    },
    "types": [
      "node"
    ],
    ```
- `tsconfig.cjs.json` needed lib added: `"ES2022"`
- Removed unneeded deprecated setting from main `tsconfig.json`: `"baseUrl": "./"`

After updating typedoc I got warnings about JSDoc comments for params that didn't exist anymore, so I deleted those. I also started getting a warning about `parallel.ts` related to a comment link to NodeJS `Promise.allSettled` that required adding the following to `typedoc.json`:
```json
"externalSymbolLinkMappings": {
  "typescript": {
    "PromiseConstructor.allSettled": "#"
  }
}
```

## Noteworthy Features

### Process Spawning Cross-Platform Workarounds

Dev automation tasks in all my projects make heavy use of spawning child processes, but unfortunately there's a lot of issues that cause this to be inconsistent across platforms. I've attempted to normalize some of the more annoying edge cases. 

For example, sometimes the only way to get a command to work how you want on windows is to pass the `shell: true` option. One case where this is useful is for running commands for a long running process that you want to be able to terminate with `ctrl+c` when you're done with it. These are commands like `docker compose up`, or running a dev web server, or anything that runs until you stop it. But on windows when you use `ctrl+c` to terminate a process spawned without the `shell: true` option, it immediately kills all the processes in the tree without warning or signaling, which is bad if those processes need to shut down gracefully before exiting. For example, on windows if you use `ctrl+c` on `docker compose up` spawned by Node, you'll notice that the containers are still running even after the attached command exits. But if you do the same thing on a nix machine, docker is given the `SIGINT` signal and it gracefully stops the containers before shutting down.

But this issue is of the whack-a-mole variety, because if you do go ahead and pass the `shell: true` option, then unexpected termination of the parent process will simply orphan your child process tree, forcing you to kill it yourself manually, or with some other scripting.

So normally you can do one of a couple things so that your process spawning code works well on windows in addition to nix machines:

- Use another library where someone claims to have solved this completely in a cross-platform way (`press x to doubt`), and accept a non-trivial number of dependencies into your project
- Use the non-shell option and just deal with some commands terminating non-gracefully
- Use the shell option and just deal with long running processes sometimes getting orphaned

Instead I've chosen to create a couple of different wrapper methods for Node's spawn method. One calls spawn fairly normally (`spawnAsync` in [./src/generalUtils.ts](./src/generalUtils.ts)), with an additional option to control the exec-like functionality of throwing on non-zero return code if you want (via the `throwOnNonZero` option). Another wrapper is used for long running processes that uses the shell option, but if you're on windows does a nifty little hack to spawn a "middle" watchdog process that polls for whether the parent is alive or not and kills the child process tree if it becomes orphaned (see `spawnAsyncLongRunning` in [./src/generalUtils.ts](./src/generalUtils.ts)).

In the future I may go research how others have solved cross-platform process spawning, but for now this little hack works fine and prevents me from needing to add dependencies that have lots of transitive dependencies.
