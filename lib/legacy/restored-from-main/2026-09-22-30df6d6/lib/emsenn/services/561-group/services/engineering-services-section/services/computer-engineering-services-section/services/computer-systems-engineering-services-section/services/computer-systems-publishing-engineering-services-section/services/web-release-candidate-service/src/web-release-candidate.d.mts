export type ArtifactBody = string | Uint8Array;
export type ArtifactRecord = Readonly<{ body: ArtifactBody; mediaType?: string; cacheControl?: unknown; provenance?: unknown }>;
export type ArtifactInventory = Iterable<readonly [string, ArtifactBody | ArtifactRecord] | Readonly<{ path: string; body: ArtifactBody; mediaType?: string; cacheControl?: unknown; provenance?: unknown }>>;
export type WebReleaseArtifact = Readonly<{ path: string; url: string; bytes: number; digest: string; mediaType?: string; cacheControl?: unknown; provenance?: unknown }>;
export type WebReleaseManifest = Readonly<{
  kind: 'web-release-manifest'; version: 1; baseUrl: string; profile: string;
  exclusions: readonly string[]; artifactCount: number; byteCount: number;
  metadata: Readonly<Record<string, unknown>>; artifacts: readonly WebReleaseArtifact[]; digest: string;
}>;
export type ManifestOptions = Readonly<{ artifacts: ArtifactInventory; baseUrl: string; profile?: string; excludePaths?: readonly string[]; metadata?: Readonly<Record<string, unknown>> }>;
export type ReleaseDiagnostic = Readonly<{ severity: 'error'; code: string; message: string; subject: string }>;
export function canonicalJson(value: unknown): string | undefined;
export function createWebReleaseManifest(options: ManifestOptions): WebReleaseManifest;
export function serializeWebReleaseManifest(manifest: WebReleaseManifest): string;
export function validateWebReleaseManifest(manifest: unknown): Readonly<{ valid: boolean; diagnostics: readonly ReleaseDiagnostic[] }>;
export function projectWebReleaseManifestArtifact(options: Readonly<{ artifacts: ArtifactInventory; config?: Omit<ManifestOptions, 'artifacts'> & Readonly<{ path?: string }> }>): Readonly<{ manifest: WebReleaseManifest | null; artifacts: readonly Readonly<{ path: string; body: string; mediaType: string; cacheControl: string; source: string }>[]; diagnostics: readonly ReleaseDiagnostic[] }>;
export function verifyWebReleaseManifest(options: Readonly<{ manifest: WebReleaseManifest; artifacts: ArtifactInventory }>): Readonly<{ valid: boolean; diagnostics: readonly ReleaseDiagnostic[] }>;
export type ReleaseDelta = Readonly<{ path: string; change: 'added' | 'removed' | 'changed'; baseline?: WebReleaseArtifact; candidate?: WebReleaseArtifact }>;
export function compareWebReleaseCandidates(options: Readonly<{ baseline: WebReleaseManifest; candidate: WebReleaseManifest; classifyDelta?: (delta: ReleaseDelta) => string | undefined }>): Readonly<{
  kind: 'web-release-parity'; version: 1; baselineDigest: string; candidateDigest: string;
  routeSetsEqual: boolean; exactArtifactCount: number; intentionalDeltaCount: number;
  unexpectedDeltaCount: number; unexpectedPaths: readonly string[];
  deltas: readonly Readonly<{ path: string; change: string; disposition: string; intentional: boolean }>[];
  candidateReady: boolean;
}>;
export type PublicReleaseProbe = Readonly<{ id: string; method: 'GET' | 'HEAD' | 'POST'; path: string; expectedStatus: number; artifactPath?: string; contentType?: string }>;
export type PublicRelease = Readonly<{
  kind: 'public-release'; version: 1;
  source: Readonly<{ repository: string; revision: string; build: Readonly<{ command: readonly string[]; outputRoot: string }> }>;
  artifact: Readonly<{ manifest: WebReleaseManifest; manifestDigest: string }>;
  channel: Readonly<{ canonicalOrigin: string; stateClass: 'static' | 'edge-static' | 'durable'; probes: readonly PublicReleaseProbe[] }>;
  target: Readonly<{ provider: string; receiver: string; configDigest: string; bindingDigest: string }>;
  snapshot: Readonly<{ providerVersion: string; routeDigest: string }>;
  digest: string;
}>;
export type PublicReleaseReceipt = Readonly<{
  kind: 'public-release-receipt'; version: 1; releaseDigest: string; provider: string; receiver: string;
  artifactManifestDigest: string; configDigest: string; bindingDigest: string; providerVersion: string;
  routeDigest: string; baselineProviderVersion: string; baselineRouteDigest: string;
  canonicalOrigin?: string; candidateOrigin?: string;
}>;
export type PublicReleaseObservation = Readonly<{
  kind: 'public-release-observation'; version: 1; releaseDigest: string; independent: true; observer: string;
  origin: string; observedAt: string; probes: readonly Readonly<{ id: string; status: number; contentType?: string; digest?: string }>[];
}>;
export function createPublicRelease(options: Readonly<{
  source: PublicRelease['source']; artifact: Readonly<{ manifest: WebReleaseManifest }>;
  channel: PublicRelease['channel']; target: PublicRelease['target']; snapshot: PublicRelease['snapshot'];
}>): PublicRelease;
export function validatePublicRelease(release: unknown): Readonly<{ valid: boolean; diagnostics: readonly ReleaseDiagnostic[] }>;
export function decidePublicRelease(options: Readonly<{
  release: PublicRelease; activeReceipt?: PublicReleaseReceipt; candidateReceipt?: PublicReleaseReceipt;
  candidateObservation?: PublicReleaseObservation; receiverObservation?: PublicReleaseObservation;
}>): Readonly<{
  kind: 'public-release-decision'; version: 1; disposition: 'refusal' | 'candidate' | 'cutover' | 'no-op';
  releaseDigest: string | null; requirements: readonly string[];
}>;
export type ReleaseDirectoryDiagnostic = Readonly<{ severity: 'error'; code: string; message: string; subject: string; details?: unknown }>;
export type ReleaseDirectoryVerification = Readonly<{
  kind: 'web-release-directory-verification'; version: 1; valid: boolean; root: string | null;
  manifestDigest: string | null; fileCount: number; byteCount: number; expectedFileCount: number;
  verifiedFileCount: number; excludedFileCount: number;
  limits: Readonly<{ maxFiles: number; maxBytes: number }>;
  diagnostics: readonly ReleaseDirectoryDiagnostic[];
}>;
export function verifyWebReleaseDirectory(options: Readonly<{
  manifest: WebReleaseManifest; root: string; allowExcluded?: boolean; maxFiles?: number; maxBytes?: number;
}>): Promise<ReleaseDirectoryVerification>;
export { observePublicRelease } from './observe-public-release.mjs';
export type { PublicReleaseFetch, PublicReleaseFetchResponse, PublicReleaseObservationRefusal, PublicReleaseProbeOutcome } from './observe-public-release.mjs';
