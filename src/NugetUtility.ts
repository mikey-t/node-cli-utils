import { DotnetVersion } from './DotnetVersion.js'
import { TargetFrameworkMoniker, isValidTargetFrameworkMoniker } from './dotnetUtils.js'
import { ExtendedError, findAllIndexes, getNormalizedError, requireString, sleep, trace } from './generalUtils.js'

type NugetVersionCompatibilityList = { [packageName: string]: { [T in TargetFrameworkMoniker]?: number } }

const FETCH_INIT: RequestInit = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
  }
}

// Generate new list with swig task "generateNugetLandingUrls" and check landing pages manually (automated method on all packages and TFMs results in 429 rate limit errors).
/**
 * List of known compatible major package versions with respect to dotnet framework version.
 */
export const nugetPackageCompatibilityList: NugetVersionCompatibilityList = {
  'Microsoft.EntityFrameworkCore': { 'net6.0': 7, 'net7.0': 7, 'net8.0': 9, 'net9.0': 9, 'net10.0': 10 },
  'Microsoft.EntityFrameworkCore.Design': { 'net6.0': 7, 'net7.0': 7, 'net8.0': 9, 'net9.0': 9, 'net10.0': 10 },
  'Microsoft.EntityFrameworkCore.Relational': { 'net6.0': 7, 'net7.0': 7, 'net8.0': 9, 'net9.0': 9, 'net10.0': 10 },
  'Npgsql.EntityFrameworkCore.PostgreSQL': { 'net6.0': 7, 'net7.0': 7, 'net8.0': 9, 'net9.0': 9, 'net10.0': 10 },
  'dotnet-ef': { 'net6.0': 7, 'net7.0': 7, 'net8.0': 10, 'net9.0': 10, 'net10.0': 10 }
}

export interface NugetUtilityDependencies {
  nugetAccessor: INugetAccessor
}

export class NugetUtility {
  private readonly genericParsingErrorMessage = `Unexpected nuget.org html format (enable trace for more detail): `
  private readonly htmlClassFrameworksTable = 'framework-table-frameworks'
  private readonly htmlClassDirectCompatibility = 'framework-badge-asset'
  private readonly htmlClassComputedCompatibility = 'framework-badge-computed'

  private nugetAccessor: INugetAccessor

  constructor(dependencies: Partial<NugetUtilityDependencies> = {}) {
    this.nugetAccessor = dependencies.nugetAccessor ?? new NugetAccessor()
  }

  static getNugetLandingPageUrl(packageName: string, packageVersion: string): string {
    return `https://www.nuget.org/packages/${packageName}/${packageVersion}`
  }

  static getVersionsJsonUrl(packageName: string) {
    return `https://api.nuget.org/v3-flatcontainer/${packageName}/index.json`.toLowerCase()
  }

  /**
   * Same as {@link getLatestNugetPackageVersion}, except it first pulls from a hard-coded list, and only if it isn't found will it reach out to nuget.org to screen
   * scrape and use their best guess. Only returns the major version - use it to import a package with wildcard syntax, for example: `dotnet add package SomePackage -v 7.*`.
   * 
   * Useful for packages like the EntityFramework that is technically compatible with versions of .net that they actually don't work with because of runtime
   * dependencies of the dotnet-ef tool.
   */
  getLatestMajorNugetPackageVersion = async (packageName: string, targetFrameworkMoniker: TargetFrameworkMoniker): Promise<number | null> => {
    trace(`checking the hard-coded list for package ${packageName}`)
    if (Object.keys(nugetPackageCompatibilityList).includes(packageName) && Object.keys(nugetPackageCompatibilityList[packageName]).includes(targetFrameworkMoniker)) {
      return nugetPackageCompatibilityList[packageName][targetFrameworkMoniker]!
    }
    trace(`package ${packageName} not found in hard-coded list - calling getLatestNugetPackageVersion`)
    const latestVersion = await this.getLatestNugetPackageVersion(packageName, targetFrameworkMoniker)
    if (latestVersion === null) {
      return null
    }
    return new DotnetVersion(latestVersion).major
  }

  // Helper method with some duplicated functionality from getLatestNugetPackageVersion - using for diagnostics
  getAllNugetVersions = async (packageName: string): Promise<NugetVersion[]> => {
    this.validatePackageName(packageName)
    const allVersionsJson = await this.nugetAccessor.getAllVersionsJson(packageName)
    const allNugetVersions = this.getAllNugetVersionsFromJson(packageName, allVersionsJson)
    return allNugetVersions
  }

