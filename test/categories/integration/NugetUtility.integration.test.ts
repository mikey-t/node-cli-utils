import assert from 'node:assert'
import { describe, it } from 'node:test'
import { TargetFrameworkMoniker, getLatestNugetPackageVersion } from '../../../src/dotnetUtils.js'
import { StringKeyedDictionary } from '../../../src/generalUtils.js'

interface PackageExpectedVersionInfo {
  packageName: string
  versionMap: StringKeyedDictionary
}

const packages: PackageExpectedVersionInfo[] = [
  {
    packageName: 'Microsoft.EntityFrameworkCore.Design',
    versionMap: {
      'net6.0': '7',
      'net7.0': '7',
      'net8.0': '9',
      'net9.0': '9',
      'net10.0': '10'
    }
  },
  {
    packageName: 'Newtonsoft.Json',
    versionMap: {
      'net5.0': '13',
      'net6.0': '13',
      'net7.0': '13',
      'net8.0': '13',
      'net9.0': '13',
      'net10.0': '13'
    }
  }
]

for (const packageInfo of packages) {
  describe(`getLatestNugetPackageVersion live tests for package ${packageInfo.packageName}`, () => {
    for (const netVersion of Object.keys(packageInfo.versionMap)) {
      const expectedPackageVersionMajor = packageInfo.versionMap[netVersion]
      it(`returns ${expectedPackageVersionMajor} as the major version for .net version ${netVersion}`, async () => {
        const version = await getLatestNugetPackageVersion(packageInfo.packageName, netVersion as TargetFrameworkMoniker)

        assert.notStrictEqual(version, null, `null should not be returned for .net version ${netVersion}`)
        assert.strictEqual(version!.length > 0, true, `result was empty for .net version ${netVersion}`)

        const dotIndex = version!.indexOf('.')
        const actualMajorVersion = dotIndex === -1 ? version : version!.substring(0, dotIndex)

        assert.strictEqual(actualMajorVersion, expectedPackageVersionMajor, 'did not receive the expected major version')
      })
    }
  })
}
