/** Compact current-turn snapshots; instructions belong in the stable system prompt. */
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTemporalContextText } from "./date-time.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";
import { buildMediaTaskRuntimeContext } from "./media-generation-task-status.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";
import {
  buildExecutionHostRuntimeFacts,
  type ExecutionHostRuntimeFactsParams,
} from "./runtime-execution-facts.js";
import { buildActiveSubagentRuntimeContext } from "./subagents/registry/subagent-active-context.js";

/** Canonical empty state for the Interrupted inputs section.
 * Deterministic with no timestamps or ordering variance. This section travels
 * in the transient per-turn runtime context, never in the stable system prompt
 * prefix, so an empty state never invalidates prompt caching. The newest
 * snapshot per family wins; an explicit "none" means no active work. */
export const INTERRUPTED_INPUTS_EMPTY_SECTION_TEXT = "## Interrupted inputs\nnone";

/** Return the canonical empty Interrupted inputs section text. */
export function buildInterruptedInputsEmptySection(): string {
  return INTERRUPTED_INPUTS_EMPTY_SECTION_TEXT;
}

export async function buildRuntimeFactsContext(
  params: ExecutionHostRuntimeFactsParams & {
    cfg: OpenClawConfig;
    executionHost?: boolean;
    sessionTarget?: AgentRunSessionTarget;
    runId?: string;
  },
): Promise<RuntimeContextFragment[]> {
  const includeEmptySnapshots = params.includeEmptySnapshots === true;
  const facts = params.executionHost === false ? [] : await buildExecutionHostRuntimeFacts(params);
  const canSpawn = params.capabilityToolNames.has("sessions_spawn");
  const subagentContext = await buildActiveSubagentRuntimeContext({
    cfg: params.cfg,
    controllerSessionKey: params.sessionKey,
    controllerAgentId: params.agentId,
    runId: params.runId,
    includeSpawnContext: canSpawn,
  });
  if (subagentContext || (canSpawn && includeEmptySnapshots)) {
    facts.push({ kind: "conversation-data", text: subagentContext ?? "## Active Subagents\nnone" });
  }
  const media = await buildMediaTaskRuntimeContext({ ...params, includeEmptySnapshots });
  if (media) {
    facts.push({ kind: "conversation-data", text: media });
  }
  const target = params.sessionTarget;
  if (target?.sessionId && target.sessionKey) {
    try {
      const page = await listSessionPendingInputs({
        ...target,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        agentId: target.agentId ?? params.agentId,
      }, { limit: 10 });
      const lines = page.items
        .toSorted((a, b) => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((item) => {
          const content = typeof item.message.content === "string"
            ? item.message.content
            : item.message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
          return `- ${item.state}: ${JSON.stringify(sanitizeForPromptLiteral(content).slice(0, 200))}`;
        });
      facts.push({
        kind: "conversation-data",
        text: lines.length
          ? ["## Interrupted inputs", ...lines].join("\n")
          : buildInterruptedInputsEmptySection(),
      });
    } catch {
      // A failed history read is not evidence that the retained-input page is empty.
    }
  }
  facts.push({
    kind: "conversation-data",
    text: buildTemporalContextText({
      configuredTimezone: params.cfg.agents?.defaults?.userTimezone,
      sessionStatusAvailable: params.capabilityToolNames.has("session_status"),
    }),
  });
  return facts;
}