  /**
   * Get the newest version number for the nuget package that is compatible with the specified .net version. This logic scrapes nuget.org to take a guess. Note that
   * that's all it is - a guess. Nuget doesn't actually know anything about compatibility and is also taking giant guesses based on package transitive dependencies
   * and general compatibilities between framework versions. Nuget does not actually guarantee any type of real compatibility in any sense of the word - it just pulls
   * the latest version when you add a package unless you specify one, and you won't know if it's compatible until a restore or build command happens. This method is
   * an attempt to at least use the nuget.org guess instead of just using the latest version.
   * @param packageName The nuget package name to evaluate.
   * @param targetFrameworkMoniker The .net framework version, for example "net8.0" or "net10.0"
   * @returns A version string for the latest nuget package that is compatible with the specified .net framework, or `null` if there wasn't a compatible version found.
   * @throws If the package does not exist.
   * @throws If the nuget API is unreachable.
   * @throws If the nuget.org package landing page is unreachable or it's html format for compatible .net frameworks changes.
   */
  getLatestNugetPackageVersion = async (packageName: string, targetFrameworkMoniker: TargetFrameworkMoniker): Promise<string | null> => {
    this.validatePackageName(packageName)
    this.validateFrameworkVersion(targetFrameworkMoniker)

    const allVersionsJson = await this.nugetAccessor.getAllVersionsJson(packageName)
    const allNugetVersions = this.getAllNugetVersionsFromJson(packageName, allVersionsJson)
    const mostRecentMajorVersions = this.getLatestMajorVersions(allNugetVersions)
    const sortedVersions = [...mostRecentMajorVersions].sort((a, b) => b.major - a.major)

    for (const majorVersion of sortedVersions) {
      const landingPageUrl = NugetUtility.getNugetLandingPageUrl(packageName, majorVersion.full)
      const landingPageHtml = await this.nugetAccessor.getPackageLandingPageHtml(packageName, majorVersion.full)
      const compatibleFrameworks = this.extractCompatibleFrameworks(landingPageHtml, landingPageUrl)
      if (compatibleFrameworks.some(f => f.targetFrameworkMoniker === targetFrameworkMoniker)) {
        return majorVersion.full
      }
    }

    return null
  }

  validatePackageName(packageName: string) {
    requireString('packageName', packageName)
    const validNugetPattern = /^[a-zA-Z0-9_.-]+$/
    if (!validNugetPattern.test(packageName)) {
      throw new Error(`Package name has invalid characters (must consist of only numbers, letters, underscores, dots and dashes): ${packageName}`)
    }
  }

  private validateFrameworkVersion(targetFrameworkMoniker: string) {
    if (!isValidTargetFrameworkMoniker(targetFrameworkMoniker)) {
      throw new Error(`Invalid targetFrameworkMoniker: ${targetFrameworkMoniker}. See https://learn.microsoft.com/en-us/dotnet/standard/frameworks.`)
    }
  }

  private extractCompatibleFrameworks(nugetLandingPageHtml: string, urlForErrorMessage: string): NugetFrameworkCompatibility[] {
    const tableIndexes = findAllIndexes(nugetLandingPageHtml, this.htmlClassFrameworksTable)

    if (tableIndexes.length === 0) {
      trace(`no tables with class ${this.htmlClassFrameworksTable}`)
      throw new Error(this.getGenericParsingError(urlForErrorMessage))
    }

    const compatibleFrameworks: NugetFrameworkCompatibility[] = []

    for (const tableStartIndex of tableIndexes) {
      const endIndex = nugetLandingPageHtml.indexOf('</td>', tableStartIndex)
      if (endIndex === -1) {
        trace(`could not find "</td>" in html after tableStartIndex: ${tableStartIndex}`)
        throw new Error(this.getGenericParsingError(urlForErrorMessage))
      }

      const frameworkTableHtml = nugetLandingPageHtml.substring(tableStartIndex, endIndex)
      compatibleFrameworks.push(...this.extractCompatibleFrameworksFromHtmlTableString(frameworkTableHtml, urlForErrorMessage))
    }

    return compatibleFrameworks
  }

