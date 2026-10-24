import { Type, type TSchema } from 'typebox';
import { MAX_SEARCH_RESULTS, REST_PROVIDERS } from './search.ts';

/** web_fetch waitForSelector bound: the schema and the runtime check in fetch/service.ts must agree. */
export const MAX_SELECTOR_CHARS = 500;

export function outputSchema(data: TSchema) {
  return Type.Object({
    text: Type.String(),
    data: Type.Optional(data),
    dataOmitted: Type.Boolean(),
    truncated: Type.Boolean(),
    fullOutputPath: Type.Optional(Type.String()),
  });
}

export const fetchOutputSchema = outputSchema(Type.Object({
  url: Type.String(), finalUrl: Type.String(), title: Type.String(),
  status: Type.Integer(), fetchedAt: Type.String(), extraction: Type.String(),
  warnings: Type.Array(Type.String()), content: Type.String(), contentTruncated: Type.Boolean(),
}));

// Derived from the REST provider list so a newly supported provider cannot fall outside the declared contract.
export const searchOutputSchema = outputSchema(Type.Object({
  provider: Type.Union(REST_PROVIDERS.map(provider => Type.Literal(provider))),
  query: Type.String(),
  results: Type.Array(Type.Object({
    title: Type.String(), url: Type.String(), snippet: Type.Optional(Type.String()),
    publishedAt: Type.Optional(Type.String()),
  }), { maxItems: MAX_SEARCH_RESULTS }),
  warnings: Type.Array(Type.String()),
}));

// Hints are deliberately conservative: web JavaScript, remote calls and temporary
// output can have effects. Permission extensions must not assume a sandbox.
export const webToolMetadata = {
  namespace: { name: 'web', description: 'Public web fetching and explicit-provider search' },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
