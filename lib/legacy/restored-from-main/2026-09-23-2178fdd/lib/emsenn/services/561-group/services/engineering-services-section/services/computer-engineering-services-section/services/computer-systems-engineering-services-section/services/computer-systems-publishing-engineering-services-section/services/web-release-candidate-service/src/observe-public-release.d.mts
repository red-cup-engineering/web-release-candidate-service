import type { PublicRelease, PublicReleaseObservation } from './web-release-candidate.mjs';

export type PublicReleaseFetchResponse = Readonly<{
  status: number;
  headers?: Readonly<{ get(name: string): string | null }>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;
export type PublicReleaseFetch = (url: string, init: Readonly<{ method: 'GET' | 'HEAD' | 'POST'; redirect: 'follow'; signal: AbortSignal }>) => Promise<PublicReleaseFetchResponse>;
export type PublicReleaseProbeOutcome = Readonly<{ id: string; url: string; status?: number; contentType?: string; digest?: string; error?: string }>;
export type PublicReleaseObservationRefusal = Readonly<{
  kind: 'public-release-observation-refusal'; version: 1; releaseDigest: string | null; origin: string | null;
  observer: string | null; observedAt: string | null; probes: readonly PublicReleaseProbeOutcome[]; reasons: readonly string[];
}>;
export function observePublicRelease(options: Readonly<{
  release: PublicRelease; origin?: string; observer: string; observedAt: string; timeoutMs?: number; fetch: PublicReleaseFetch;
}>): Promise<PublicReleaseObservation | PublicReleaseObservationRefusal>;
