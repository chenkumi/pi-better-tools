/**
 * Compaction projection — builds projection slices for compaction events.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/projection.ts)
 * Modified: nested snapshots, bounded output, and compact-all coverage.
 */
import { selectPriorObservations, selectPriorReflections } from "./render-summary.js";
import { nativeEligibleEdits } from "../../core/native-compaction-input.js";
import { ownedSummaryProof, generatedSummaryProof } from "../../core/generated-summary-spans.js";
export const OM_INVALIDATION_MARKER = "blackhole-om-source-invalidation";
import {
  OM_FOLDED,
  isMemoryDetails,
  isObservationsDroppedEntry,
  isObservationsRecordedEntry,
  isReflectionsRecordedEntry,
  type Entry,
  type MemoryDetails,
  type Observation,
  type Reflection,
} from "./types.js";

export type Projection = {
  observations: Observation[];
  reflections: Reflection[];
};

export type ProjectionDiff = {
  observationsOnlyInFull: Observation[];
  reflectionsOnlyInFull: Reflection[];
  droppedOnlyInFull: Observation[];
};

export type CompactionProjectionConfig = {
  observationsPoolMaxTokens: number;
  reflectionsPoolMaxTokens?: number;
  fullFoldAlways?: boolean;
};

export type CompactionProjection = Projection & {
  fullFold: boolean;
  details: MemoryDetails;
};

type ProjectionBoundary = { kind: "entry"; entryId: string } | { kind: "tip" } | { kind: "none" };

type ProjectionFoldOptions = {
  observationsBoundary: ProjectionBoundary;
  reflectionsBoundary: ProjectionBoundary;
  dropsBoundary: ProjectionBoundary;
};

function entryIndexById(entries: Entry[]): Map<string, number> {
  const indexes = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);
  return indexes;
}

function entryBoundary(entryId: string): ProjectionBoundary {
  return { kind: "entry", entryId };
}

function tipBoundary(): ProjectionBoundary {
  return { kind: "tip" };
}

function noneBoundary(): ProjectionBoundary {
  return { kind: "none" };
}

function boundaryIndex(
  entries: Entry[],
  indexes: Map<string, number>,
  boundary: ProjectionBoundary,
): number {
  if (boundary.kind === "tip") return entries.length - 1;
  if (boundary.kind === "none") return -1;
  return indexes.get(boundary.entryId) ?? -1;
}

function coverageIndex(
  entry: Entry & { data: { coversUpToId: string } },
  indexes: Map<string, number>,
): number {
  return indexes.get(entry.data.coversUpToId) ?? -1;
}

function isAtOrBefore(index: number, boundaryIndex: number): boolean {
  return index >= 0 && boundaryIndex >= 0 && index <= boundaryIndex;
}

function isCoveredAtOrBefore(
  entry: Entry & { data: { coversUpToId: string } },
  indexes: Map<string, number>,
  boundaryIndex: number,
): boolean {
  return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex);
}

/** Only explicit, currently eligible source edits invalidate derived memory.
 * Historical sources outside this native window are NOT redactions. Replacement
 * content does not recompute an observation, so its old derived body is stale too.
 */
export function memoryInvalidatedSources(entries: Entry[]): Set<string> {
  const sources = new Set(nativeEligibleEdits(entries).keys());
  const latest = [...entries].reverse().find(e => e.type === "compaction");
  // Inactive raw edits do not create invalidation. Explicit prior invalidation
  // survives only through the current canonical, proven Blackhole generation.
  if (latest && typeof latest.summary === "string") {
    if (ownedSummaryProof(latest.summary, entries)) for (const id of unwrapMemoryDetails(latest)?.invalidatedSourceEntryIds ?? []) sources.add(id);
    // Native fallback cannot carry Blackhole summary details. A post-persistence,
    // state-only marker binds observed invalidation to that exact checkpoint.
    const generation = generatedSummaryProof(latest.summary, []).sourceGeneration;
    for (const entry of entries) {
      const data = entry.data as any;
      if (entry.type === "custom" && entry.customType === OM_INVALIDATION_MARKER && data?.version === 1 && data.compactionEntryId === latest.id && data.sourceGeneration === generation && Array.isArray(data.sourceEntryIds) && data.sourceEntryIds.every((id: unknown) => typeof id === "string" && id.length > 0)) for (const id of data.sourceEntryIds) sources.add(id);
    }
  }
  return sources;
}
function invalidObservationIds(entries: Entry[]): Set<string> {
  const edits = memoryInvalidatedSources(entries);
  const invalid = new Set<string>();
  for (const entry of entries) {
    const observations = isObservationsRecordedEntry(entry) ? entry.data.observations : unwrapMemoryDetails(entry)?.observations ?? [];
    for (const observation of observations) if (observation.sourceEntryIds.some(id => edits.has(id))) invalid.add(observation.id);
  }
  return invalid;
}
function foldProjection(entries: Entry[], options: ProjectionFoldOptions): Projection {
  const invalid = invalidObservationIds(entries);
  const indexes = entryIndexById(entries);
  const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
  const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
  const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
  const observations: Observation[] = [];
  const reflections: Reflection[] = [];
  const observationsById = new Set<string>();
  const reflectionsById = new Set<string>();
  const droppedObservationIds = new Set<string>();

  for (const entry of entries) {
    if (
      isObservationsRecordedEntry(entry) &&
      isCoveredAtOrBefore(entry, indexes, observationsBoundary)
    ) {
      for (const observation of entry.data.observations) {
        if (invalid.has(observation.id) || observationsById.has(observation.id)) continue;
        observationsById.add(observation.id);
        observations.push(observation);
      }
      continue;
    }

    if (
      isReflectionsRecordedEntry(entry) &&
      isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)
    ) {
      for (const reflection of entry.data.reflections) {
        if (reflection.supportingObservationIds.some(id => invalid.has(id)) || reflectionsById.has(reflection.id)) continue;
        reflectionsById.add(reflection.id);
        reflections.push(reflection);
      }
      continue;
    }

    if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
      for (const observationId of entry.data.observationIds)
        droppedObservationIds.add(observationId);
    }
  }

  return {
    observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
    reflections,
  };
}

