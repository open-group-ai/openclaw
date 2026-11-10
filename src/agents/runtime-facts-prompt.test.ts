import { afterEach, describe, expect, it, vi } from "vitest";
import * as pendingInputs from "../config/sessions/session-pending-input-history.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { MediaGenerationOperation } from "./media-generation-activity.js";
import * as mediaActivity from "./media-generation-activity.js";
import {
  buildRuntimeFactsContext,
  INTERRUPTED_INPUTS_NONE_LINE,
  INTERRUPTED_INPUTS_NONE_SECTION,
  INTERRUPTED_INPUTS_SECTION_HEADING,
} from "./runtime-facts-prompt.js";
import { supersedeRuntimeContextSnapshots } from "./internal-runtime-context.js";

const params = { capabilityToolNames: new Set(["exec"]), agentId: "main", cfg: {} };
const fact = (text: string) => ({ kind: "conversation-data", text });
const temporal = fact(expect.stringContaining("## Temporal Context\n"));
const context = (text: string) => [fact(text), temporal];
const media = (...lines: string[]) => context(["## Media Generation Tasks", ...lines].join("\n"));
const mediaParams = {
  ...params,
  sessionKey: "agent:main:media",
  executionHost: false,
  capabilityToolNames: new Set(["image_generate", "music_generate", "video_generate"]),
};
const approvals = (agents: execApprovals.ExecApprovalsFile["agents"]) => {
  const file = { version: 1, agents } satisfies execApprovals.ExecApprovalsFile;
  vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockImplementation(async () => file);
  return file;
};
const build = async (input: Parameters<typeof buildRuntimeFactsContext>[0] = params) =>
  (await buildRuntimeFactsContext(input)).at(0)?.text;
async function expectContext(
  input: Parameters<typeof buildRuntimeFactsContext>[0],
  expected: unknown = [temporal],
) {
  expect(await buildRuntimeFactsContext(input)).toEqual(expected);
}
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("refreshes date and timezone; session_status=%s", async (status) => {
  const clock = vi.spyOn(Date, "now");
  const cfg = { agents: { defaults: { userTimezone: "America/Los_Angeles" } } };
  const input = {
    ...params,
    cfg,
    executionHost: false,
    capabilityToolNames: new Set(status ? ["session_status"] : []),
  };
  const hint = status ? "\nFor the exact current time, use `session_status`." : "";
  for (const [time, zone, date] of [
    ["2026-09-01T06:59:59Z", "America/Los_Angeles", "2026-08-31"],
    ["2026-09-01T07:00:00Z", "America/Los_Angeles", "2026-09-01"],
    ["2026-09-01T07:00:00Z", "Pacific/Honolulu", "2026-08-31"],
  ] as const) {
    clock.mockReturnValue(Date.parse(time));
    cfg.agents.defaults.userTimezone = zone;
    await expectContext(input, [
      fact("## Temporal Context\nCurrent date: " + date + "\nTime zone: " + zone + hint),
    ]);
  }
});
it("scopes, sorts and refreshes executable hints", () =>
  withMockedPlatform("win32", async () => {
    const main = { allowlist: [{ pattern: "C:\\Tools\\z.exe", argPattern: "--version" }] };
    const file = approvals({
      main,
      "*": { allowlist: [{ pattern: "C:\\Tools\\a.exe" }] },
      other: { allowlist: [{ pattern: "C:\\Private\\other.exe" }] },
    });
    const before = await build();
    expect(before).toContain(
      "exact arguments are enforced at runtime; no approval prompt needed when args match",
    );
    expect(before).toContain(
      "C:\\Tools\\a.exe (any arguments)\n  C:\\Tools\\z.exe (restricted args)",
    );
    expect(before).not.toContain("other.exe");
    main.allowlist.unshift({ pattern: "C:\\Tools\\b.exe", argPattern: "" });
    const added = await build();
    expect(added).toContain("b.exe (any arguments)");
    main.allowlist.reverse();
    expect(await build()).toBe(added);
    file.agents = {};
    await expectContext(params);
    expect(await build({ ...params, includeEmptySnapshots: true })).toBe(
      "## Approved executables\nnone",
    );
  }));
