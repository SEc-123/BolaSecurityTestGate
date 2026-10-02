/**
 * Browser-facing product frames are deliberately limited to observation feeds
 * designed for that surface. Persistent browser execution artifacts can carry a
 * full authenticated page snapshot, even when their metadata is redacted, and
 * must remain in private evidence storage.
 */
export const PUBLIC_PRODUCT_FRAME_ARTIFACT_TYPES = new Set([
  'assessment_live_frame',
  'mobile_device_state',
]);

export function isPublicProductFrameArtifactType(artifactType: unknown): boolean {
  return typeof artifactType === 'string' && PUBLIC_PRODUCT_FRAME_ARTIFACT_TYPES.has(artifactType);
}
