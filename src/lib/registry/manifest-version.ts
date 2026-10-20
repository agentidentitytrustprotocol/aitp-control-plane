/**
 * The one Manifest `version` this CP accepts and keeps active in the registry.
 *
 * aitp 0.17 is a strict `aitp/0.2` -> `aitp/0.3` cutover with no dual-accept:
 * `verifyManifestJson` rejects anything else as `version_unknown`. The SDK
 * exports no constant for it, so it lives here, shared by the register guard
 * (`POST /api/registry/agents`) and the expiry-job sweep that retires rows
 * enrolled under an older version. Change it together with the `aitp` range
 * in package.json.
 */
export const SUPPORTED_MANIFEST_VERSION = 'aitp/0.3';
