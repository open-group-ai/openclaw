import { expect, it } from "vitest";
import { evaluateWorkflowRunner as runner, readWorkflow } from "./ci-workflow.test-support.js";

type Job = {
  "runs-on"?: string | string[];
  uses?: string;
  with?: Record<string, string>;
  environment?: unknown;
  permissions?: Record<string, string>;
};
type Workflow = {
  on: { workflow_call?: { inputs?: Record<string, { default?: unknown }> } };
  jobs: Record<string, Job>;
};
const workflow = (name: string): Workflow => readWorkflow(`.github/workflows/${name}.yml`);
const group = 'Release "reserved"';
// Open Group: release Linux jobs run on the self-hosted super-cluster; reservations no longer route
// runs-on, but reusable callers still forward runner_group.
const LINUX_RUNNER = ["self-hosted", "Linux", "X64", "grow-ci", "open-group-super-cluster"];
const reserved = {
  runnerBackend: "github" as const,
  preflightOutputs: { node_runner_backend: "github" },
  releaseRunnerGroup: group,
  runnerGroup: group,
  dispatchId: "full-release-validation-123-1",
  releasePublishRunId: "123",
};

it.each([
  ["full-release-validation", "resolve_target"],
  ["install-smoke-reusable", "preflight"],
  ["ci", "checks-fast-core"],
])("keeps %s/%s on the self-hosted fleet", (name, job) => {
  expect(workflow(name).jobs[job]!["runs-on"]).toEqual(LINUX_RUNNER);
});

it("keeps credentialed publishers on the self-hosted fleet", () => {
  const publishers = `
    openclaw-release-publish openclaw-release-promote openclaw-npm-release plugin-npm-release
    plugin-clawhub-release plugin-clawhub-new plugin-clawhub-postpublish docker-release
    vercel-container-registry-publish
  `
    .trim()
    .split(/\s+/u);
  for (const name of publishers) {
    for (const job of Object.values(workflow(name).jobs)) {
      if (
        job["runs-on"] &&
        (job.environment !== undefined ||
          job.permissions?.["id-token"] === "write" ||
          /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/u.test(JSON.stringify(job)))
      ) {
        expect(job["runs-on"], name).toEqual(LINUX_RUNNER);
      }
    }
  }
});

it("forwards reservations through reusable calls in both release orchestrators", () => {
  for (const name of ["full-release-validation", "openclaw-release-checks"]) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      const child = /^\.\/\.github\/workflows\/(.+)\.yml$/u.exec(job.uses ?? "")?.[1];
      if (!child || !workflow(child).on.workflow_call?.inputs?.runner_group) {
        continue;
      }
      expect(workflow(child).on.workflow_call?.inputs?.runner_group?.default, child).toBe("");
      expect(runner(job.with?.runner_group, reserved), `${name}/${jobName}`).toBe(group);
    }
  }
});
