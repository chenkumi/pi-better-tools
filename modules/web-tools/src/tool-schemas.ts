import { Type, type TSchema } from 'typebox';

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

export const searchOutputSchema = outputSchema(Type.Object({
  provider: Type.Union([Type.Literal('brave'), Type.Literal('exa')]),
  query: Type.String(),
  results: Type.Array(Type.Object({
    title: Type.String(), url: Type.String(), snippet: Type.Optional(Type.String()),
    publishedAt: Type.Optional(Type.String()),
  }), { maxItems: 10 }),
  warnings: Type.Array(Type.String()),
}));

// Hints are deliberately conservative: web JavaScript, remote calls and temporary
// output can have effects. Permission extensions must not assume a sandbox.
export const webToolMetadata = {
  namespace: { name: 'web', description: 'Public web fetching and explicit-provider search' },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
