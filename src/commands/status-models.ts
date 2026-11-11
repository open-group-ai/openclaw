// Resolves the Models block for `openclaw status` from the existing config snapshot.

/** Alias entry surfaced in status output: alias name plus its provider/model ref. */
export type StatusModelAlias = {
  alias: string;
  model: string;
};

/** Resolved Models block: the default model plus configured aliases. */
export type StatusModelsBlock = {
  /** Default model from agents.defaults.model.primary; null when unset. */
  defaultModel: string | null;
  /** Configured aliases sorted by alias; empty when none configured. */
  aliases: StatusModelAlias[];
};

/**
 * Config input for the Models block. Typed as `unknown` so every existing
 * status surface stays assignable without casts or a second parser; the
 * resolver narrows to `agents.defaults.model`/`agents.defaults.models`.
 */
export type StatusModelsConfigLike = unknown;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Reads the Models block from the resolved config. Only alias names and
 * provider/model refs are surfaced, never alias entry values such as params.
 */
export function resolveStatusModelsBlock(cfg: StatusModelsConfigLike): StatusModelsBlock {
  const defaults = asRecord(asRecord(asRecord(cfg)?.agents)?.defaults) ?? {};
  const modelValue = defaults.model;
  const defaultModel =
    typeof modelValue === "string"
      ? asNonEmptyString(modelValue)
      : asNonEmptyString(asRecord(modelValue)?.primary);

  const models = asRecord(defaults.models) ?? {};
  const aliases: StatusModelAlias[] = [];
  for (const [ref, entry] of Object.entries(models)) {
    const alias = asNonEmptyString(asRecord(entry)?.alias);
    if (alias) {
      aliases.push({ alias, model: ref });
    }
  }
  aliases.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  return { defaultModel, aliases };
}

/** Human-readable Models lines for the text report. */
export function formatStatusModelsLines(block: StatusModelsBlock): string[] {
  const lines = [`Default: ${block.defaultModel ?? "none configured"}`];
  if (block.aliases.length === 0) {
    lines.push("Aliases: none configured");
  } else {
    for (const entry of block.aliases) {
      lines.push(`${entry.alias} -> ${entry.model}`);
    }
  }
  return lines;
}
