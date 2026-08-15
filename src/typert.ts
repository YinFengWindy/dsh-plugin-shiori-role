import remote from './remote.ts'

/** Host Typert descriptor mirrors the client Remote contribution. */
export const TYPERT = {
  package: remote.package,
  face: 'host' as const,
  schemas: [],
  invocations: remote.descriptors,
  model: { services: [], events: [], objects: [] },
}