it("bounds executable hints and omits unsafe, command and non-path entries", () =>
  withMockedPlatform("win32", async () => {
    approvals({
      main: {
        allowlist: [
          ...[
            "*",
            "node",
            "=command:C:\\Tools\\node.exe --version",
            "C:\\bad\nname.exe",
            "C:\\" + "x".repeat(300) + ".exe",
          ].map((pattern) => ({ pattern })),
          ...Array.from({ length: 12 }, (_, i) => ({
            pattern: "C:\\Tools\\app" + String(i).padStart(2, "0") + ".exe",
          })).toReversed(),
        ],
      },
    });
    const text = await build();
    expect(text?.match(/\(any arguments\)/g)).toHaveLength(10);
    expect(text).toContain("app00.exe");
    expect(text).toContain("app09.exe");
    expect(text).not.toMatch(/app10|app11|=command:|bad|xxx/);
    expect(text!.length).toBeLessThan(3000);
  }));
it.each(["linux", "win32"] as const)("gates approval reads on %s and exec capability", (platform) =>
  withMockedPlatform(platform, async () => {
    const load = vi
      .spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync")
      .mockRejectedValue(new Error("unavailable"));
    await expectContext({ ...params, capabilityToolNames: new Set(["read"]) });
    await expectContext({
      ...params,
      executionHost: false,
      capabilityToolNames: new Set(["exec", "process"]),
    });
    expect(load).not.toHaveBeenCalled();
    await expectContext(
      params,
      platform === "win32" ? context("## Approved executables\nunavailable") : [temporal],
    );
    if (platform === "linux") {
      expect(load).not.toHaveBeenCalled();
    }
  }),
);
function task(
  tool: "image" | "music" | "video",
  overrides: Partial<MediaGenerationOperation> = {},
): MediaGenerationOperation {
  return {
    taskId: tool + "-1",
    taskKind: `${tool}_generation`,
    sourceId: tool === "image" ? "image_generate:provider" : tool + "_generate",
    requesterSessionKey: mediaParams.sessionKey,
    requesterAgentId: "main",
    task: "Generate media",
    status: "running",
    ...overrides,
  };
}
it("refreshes the scoped media snapshot and can explicitly clear it", async () => {
  const read = vi
    .spyOn(mediaActivity, "listMediaGenerationOperations")
    .mockReturnValue([
      task("video", { status: "queued" }),
      task("image", { requesterAgentId: "other" }),
      task("image", { progressSummary: "Rendering" }),
      task("music"),
    ]);
  await expectContext(
    mediaParams,
    media(
      '- tool=image_generate; task=image-1; status=running; provider_json="provider"; progress_json="Rendering"',
      "- tool=music_generate; task=music-1; status=running",
      "- tool=video_generate; task=video-1; status=queued",
    ),
  );
  read.mockReturnValue([]);
  await expectContext(mediaParams);
  await expectContext(
    { ...mediaParams, includeEmptySnapshots: true },
    media(
      "- tool=image_generate; none",
      "- tool=music_generate; none",
      "- tool=video_generate; none",
    ),
  );
});
it("includes only enabled media sections", async () => {
  vi.spyOn(mediaActivity, "listMediaGenerationOperations").mockReturnValue([
    task("image"),
    task("music"),
  ]);
  const input = {
    ...mediaParams,
    capabilityToolNames: new Set(["music_generate", "video_generate"]),
  };
  const line = "- tool=music_generate; task=music-1; status=running";
  await expectContext(input, media(line));
  await expectContext(
    { ...input, includeEmptySnapshots: true },
    media(line, "- tool=video_generate; none"),
  );
});
it.each([undefined, "   "])("does not read media without a session: %j", async (sessionKey) => {
  const read = vi.spyOn(mediaActivity, "listMediaGenerationOperations");
  const input = { ...mediaParams, sessionKey };
  await expectContext(input);
  await expectContext(
    { ...input, includeEmptySnapshots: true },
    media(
      "- tool=image_generate; none",
      "- tool=music_generate; none",
      "- tool=video_generate; none",
    ),
  );
  expect(read).not.toHaveBeenCalled();
});


it("renders the latest retained-input page in a stable, bounded summary", async () => {
  const read = vi.spyOn(pendingInputs, "listSessionPendingInputs");
  const input = {
    ...params,
    executionHost: false,
    sessionTarget: { sessionId: "session", sessionKey: "agent:main:session" },
  };
  read.mockResolvedValue({ items: [], total: 0 });
  expect(await buildRuntimeFactsContext(input)).toContainEqual(
    fact("## Interrupted inputs\nnone in the latest retained-input page"),
  );
  read.mockResolvedValue({
    total: 2,
    items: [
      { id: "b", runId: "b", acceptedAt: 2, state: "interrupted", message: { role: "user", content: "second", timestamp: 2 } },
      { id: "a", runId: "a", acceptedAt: 1, state: "interrupted", message: { role: "user", content: "first", timestamp: 1 } },
    ],
  });
  expect(await buildRuntimeFactsContext(input)).toContainEqual(
    fact('## Interrupted inputs\n- interrupted: "first"\n- interrupted: "second"'),
  );
  expect(read).toHaveBeenLastCalledWith(expect.anything(), { limit: 10 });
});

