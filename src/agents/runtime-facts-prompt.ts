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

/** Heading of the retained-input snapshot section in the runtime-context message. */
export const INTERRUPTED_INPUTS_SECTION_HEADING = "## Interrupted inputs";
/** Explicit empty marker: the latest retained-input page holds no interrupted inputs. */
export const INTERRUPTED_INPUTS_NONE_LINE = "none in the latest retained-input page";
/** Deterministic rendering of the section when no interrupted inputs exist. */
export const INTERRUPTED_INPUTS_NONE_SECTION =
  `${INTERRUPTED_INPUTS_SECTION_HEADING}\n${INTERRUPTED_INPUTS_NONE_LINE}`;

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
        text: [INTERRUPTED_INPUTS_SECTION_HEADING, ...(lines.length ? lines : [INTERRUPTED_INPUTS_NONE_LINE])].join("\n"),
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