function projectionFromMemoryDetails(details: MemoryDetails, invalid = new Set<string>()): Projection {
  return {
    observations: details.observations.filter(o => !invalid.has(o.id)),
    reflections: details.reflections.filter(r => !r.supportingObservationIds.some(id => invalid.has(id))),
  };
}

function latestV3CompactionDetails(entries: Entry[]): MemoryDetails | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "compaction") continue;
    const details = unwrapMemoryDetails(entry);
    if (details) return details;
  }
  return undefined;
}

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
  const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
  return foldProjection(entries, {
    observationsBoundary: boundary,
    reflectionsBoundary: boundary,
    dropsBoundary: boundary,
  });
}

export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
  if (!upToEntryId) {
    const details = latestV3CompactionDetails(entries);
    if (details) return projectionFromMemoryDetails(details, invalidObservationIds(entries));
    // No compaction has run yet — show everything so the user sees
    // recorded data until first /blackhole creates a proper snapshot.
    return fullProjection(entries);
  }

  return buildCompactionProjection(entries, upToEntryId, {
    observationsPoolMaxTokens: Number.POSITIVE_INFINITY,
  });
}

function unwrapMemoryDetails(entry: Entry): MemoryDetails | undefined {
  if (isMemoryDetails(entry.details)) return entry.details;
  if (entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)) {
    const nested = (entry.details as Record<string, unknown>)["om.folded"];
    if (isMemoryDetails(nested)) return nested;
  }
  return undefined;
}

export function latestFullFoldBoundaryId(entries: Entry[]): string | undefined {
  const indexes = entryIndexById(entries);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "compaction") continue;
    const details = unwrapMemoryDetails(entry);
    if (!details) continue;
    if (!details.fullFold) continue;
    // Compact-all covered the branch at this checkpoint, not today's tip.
    if (entry.firstKeptEntryId === "") return entry.id;
    if (!entry.firstKeptEntryId || !indexes.has(entry.firstKeptEntryId)) continue;
    return entry.firstKeptEntryId;
  }
  return undefined;
}

export function buildCompactionProjection(
  entries: Entry[],
  firstKeptEntryId: string,
  config: CompactionProjectionConfig,
): CompactionProjection {
  const compactAll = firstKeptEntryId === "";
  const outputBoundary = compactAll ? tipBoundary() : entryBoundary(firstKeptEntryId);
  const fullFoldBoundaryId = latestFullFoldBoundaryId(entries);
  const maintenanceBoundary = compactAll
    ? tipBoundary()
    : fullFoldBoundaryId
      ? entryBoundary(fullFoldBoundaryId)
      : config.fullFoldAlways
        ? outputBoundary
        : noneBoundary();
  const normalProjection = foldProjection(entries, {
    observationsBoundary: outputBoundary,
    reflectionsBoundary: maintenanceBoundary,
    dropsBoundary: maintenanceBoundary,
  });
  // Boundary-scoped, not the live pool: this sum answers "what would survive
  // this compaction" (observations inside the output boundary). It deliberately
  // differs from observationPoolTokens(), which measures the live active pool.
  const observationTokens = normalProjection.observations.reduce(
    (total, observation) => total + observation.tokenCount,
    0,
  );
  const fullFold = observationTokens >= config.observationsPoolMaxTokens;
  let projection = fullFold ? fullProjection(entries, firstKeptEntryId) : normalProjection;

  // Output limits are independent of stored-token full-fold maintenance.
  // Source records stay in the branch; raw/view callers can omit finite caps.
  if (config.observationsPoolMaxTokens > 0 && Number.isFinite(config.observationsPoolMaxTokens)) {
    projection = {
      observations: selectPriorObservations(
        projection.observations,
        config.observationsPoolMaxTokens,
      ),
      reflections: projection.reflections,
    };
  }

  if (
    config.reflectionsPoolMaxTokens !== undefined &&
    config.reflectionsPoolMaxTokens > 0 &&
    Number.isFinite(config.reflectionsPoolMaxTokens)
  ) {
    projection = {
      ...projection,
      reflections: selectPriorReflections(projection.reflections, config.reflectionsPoolMaxTokens),
    };
  }

  const invalidatedSources = [...memoryInvalidatedSources(entries)];
  const details: MemoryDetails = {
    ...(invalidatedSources.length ? { invalidatedSourceEntryIds: invalidatedSources } : {}),
    type: OM_FOLDED,
    version: 1,
    fullFold,
    observations: projection.observations,
    reflections: projection.reflections,
  };

  return {
    fullFold,
    observations: projection.observations,
    reflections: projection.reflections,
    details,
  };
}

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
  const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
  const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
  const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));

  return {
    observationsOnlyInFull: full.observations.filter(
      (observation) => !visibleObservationIds.has(observation.id),
    ),
    reflectionsOnlyInFull: full.reflections.filter(
      (reflection) => !visibleReflectionIds.has(reflection.id),
    ),
    droppedOnlyInFull: visible.observations.filter(
      (observation) => !fullObservationIds.has(observation.id),
    ),
  };
}
