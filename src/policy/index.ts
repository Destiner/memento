// The derived instruction surfaces (policy §12). `blocks.ts` holds the rules from
// `docs/memory-policy.md` as data; everything exported here is assembled from it, so
// the fragment, the server instructions, and the tool descriptions share one
// vocabulary by construction rather than by review.

export { POLICY_VERSION } from './blocks.js';
export { AGENT_FRAGMENT, SERVER_INSTRUCTIONS } from './instructions.js';
export {
  plainDescriptions,
  triggerListDescriptions,
  type DescriptionSet,
  type ToolName,
} from './descriptions.js';
