import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { bottomConfirm } from '../../../shared/src/bottom-panel/index.ts';
import { ToolError } from '../../../shared/src/tool-error/index.ts';
import { resolveApiKey, type KeyResolver } from './auth.ts';
import { generateCodex, codexPreflight, type CodexEnv } from './backends/codex.ts';
import { generateGemini, type GeminiEnv } from './backends/gemini.ts';
import { generateOpenAI, type OpenAIEnv } from './backends/openai.ts';
import { parseRatio, type BackendEnv, type GenerateRequest, type GenerateResult } from './backends/types.ts';
import { BACKENDS, BACKEND_LABELS, OPENAI_QUALITIES, RESOLUTIONS, type Backend, type Config } from './config.ts';
import { prepareOutputDir, saveImages, type SavedFile } from './output.ts';
import { clean } from './text.ts';

export const imageNamespace = {
  name: 'image',
  description: 'To generate images from a text description (OpenAI, Gemini or the local Codex CLI), use tool_search to find and load the image tool.',
};

const strict = { additionalProperties: false };
/** Plain `{ type: 'string', enum }` schema typed as the union of its values (the same JSON as pi-ai's StringEnum). */
const literals = <const T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: 'string', enum: [...values] });
export const imageParameters = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 32000, description: 'Full description of the image: subject, style, composition, colors, any text to render. Be self-contained.' }),
  backend: Type.Optional(literals(BACKENDS)),
  aspectRatio: Type.Optional(Type.String({ pattern: '^[0-9]{1,2}:[0-9]{1,2}$', description: 'For example "1:1", "16:9", "9:16". OpenAI accepts 1:3 to 3:1; Gemini a fixed list per model; Codex only as a hint in the prompt.' })),
  resolution: Type.Optional(literals(RESOLUTIONS)),
  quality: Type.Optional(literals(OPENAI_QUALITIES)),
  format: Type.Optional(literals(['png', 'jpeg', 'webp'] as const)),
  transparentBackground: Type.Optional(Type.Boolean({ description: 'OpenAI (with png or webp) and Codex (as a hint); Gemini cannot.' })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Number of images, default 1 (the configured maximum applies).' })),
}, strict);
export type ImageParameters = Static<typeof imageParameters>;

const fileSchema = Type.Object({ path: Type.String(), bytes: Type.Integer(), sha256: Type.String(), mime: Type.String(), width: Type.Optional(Type.Integer()), height: Type.Optional(Type.Integer()) }, strict);
export const imageOutputSchema = Type.Object({
  backend: Type.String(), model: Type.String(), controls: Type.Union([Type.Literal('api'), Type.Literal('prompt-hint')]),
  files: Type.Array(fileSchema), ignored: Type.Array(Type.String()), notes: Type.Array(Type.String()),
  usage: Type.Optional(Type.Record(Type.String(), Type.Number())), requestId: Type.Optional(Type.String()), elapsedMs: Type.Integer(),
}, strict);

export interface ImageToolDeps {
  readConfig(): Config;
  key?: KeyResolver;
  now?: () => Date;
  confirm?: typeof bottomConfirm;
  /** Test seams: fixed endpoints and fake processes are injected here, never read from the configuration. */
  openai?: Pick<OpenAIEnv, 'endpoint' | 'fetchImpl'>;
  gemini?: Pick<GeminiEnv, 'endpoint' | 'fetchImpl'>;
  codex?: Pick<CodexEnv, 'spawnImpl' | 'argsPrefix' | 'codexHome' | 'tmpRoot' | 'baseEnv'>;
}

const DESTINATION: Record<Backend, string> = {
  openai: 'api.openai.com, billed to your OpenAI API account',
  gemini: 'generativelanguage.googleapis.com, billed to your Google AI account',
  codex: 'the local Codex CLI, which sends it to OpenAI and counts against your ChatGPT/Codex usage',
};
const MODEL_OF = (config: Config, backend: Backend) => backend === 'codex' ? config.codex.model ?? 'codex default' : config[backend].model;

