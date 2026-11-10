import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CronDeliveryPreview, CronJob } from "../../cron/types.js";
import { printCronList, toAutomationListJson } from "./shared.js";

const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn<(value: string) => void>(),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    callGatewayFromCli: vi.fn(),
  };
});

const { defaultRuntime, callGatewayFromCli } = mocks;

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli: mocks.callGatewayFromCli };
});

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));

const { registerCronCli } = await import("../cron-cli.js");

const FIXED_NOW = new Date("2026-09-05T05:51:35.278Z").getTime();

function makeJob(overrides: Partial<CronJob> & { id: string; name: string }): CronJob {
  return {
    enabled: true,
    createdAtMs: FIXED_NOW,
    updatedAtMs: FIXED_NOW,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "scheduled check" },
    state: {},
    ...overrides,
  } as CronJob;
}

function cronPage(
  jobs: CronJob[],
  offset = 0,
  total = jobs.length,
  deliveryPreviews?: Record<string, CronDeliveryPreview>,
) {
  const next = offset + jobs.length;
  return {
    jobs,
    snapshotRevision: "test-stable-cron-inventory",
    total,
    offset,
    limit: 200,
    hasMore: next < total,
    nextOffset: next < total ? next : null,
    deliveryPreviews,
  };
}

// Fixture inventory: one enabled job with full timing, one disabled job,
// one job with no timing. The disabled job is only returned when the CLI
// passes includeDisabled (i.e. --all), matching Gateway filtering.
const enabledJob = () =>
  makeJob({
    id: "job-enabled",
    name: "Enabled job",
    state: { nextRunAtMs: FIXED_NOW + 3_600_000, lastRunAtMs: FIXED_NOW - 3_600_000 },
  });

const disabledJob = () =>
  makeJob({
    id: "job-disabled",
    name: "Disabled job",
    enabled: false,
    state: {},
  });

const SECRET = "scratch-secret-sentinel-9f8c";
const secretJob = () =>
  ({
    ...makeJob({
      id: "job-secret",
      name: "Secret job",
      state: { nextRunAtMs: FIXED_NOW + 60_000 },
    }),
    scratch: { content: SECRET },
    payload: {
      kind: "command",
      argv: ["sh", "-lc", "echo hunter2"],
      env: { TOKEN: "token-secret-sentinel" },
    },
  }) as unknown as CronJob;

function installListMock(jobs: CronJob[]) {
  callGatewayFromCli.mockImplementation(async (method: string, _opts: unknown, params?: unknown) => {
    if (method === "cron.status") {
      return { enabled: true };
    }
    if (method === "cron.list") {
      const includeDisabled = (params as { includeDisabled?: boolean })?.includeDisabled === true;
      const visible = includeDisabled ? jobs : jobs.filter((job) => job.enabled);
      return cronPage(visible);
    }
    return { ok: true };
  });
}

async function runCron(args: string[], root = "cron"): Promise<void> {
  const program = new Command().exitOverride();
  registerCronCli(program);
  await program.parseAsync([root, ...args], { from: "user" });
}

function lastJson(): unknown {
  return defaultRuntime.writeJson.mock.calls.at(-1)?.[0];
}

function stdoutJson(): string {
  return defaultRuntime.writeStdout.mock.calls.map(([value]) => value).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps the default table output on the human renderer", async () => {
  const jobs = [enabledJob(), disabledJob()].filter((job) => job.enabled);
  installListMock([enabledJob(), disabledJob()]);
  await runCron(["list"]);
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  const cliLines = defaultRuntime.log.mock.calls.flat().join("\n");

  const expected: string[] = [];
  printCronList(jobs, {
    log: (...args) => expected.push(...args.flatMap((value) => String(value).split("\n"))),
    error: () => {},
    exit: () => {},
  } as unknown as Parameters<typeof printCronList>[1]);
  expect(cliLines).toBe(expected.join("\n"));
  expect(cliLines).toContain("job-enabled");
});

it("emits a stable JSON array with documented keys", async () => {
  installListMock([enabledJob()]);
  await runCron(["list", "--json"]);
  expect(defaultRuntime.log).not.toHaveBeenCalled();
  const json = lastJson();
  expect(Array.isArray(json)).toBe(true);
  expect(json).toHaveLength(1);
  const entry = (json as ReturnType<typeof toAutomationListJson>)[0];
  expect(Object.keys(entry as Record<string, unknown>).toSorted()).toEqual(
    ["enabled", "hasScratch", "id", "lastRunAt", "name", "nextRunAt", "schedule"].toSorted(),
  );
  expect(entry).toEqual({
    id: "job-enabled",
    name: "Enabled job",
    schedule: { kind: "every", everyMs: 60_000 },
    enabled: true,
    lastRunAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
    nextRunAt: new Date(FIXED_NOW + 3_600_000).toISOString(),
    hasScratch: false,
  });
  // Stdout carries only valid JSON: no banners, colors, or progress text.
  expect(() => JSON.parse(stdoutJson())).not.toThrow();
  expect(stdoutJson()).not.toContain("\u001B");
});

it("uses null for unknown timestamps", async () => {
  installListMock([disabledJob()]);
  await runCron(["list", "--all", "--json"]);
  const json = lastJson() as ReturnType<typeof toAutomationListJson>;
  expect(json).toHaveLength(1);
  expect(json[0]).toMatchObject({ id: "job-disabled", lastRunAt: null, nextRunAt: null });
});

it("respects --all as a superset of the default set", async () => {
  installListMock([enabledJob(), disabledJob()]);
  await runCron(["list", "--json"]);
  const base = lastJson() as Array<{ id: string }>;
  expect(base.map((entry) => entry.id)).toEqual(["job-enabled"]);

  await runCron(["list", "--all", "--json"]);
  const all = lastJson() as Array<{ id: string }>;
  expect(all.map((entry) => entry.id).toSorted()).toEqual(["job-disabled", "job-enabled"]);
  for (const entry of base) {
    expect(all).toContainEqual(entry);
  }
});

it("prints [] for an empty list with exit code 0", async () => {
  installListMock([]);
  await runCron(["list", "--json"]);
  expect(lastJson()).toEqual([]);
  expect(stdoutJson()).toContain("[]");
  expect(defaultRuntime.error).not.toHaveBeenCalled();
});

it("reports scratch presence without leaking contents or secrets", async () => {
  installListMock([secretJob()]);
  await runCron(["list", "--all", "--json"]);
  const json = lastJson() as Array<Record<string, unknown>>;
  expect(json).toHaveLength(1);
  expect(json[0]?.hasScratch).toBe(true);
  const raw = JSON.stringify(json);
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain("token-secret-sentinel");
  expect(raw).not.toContain("hunter2");
  expect(raw).not.toContain("PRIVATE");
});
