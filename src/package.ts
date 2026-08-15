import { createRequire } from 'node:module'

interface PackageMetadata {
  version: string
}

const metadata = createRequire(import.meta.url)('../package.json') as PackageMetadata

/** Runtime package version used in the App Server client handshake. */
export const packageVersion = metadata.version
