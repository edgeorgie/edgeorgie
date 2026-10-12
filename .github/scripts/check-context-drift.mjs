#!/usr/bin/env node
//
// Asserts that the status check `main`'s protection REQUIRES is still a context
// some job in verify.yml actually produces.
//
// WHY THIS EXISTS
//
// `main`'s required context is the literal string `verify`, which is the bare
// job id of the gate job — that job has no job-level `name:`, so GitHub reports
// the id. Adding a `name:` to it, or renaming the job, is a one-line cosmetic
// edit that renames the reported context while protection goes on requiring the
// old name. Every PR then waits forever on a check nothing will ever report and
// `main` is wedged, from an edit whose own CI was green.
//
// The sibling repo (edgeorgie/agentlens) hit exactly that and now has three
// layers against it. This repository — the more visible one — had none.
//
// WHY THIS PARSES YAML RATHER THAN GREPPING FOR JOB IDS
//
// The sibling repo's equivalent guard was bypassed SIX times, and every single
// bypass had one root cause: deriving structure from TEXT (lines, indentation,
// a key regex) when GitHub acts on the PARSED DOCUMENT. The most recent bypass
// was a single pair of quote marks (`'exclude':` instead of `exclude:`). The
// decisive case is a YAML merge key:
//
//     x-jobs: &extra
//       verify:
//         name: Something Else
//     jobs:
//       <<: *extra
//
// A key injected through `<<: *anchor` never appears literally in the text, so
// no regex over lines can see it, however many spellings it learns. That is a
// proof rather than an anecdote, and it is why this reads `jobs` off a real
// parse. Quoting, key order, flow vs block style, the explicit `? key` form,
// anchors, aliases and merge keys all stop being special cases.
//
// WHAT THIS CANNOT DO ON THIS REPOSITORY, AND WHY IT WARNS INSTEAD OF PASSING
//
// `main` here uses CLASSIC branch protection, not a ruleset
// (`GET /repos/{o}/{r}/rules/branches/main` returns `[]`). Classic protection
// is readable only with `administration` permission, which `GITHUB_TOKEN`
// cannot be granted — that is precisely why the sibling repo migrated `main` to
// a ruleset: to make the live state observable from inside a workflow.
//
// So under `GITHUB_TOKEN` this script CANNOT read the required contexts, and it
// says so and exits 0 with a warning rather than either (a) passing silently,
// which would make it decorative, or (b) failing every run, which would train
// the reader to ignore a job that is red by design. It becomes a real assertion
// the moment it is given a token that can read protection, or once this branch
// is migrated to a ruleset. The local half — "the job id the context names must
// match still exists" — is asserted unconditionally and needs no credential.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const REPO = process.env.GITHUB_REPOSITORY ?? "edgeorgie/edgeorgie";
const BRANCH = "main";
// Taken from the environment so this script can be RUN from a directory that
// is not the repository checkout. That matters because its one dependency
// (`yaml`) must be installed outside the workspace: `npm install` in the
// checkout creates ./node_modules, and the lychee step globs './**/*.md', so
// dependency READMEs would be link-checked and would fail the job on their own
// links — which is exactly what happened on this workflow's first real run.
// Node's ESM resolver walks up from the SCRIPT's location, not the cwd
// (verified: NODE_PATH has no effect on ESM imports), so the script is copied
// next to the installed module and told where the workflow is.
const WORKFLOW_PATH = process.env.VERIFY_WORKFLOW_PATH
  ? new URL(`file://${process.env.VERIFY_WORKFLOW_PATH}`)
  : new URL("../workflows/verify.yml", import.meta.url);

// The job whose reported context is (and must remain) the required check.
const GATE_JOB_ID = "verify";

/** Exits non-zero with an explanation. */
function fail(message) {
  console.error(`✗ required-context drift check FAILED\n\n${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Local half: what contexts does verify.yml actually produce?
// ---------------------------------------------------------------------------

let workflow;
try {
  // `merge: true` resolves `<<:` so a key injected via an anchor is seen
  // exactly as GitHub sees it. `uniqueKeys: true` makes a duplicate key a parse
  // error instead of a silent last-wins overwrite.
  workflow = parseYaml(readFileSync(WORKFLOW_PATH, "utf8"), {
    merge: true,
    uniqueKeys: true,
  });
} catch (error) {
  fail(`verify.yml is not valid YAML, so its contexts cannot be derived: ${error.message}`);
}

const jobs = workflow?.jobs;
if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
  fail("verify.yml has no `jobs:` mapping — the workflow shape changed and this guard needs updating");
}

const gateJob = jobs[GATE_JOB_ID];
if (gateJob === null || typeof gateJob !== "object" || Array.isArray(gateJob)) {
  fail(
    `verify.yml no longer declares a \`${GATE_JOB_ID}:\` job (jobs present: ` +
      `${Object.keys(jobs).join(", ") || "none"}).\n\n` +
      `\`${GATE_JOB_ID}\` is the literal context name \`${BRANCH}\`'s ` +
      "protection requires. With that job id gone, no run can ever report it " +
      "and every PR waits forever — `main` is WEDGED. Either restore the job " +
      "id or update protection first:\n\n" +
      `  gh api -X PATCH repos/${REPO}/branches/${BRANCH}/protection/required_status_checks \\\n` +
      "    -f 'contexts[]=<new context name>'",
  );
}