function validate(params: ImageParameters, config: Config): { backend: Backend; request: GenerateRequest } {
  const backend = (params.backend ?? config.backend) as Backend;
  if (!config[backend].enabled) throw new ToolError('IMAGE_BACKEND_DISABLED', `The ${BACKEND_LABELS[backend]} backend is disabled in the image-generation settings.`);
  const prompt = params.prompt.trim();
  if (!prompt) throw new ToolError('IMAGE_INVALID_ARGUMENT', 'prompt must not be empty.');
  const count = params.count ?? 1;
  if (count > config.maxImages) throw new ToolError('IMAGE_INVALID_ARGUMENT', `count ${count} is above the configured maximum of ${config.maxImages}.`);
  if (params.aspectRatio && !parseRatio(params.aspectRatio)) throw new ToolError('IMAGE_INVALID_ARGUMENT', 'aspectRatio must look like 16:9.');
  return { backend, request: {
    prompt, count,
    ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}), ...(params.resolution ? { resolution: params.resolution } : {}),
    ...(params.quality ? { quality: params.quality } : {}), ...(params.format ? { format: params.format } : {}),
    ...(params.transparentBackground ? { transparentBackground: true } : {}),
  } };
}

export function describeFiles(files: readonly SavedFile[]): string[] {
  return files.map(file => `${file.path} · ${file.bytes} bytes${file.width ? ` · ${file.width}x${file.height}` : ''} · sha256 ${file.sha256.slice(0, 12)}`);
}