  private extractCompatibleFrameworksFromHtmlTableString(htmlTable: string, urlForErrorMessages: string): NugetFrameworkCompatibility[] {
    const lines = htmlTable.replaceAll('\n', '').replaceAll('\r', '').split("<span").map(line => line.trim())

    const compatibleFrameworks: NugetFrameworkCompatibility[] = []

    for (const line of lines) {
      const isDirectCompatibility = line.includes(this.htmlClassDirectCompatibility)
      const isComputedCompatibility = line.includes(this.htmlClassComputedCompatibility)
      if (!isDirectCompatibility && !isComputedCompatibility) {
        continue
      }

      const spanOpeningTagEndBracketIndex = line.indexOf('>')
      if (spanOpeningTagEndBracketIndex === 0) {
        trace(`could not find ">" in html compatibility table on line: ${line}`)
        throw new Error(this.getGenericParsingError(urlForErrorMessages))
      }

      if (spanOpeningTagEndBracketIndex === (line.length - 1)) {
        trace(`the ">" was the last character in the html compatibility table on line: ${line}`)
        throw new Error(this.getGenericParsingError(urlForErrorMessages))
      }

      const endIndex = line.indexOf('<', spanOpeningTagEndBracketIndex)
      if (endIndex === -1) {
        trace(`could not find "<" in html compatibility table on line: ${line}`)
        throw new Error(this.getGenericParsingError(urlForErrorMessages))
      }

      const startIndex = spanOpeningTagEndBracketIndex + 1
      if (startIndex === endIndex) {
        trace(`the span value was empty for line (startIndex === endIndex): ${line}`)
        throw new Error(this.getGenericParsingError(urlForErrorMessages))
      }

      const val = line.substring(startIndex, endIndex).trim()

      if (!val) {
        trace(`the span value was empty for line: ${line}`)
        throw new Error(this.getGenericParsingError(urlForErrorMessages))
      }

      compatibleFrameworks.push({ targetFrameworkMoniker: val, isDirect: isDirectCompatibility })
    }

    return compatibleFrameworks
  }

  private getGenericParsingError(url: string) {
    return `${this.genericParsingErrorMessage}${url}`
  }

  // Does not currently support pre-release versions (they will be ignored)
  getLatestMajorVersions(versions: NugetVersion[]): NugetVersion[] {
    const dict: { [majorVersion: number]: NugetVersion } = {}

    trace('**************')
    trace(`versions: `, versions)
    trace('**************')

    for (const v of versions) {
      if (v.suffix !== undefined) {
        continue // Skip all pre-release package versions for now
      }
      if (!dict[v.major]) {
        dict[v.major] = v
        continue
      }
      if (v.isMoreRecentThan(dict[v.major])) {
        dict[v.major] = v
      }
    }

    return Object.values(dict)
  }

  private getAllNugetVersionsFromJson(packageName: string, jsonString: string) {
    let parsedJson: { versions: string[] }

    try {
      parsedJson = JSON.parse(jsonString)
    } catch (error) {
      throw new Error(`Could not parse Nuget response - invalid JSON string: ${jsonString}`, { cause: error })
    }

    if (!Array.isArray(parsedJson.versions)) {
      throw new Error('Could not parse Nuget response - the versions property is not an array')
    }

    const versionStrings = parsedJson.versions

    return (versionStrings).map(v => new NugetVersion(packageName, v))
  }
}

/**
 * A `false` `isDirect` property denotes computed compatibility.
 */
export interface NugetFrameworkCompatibility {
  isDirect: boolean
  targetFrameworkMoniker: string
}

/**
 * Use this class to convert a package name and version string into an object.
 */
export class NugetVersion {
  packageName: string
  full: string
  major: number
  minor: number
  patch: number
  suffix?: string

  constructor(packageName: string, version: string) {
    const dotnetVersion = new DotnetVersion(version)
    if (!packageName || packageName.trim() !== packageName || packageName === '') {
      this.throwGenericError(`invalid package name: ${packageName}`)
    }
    const urlEncodedPackageName = encodeURIComponent(packageName)
    if (urlEncodedPackageName !== packageName) {
      this.throwGenericError(`url encoded package name is does not match the packageName: ${packageName}`)
    }
    this.packageName = urlEncodedPackageName
    this.full = version
    this.major = dotnetVersion.major
    this.minor = dotnetVersion.minor
    this.patch = dotnetVersion.patch
    this.suffix = dotnetVersion.suffix
  }

  /**
   * **Important:** no pre-release version support (no suffix evaluation).
   */
  isMoreRecentThan = (otherVersion: NugetVersion) => {
    if (this.suffix !== undefined || otherVersion.suffix !== undefined) {
      throw new Error('No support for pre-release versions')
    }
    if (this.major !== otherVersion.major) {
      return this.major > otherVersion.major
    }
    if (this.minor !== otherVersion.minor) {
      return this.minor > otherVersion.minor
    }
    return this.patch > otherVersion.patch
  }

  private throwGenericError = (reason?: string) => {
    const reasonPart = reason ? ` (${reason})` : ''
    throw new Error(`Invalid nuget version string${reasonPart}: ${this.full}`)
  }
}

export interface INugetAccessor {
  getAllVersionsJson(packageName: string): Promise<string>
  getPackageLandingPageHtml(packageName: string, packageVersion: string): Promise<string>
  getNuspec(packageName: string, versionString: string): Promise<string>
}

// Important: at one point the API calls were working with PascalCase package ids, but it seems to have been changed to require all lowercase package ids now
export class NugetAccessor implements INugetAccessor {
  private readonly DEFAULT_NUM_RETRIES = 3

