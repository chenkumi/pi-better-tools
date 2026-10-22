import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
import { formatIssues, toZodSchema } from './validation-schema.mjs';
// Pure computation: no output or providers. Cache only the last schema to bound retained state.
let schemaText;
let validator;
parentPort.on('message', ({ schema, data }) => {
  try {
    const text = JSON.stringify(schema);
    if (text !== schemaText) {
      validator = z.fromJSONSchema(toZodSchema(schema));
      schemaText = text;
    }
    const result = validator.safeParse(data);
    parentPort.postMessage({ reason: result.success ? undefined : formatIssues(result.error.issues) });
  } catch (error) {
    parentPort.postMessage({ reason: `Validation failed: ${error instanceof Error ? error.message : String(error)}` });
  }
});
parentPort.postMessage({ ready: true });