/** The deferred `image_generate` tool. `confirmed` remembers (per session and backend) the first-use approvals of this process. */
export function createImageTool(deps: ImageToolDeps): ToolDefinition {
  const confirmed = new Set<string>();
  const key = deps.key ?? resolveApiKey;
  return {
    exposure: 'deferred', namespace: imageNamespace, name: 'image_generate', label: 'Image Generate',
    description: 'Generate one or more new images from a text description with the configured backend (OpenAI Images API, Gemini API or the local Codex CLI) and save them as new files in the project (default .pi/generated-images/). Returns the saved paths; it never edits or replaces existing files and does not take reference images. The prompt is sent to an external service and the call may cost money.',
    promptSnippet: 'Generate images from a text description and save them in the project',
    promptGuidelines: [
      'Use image_generate only when the user asked for a generated image. Each call is a paid external request: do not call it in a loop or to "try" variations unasked.',
      'Put everything the image needs in prompt (subject, style, composition, colors, text to render). The result lists the saved file paths; use read to view an image. Options a backend cannot apply are listed under "ignored" and are not applied.',
    ],
    parameters: imageParameters, outputSchema: imageOutputSchema,
    renderCall(args, theme) {
      const input = (args ?? {}) as Record<string, unknown>;
      return new Text(`${theme.fg('toolTitle', theme.bold('image_generate'))} ${theme.fg('accent', clean(input.backend ?? '', 20))} ${theme.fg('muted', clean(input.prompt ?? '…', 80))}`.replace(/ +/g, ' '), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (context.isError) return new Text(theme.fg('error', clean(text, expanded ? 2000 : 400)), 0, 0);
      if (isPartial) return new Text(theme.fg('muted', clean(text, 200) || 'image_generate…'), 0, 0);
      return new Text(theme.fg('muted', expanded ? text : text.split('\n').slice(0, 2).join('\n')), 0, 0);
    },
    async execute(_id, params: ImageParameters, signal, onUpdate, ctx: ExtensionContext) {
      let config: Config;
      try { config = deps.readConfig(); } catch (error) { throw new ToolError('IMAGE_CONFIG_INVALID', `${(error as Error).message.replace(/^CONFIG_INVALID: /, '')} Fix the file or run /settings:image-generation.`); }
      if (!config.enabled) throw new ToolError('IMAGE_BACKEND_DISABLED', 'Image generation is turned off ("enabled": false). Turn it on in /settings:image-generation.');
      const { backend, request } = validate(params, config);
      const progress = (text: string) => { try { onUpdate?.({ content: [{ type: 'text', text }], details: {} }); } catch { /* progress is display only */ } };
      // Everything that can fail without cost comes before the confirmation and the request.
      await prepareOutputDir(ctx.cwd, config.outputDir, false); // validation only: nothing is created before the user has approved
      const base: BackendEnv = { timeoutMs: backend === 'codex' ? config.codex.timeoutMs : config.timeoutMs, onProgress: progress, ...(signal ? { signal } : {}) };
      const codexEnv: CodexEnv = { ...base, ...deps.codex };
      const apiKey = backend === 'codex' ? '' : await key(ctx, backend);
      if (backend === 'codex') await codexPreflight(config.codex, codexEnv);

      const sessionKey = `${ctx.sessionManager.getSessionId()}:${backend}`;
      if (config.confirm === 'always' || (config.confirm === 'first' && !confirmed.has(sessionKey))) {
        if (!ctx.hasUI) throw new ToolError('IMAGE_CONFIRM_UNAVAILABLE', 'This paid request needs the user\'s approval, and there is no interactive UI here (for example in a Fork). Ask the user to run it in the main session, or to set "confirm": "never" in the image-generation settings.');
        const ok = await (deps.confirm ?? bottomConfirm)(ctx, 'Generate image', [
          `Generate ${request.count} image${request.count === 1 ? '' : 's'} with ${BACKEND_LABELS[backend]} (${MODEL_OF(config, backend)})?`,
          `Prompt (${request.prompt.length} characters): ${clean(request.prompt, 200)}`,
          `The prompt is sent to ${DESTINATION[backend]}. Files are saved under ${config.outputDir}/.`,
        ].join('\n'), signal ? { signal } : {});
        if (!ok) throw new ToolError('IMAGE_DECLINED', 'The user declined the image request. Nothing was sent.');
        confirmed.add(sessionKey);
      }

      const started = Date.now();
      let result: GenerateResult;
      if (backend === 'openai') result = await generateOpenAI(request, config.openai, apiKey, { ...base, ...deps.openai });
      else if (backend === 'gemini') result = await generateGemini(request, config.gemini, apiKey, { ...base, ...deps.gemini });
      else result = await generateCodex(request, config.codex, codexEnv);

      const target = await prepareOutputDir(ctx.cwd, config.outputDir);
      const files = await saveImages(target, result.images, (deps.now ?? (() => new Date()))());
      const details = {
        backend, model: result.model, controls: result.controls, files, ignored: result.ignored, notes: result.notes,
        ...(result.usage ? { usage: result.usage } : {}), ...(result.requestId ? { requestId: result.requestId } : {}), elapsedMs: Date.now() - started,
      };
      const text = [
        `Generated ${files.length} image${files.length === 1 ? '' : 's'} with ${BACKEND_LABELS[backend]} (${result.model})${result.controls === 'prompt-hint' ? '; size and style options were only hints in the prompt' : ''}.`,
        ...describeFiles(files),
        ...(result.ignored.length ? [`Ignored options: ${result.ignored.join('; ')}`] : []),
        ...result.notes.map(note => `Note: ${note}`),
      ].join('\n');
      const first = result.images[0];
      const preview = config.inlinePreview && first && first.bytes.length <= 4 * 1024 * 1024
        ? [{ type: 'image' as const, data: first.bytes.toString('base64'), mimeType: first.info.mime }] : [];
      const data = JSON.parse(JSON.stringify(details));
      return { content: [{ type: 'text' as const, text }, ...preview], details: data, structuredContent: data };
    },
  };
}

export function registerImageTool(pi: ExtensionAPI, deps: ImageToolDeps): void { pi.registerTool(createImageTool(deps)); }