describe("interrupted inputs none state", () => {
  const target = {
    ...params,
    executionHost: false,
    sessionTarget: { sessionId: "session", sessionKey: "agent:main:session" },
  };
  const interruptedText = (fragments: Awaited<ReturnType<typeof buildRuntimeFactsContext>>) =>
    fragments.find((fragment) => fragment.text.startsWith(INTERRUPTED_INPUTS_SECTION_HEADING))?.text;

  it("renders the exact none section when the retained-input page is empty", async () => {
    vi.spyOn(pendingInputs, "listSessionPendingInputs").mockResolvedValue({ items: [], total: 0 });
    const fragments = await buildRuntimeFactsContext(target);
    expect(interruptedText(fragments)).toBe(INTERRUPTED_INPUTS_NONE_SECTION);
    expect(INTERRUPTED_INPUTS_NONE_SECTION).toBe(
      "## Interrupted inputs\nnone in the latest retained-input page",
    );
    expect(fragments).toContainEqual(fact(INTERRUPTED_INPUTS_NONE_SECTION));
  });

  it("lists interrupted inputs without the none line when the page is non-empty", async () => {
    vi.spyOn(pendingInputs, "listSessionPendingInputs").mockResolvedValue({
      total: 1,
      items: [
        { id: "a", runId: "a", acceptedAt: 1, state: "interrupted", message: { role: "user", content: "first", timestamp: 1 } },
      ],
    });
    const fragments = await buildRuntimeFactsContext(target);
    const text = interruptedText(fragments);
    expect(text).toBe('## Interrupted inputs\n- interrupted: "first"');
    expect(text).not.toContain(INTERRUPTED_INPUTS_NONE_LINE);
  });

  it.each([
    ["stale entries then an explicit none", "non-empty-first"],
    ["an explicit none then stale entries", "none-first"],
  ])("keeps only the latest snapshot of the family: %s", async (_label, order) => {
    const read = vi.spyOn(pendingInputs, "listSessionPendingInputs");
    read.mockResolvedValueOnce({ items: [], total: 0 });
    const noneText = interruptedText(await buildRuntimeFactsContext(target));
    read.mockResolvedValueOnce({
      total: 1,
      items: [
        { id: "a", runId: "a", acceptedAt: 1, state: "interrupted", message: { role: "user", content: "first", timestamp: 1 } },
      ],
    });
    const listedText = interruptedText(await buildRuntimeFactsContext(target));
    expect(noneText).toBe(INTERRUPTED_INPUTS_NONE_SECTION);
    const familyOf = (text: string) => text.split("\n", 1)[0];
    const stale = { kind: "conversation-data" as const, snapshotFamily: familyOf(listedText!), text: listedText! };
    const none = { kind: "conversation-data" as const, snapshotFamily: familyOf(noneText!), text: noneText! };
    const fragments = order === "none-first" ? [none, stale] : [stale, none];
    const kept = supersedeRuntimeContextSnapshots(fragments);
    expect(kept).toEqual([order === "none-first" ? stale : none]);
    // An explicit none in the latest snapshot means no active work survives it.
    if (order !== "none-first") {
      expect(kept[0]?.text).not.toContain('"first"');
    }
  });

  it("leaves Temporal Context unchanged and renders byte-identical output", async () => {
    vi.spyOn(pendingInputs, "listSessionPendingInputs").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-01T07:00:00Z"));
    const input = {
      ...target,
      cfg: { agents: { defaults: { userTimezone: "America/Los_Angeles" } } },
      capabilityToolNames: new Set(["session_status"]),
    };
    const first = await buildRuntimeFactsContext(input);
    const second = await buildRuntimeFactsContext(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first).toContainEqual(
      fact(
        "## Temporal Context\nCurrent date: 2026-09-01\nTime zone: America/Los_Angeles\nFor the exact current time, use `session_status`.",
      ),
    );
    expect(interruptedText(first)).toBe(
      "## Interrupted inputs\nnone in the latest retained-input page",
    );
  });
});