// A job-level `name:` REPLACES the job id in the reported context name. That is
// the exact one-line edit this guard exists to catch.
if ("name" in gateJob && gateJob.name !== null && gateJob.name !== undefined) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job now sets \`name: ${JSON.stringify(gateJob.name)}\`.\n\n` +
      "A job-level `name:` REPLACES the job id in the reported status-check " +
      `context, so this job will report ${JSON.stringify(String(gateJob.name))} ` +
      `while \`${BRANCH}\`'s protection still requires \`${GATE_JOB_ID}\` — a ` +
      "context nothing reports. Every PR waits forever and `main` is WEDGED, " +
      "from a purely cosmetic edit whose own CI was green.\n\n" +
      "Either drop the `name:` (keeping the context stable), or rename the " +
      "required context in protection in the SAME change.",
  );
}

// The gate must also be able to FAIL. These leave the context name identical
// while making the required check unable to report red: `continue-on-error`
// makes the job report success even when its steps fail, and a job-level `if:`
// can skip it — and branch protection treats a skipped job's required context
// as satisfied. Neither is visible to a name-comparison check.
if ("continue-on-error" in gateJob && gateJob["continue-on-error"] !== false) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job sets \`continue-on-error\`, so it ` +
      "reports SUCCESS even when its steps fail. The required context still " +
      "reports — it just always reports green. The merge gate is decorative, " +
      "with no change to any context name.",
  );
}
if ("if" in gateJob && gateJob.if !== null && gateJob.if !== undefined) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job is conditional (\`if: ${String(gateJob.if)}\`). ` +
      "Branch protection treats a SKIPPED job's required context as " +
      "satisfied, so for every commit the condition excludes the gate is " +
      "silently absent — with no change to any context name.",
  );
}

// This job must be a single context, not a matrix: a matrix would report one
// context per combination and none of them would be the bare `verify`.
if (gateJob.strategy?.matrix !== undefined) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job now has a \`strategy.matrix\`, so it ` +
      `reports one context PER COMBINATION (e.g. \`${GATE_JOB_ID} (20)\`) ` +
      `rather than the bare \`${GATE_JOB_ID}\` that protection requires.`,
  );
}

console.log(
  `✓ verify.yml still declares \`${GATE_JOB_ID}:\` with no job-level ` +
    "`name:`, no `continue-on-error`, no job-level `if:` and no matrix, so it " +
    `reports exactly the context \`${GATE_JOB_ID}\``,
);

// ---------------------------------------------------------------------------
// Live half: does protection still require that context?
// ---------------------------------------------------------------------------

const headers = { Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

/**
 * GETs a path, retrying only transient failures. A 403/404 is an answer rather
 * than a blip, so it is returned instead of retried — on this repository a 403
 * is in fact the EXPECTED answer (see the header).
 */
async function get(path, attempts = 3) {
  let last = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, { headers });
    } catch (error) {
      last = `network error: ${error?.message ?? error}`;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      break;
    }
    if (res.ok) return { ok: true, body: await res.json() };
    last = `HTTP ${res.status} ${res.statusText}`;
    if (res.status < 500 && res.status !== 429) return { ok: false, status: res.status, error: last };
    if (attempt === attempts) break;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return { ok: false, error: last };
}

const protection = await get(
  `/repos/${REPO}/branches/${BRANCH}/protection/required_status_checks`,
);

if (!protection.ok) {
  // Expected under GITHUB_TOKEN: classic protection needs `administration`,
  // which it cannot be granted. Warn rather than pass silently or fail daily.
  console.warn(
    `⚠ could not read live required status checks for ${REPO}@${BRANCH} ` +
      `(${protection.error}).\n` +
      "  This is EXPECTED under GITHUB_TOKEN: `main` here uses CLASSIC branch " +
      "protection, which is readable only with `administration` permission " +
      "that GITHUB_TOKEN cannot be granted. The local assertions above DID " +
      "run; the live half did not, so this run has NOT confirmed that " +
      `protection still requires \`${GATE_JOB_ID}\`.\n` +
      "  To make this a real assertion: migrate `main` to a ruleset (as " +
      "edgeorgie/agentlens did, which is readable with metadata:read), or run " +
      "this step with a PAT/App token that has `administration: read`.",
  );
  process.exit(0);
}

const required = protection.body?.contexts ?? [];
if (!Array.isArray(required) || required.length === 0) {
  fail(
    `\`${BRANCH}\` protection requires NO status checks, so nothing gates the ` +
      "branch and any commit can merge. Expected it to require " +
      `\`${GATE_JOB_ID}\`.`,
  );
}

const produced = new Set(
  Object.entries(jobs).map(([id, job]) =>
    job && typeof job === "object" && typeof job.name === "string"
      ? job.name
      : id,
  ),
);
const unreportable = required.filter((c) => !produced.has(c));

if (unreportable.length > 0) {
  fail(
    `REQUIRED BUT NEVER PRODUCED: [${unreportable.join(", ")}]\n\n` +
      "  These contexts are required by live protection but no job in " +
      "verify.yml reports them. Every PR will wait on them forever — `main` " +
      "is WEDGED right now.\n\n" +
      `live protection requires: [${required.join(", ")}]\n` +
      `verify.yml can report:    [${[...produced].join(", ")}]`,
  );
}

console.log(
  `✓ live protection on ${REPO}@${BRANCH} requires [${required.join(", ")}], ` +
    `every one of which a job in verify.yml reports`,
);