  // Template URL: https://api.nuget.org/v3-flatcontainer/{package_id}/index.json
  // Example for EF package: https://api.nuget.org/v3-flatcontainer/microsoft.entityframeworkcore.design/index.json
  getAllVersionsJson = async (packageName: string, numRetries = this.DEFAULT_NUM_RETRIES): Promise<string> => {
    const nugetVersionsUrl = NugetUtility.getVersionsJsonUrl(packageName)

    trace(`getting all package versions json from url: ${nugetVersionsUrl}`)

    let lastError: unknown

    // First try PLUS retries
    for (let attemptNumber = 1; attemptNumber <= numRetries + 1; attemptNumber++) {
      if (attemptNumber > 1) {
        await sleep(1500)
      }
      try {
        const response = await fetch(nugetVersionsUrl, FETCH_INIT)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }
        return await response.text()
      } catch (err: unknown) {
        lastError = err
        trace(`error attempting to get json on attempt number ${attemptNumber} - num retries left: ${(numRetries + 1) - attemptNumber}`, getNormalizedError(err))
      }
    }

    const message = `Could not retrieve all package versions for URL ${nugetVersionsUrl} after ${numRetries + 1} attempts - see extended error for last retry error`

    throw new ExtendedError(message, getNormalizedError(lastError))
  }

  // The code to calculate computed framework compatibility is complicated and there isn't an API endpoint. Instead of writing an entire app that
  // pulls in the NuGet.Client SDK, I'm just going to grab the html from the nuget.org landing page for the package. For reference, here is the code that computes
  // this for the nuget.org site: https://github.com/NuGet/NuGetGallery/blob/e6a38a882007374b320420645f63cc30f2a93e4d/src/NuGetGallery.Core/Services/AssetFrameworkHelper.cs
  async getPackageLandingPageHtml(packageName: string, packageVersion: string, numRetries = this.DEFAULT_NUM_RETRIES): Promise<string> {
    const nugetPackageUrl = NugetUtility.getNugetLandingPageUrl(packageName, packageVersion)

    trace(`getting nuget.org landing page html from url: ${nugetPackageUrl}`)

    let lastError: unknown

    for (let attemptNumber = 1; attemptNumber <= numRetries + 1; attemptNumber++) {
      if (attemptNumber > 1) {
        await sleep(1500)
      }
      try {
        const response = await fetch(nugetPackageUrl, FETCH_INIT)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }
        return await response.text()
      } catch (err: unknown) {
        lastError = err
        trace(`error attempting to get landing page html on attempt number ${attemptNumber} - num retries left: ${(numRetries + 1) - attemptNumber}`, getNormalizedError(err))
      }
    }

    const message = `Could not retrieve landing page html for URL ${nugetPackageUrl} after ${numRetries + 1} attempts - see extended error for last retry error`

    throw new ExtendedError(message, getNormalizedError(lastError))
  }

  // Template URL: https://api.nuget.org/v3-flatcontainer/{package_id}/{version}/{package_id}.nuspec
  // Example for EF package version 7.0.14: https://api.nuget.org/v3-flatcontainer/microsoft.entityframeworkcore.design/7.0.14/microsoft.entityframeworkcore.design.nuspec
  async getNuspec(packageName: string, versionString: string, numRetries = this.DEFAULT_NUM_RETRIES): Promise<string> {
    const nugetNuspecUrl = `https://api.nuget.org/v3-flatcontainer/${packageName}/${versionString}/${packageName}.nuspec`.toLocaleLowerCase()

    trace(`getting nuspec file from url: ${nugetNuspecUrl}`)

    let lastError: unknown

    // First try PLUS retries
    for (let attemptNumber = 1; attemptNumber <= numRetries + 1; attemptNumber++) {
      if (attemptNumber > 1) {
        await sleep(1500)
      }
      try {
        const response = await fetch(nugetNuspecUrl, FETCH_INIT)
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }
        return await response.text()
      } catch (err: unknown) {
        lastError = err
        trace(`error attempting to get json on attempt number ${attemptNumber} - num retries left: ${(numRetries + 1) - attemptNumber}`, getNormalizedError(err))
      }
    }

    const message = `Could not retrieve nuspec for URL ${nugetNuspecUrl} after ${numRetries + 1} attempts - see extended error for last retry error`

    throw new ExtendedError(message, getNormalizedError(lastError))
  }
}

const defaultNugetUtility = new NugetUtility()

export const getLatestNugetPackageVersion = defaultNugetUtility.getLatestNugetPackageVersion
export const validatePackageName = defaultNugetUtility.validatePackageName
export const getLatestMajorNugetPackageVersion = defaultNugetUtility.getLatestMajorNugetPackageVersion
