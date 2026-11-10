import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import * as terminalTable from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatStatusModelsLines, resolveStatusModelsBlock } from "./status-models.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import {
  baseStatusOverviewSurface,
  createStatusCommandReportDataParams,
} from "./status.test-support.js";

// mock-isolation: Formatting consumes fixed facts, not live backup or database inspection.
vi.mock("../state/backup-run-records.js", () => ({ readBackupRunFreshness: async () => ({}) }));
vi.mock("./status-database-engines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-database-engines.js")>()),
  resolveStatusDatabaseEngines: async () => ({ source: "admitted", stores: [] }),
}));

beforeEach(() => {
  for (const color of ["success", "warn", "muted", "error"] as const) {
    vi.spyOn(theme, color).mockImplementation(String);
  }
  vi.spyOn(terminalTable, "renderTable").mockReturnValue("table");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const populatedCfg = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.4"] },
      models: {
        "anthropic/claude-sonnet-5": { alias: "sonnet" },
        "openai/gpt-5.4": { alias: "gpt" },
      },
    },
  },
};

async function reportLines(
  overrides: Parameters<typeof createStatusCommandReportDataParams>[0],
): Promise<string[]> {
  const lines = await buildStatusCommandReportLines(createStatusCommandReportDataParams(overrides));
  return lines.map(stripAnsi);
}

function modelsSection(lines: string[]): string[] {
  const start = lines.indexOf("Models");
  expect(start).toBeGreaterThanOrEqual(0);
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") {
      break;
    }
    section.push(line);
  }
  return section;
}

describe("resolveStatusModelsBlock", () => {
  it("lists configured aliases with the default model", () => {
    expect(resolveStatusModelsBlock(populatedCfg)).toEqual({
      defaultModel: "openai/gpt-5.4",
      aliases: [
        { alias: "gpt", model: "openai/gpt-5.4" },
        { alias: "sonnet", model: "anthropic/claude-sonnet-5" },
      ],
    });
  });

  it("reads a string default model", () => {
    expect(
      resolveStatusModelsBlock({ agents: { defaults: { model: "openai/gpt-5.4" } } }).defaultModel,
    ).toBe("openai/gpt-5.4");
  });

  it("handles missing alias config gracefully", () => {
    expect(resolveStatusModelsBlock({})).toEqual({ defaultModel: null, aliases: [] });
    expect(resolveStatusModelsBlock(null)).toEqual({ defaultModel: null, aliases: [] });
    expect(formatStatusModelsLines({ defaultModel: null, aliases: [] })).toContain(
      "Aliases: none configured",
    );
  });

  it("skips entries without an alias", () => {
    const block = resolveStatusModelsBlock({
      agents: { defaults: { models: { "openai/gpt-5.4": {} } } },
    });
    expect(block.aliases).toEqual([]);
  });
});

describe("status Models section", () => {
  it("shows the default model and alias mappings", async () => {
    const lines = await reportLines({
      surface: { ...baseStatusOverviewSurface, cfg: populatedCfg } as never,
    });
    expect(modelsSection(lines)).toEqual([
      "Default: openai/gpt-5.4",
      "gpt -> openai/gpt-5.4",
      "sonnet -> anthropic/claude-sonnet-5",
    ]);
  });

  it("shows a none-configured line when no aliases exist", async () => {
    const lines = await reportLines({});
    expect(modelsSection(lines)).toContain("Aliases: none configured");
  });

  it("never prints alias entry values such as params", async () => {
    const lines = await reportLines({
      surface: {
        ...baseStatusOverviewSurface,
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
              models: {
                "openai/gpt-5.4": { alias: "gpt", params: { apiKey: "super-secret-value" } },
              },
            },
          },
        },
      } as never,
    });
    expect(lines.join("\n")).not.toContain("super-secret-value");
    expect(modelsSection(lines)).toEqual(["Default: openai/gpt-5.4", "gpt -> openai/gpt-5.4"]);
  });
});
