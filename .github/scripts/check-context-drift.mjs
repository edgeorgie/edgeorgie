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
// HOW THE LIVE HALF READS PROTECTION WITHOUT `administration` PERMISSION
//
// `main` here uses CLASSIC branch protection, not a ruleset
// (`GET /repos/{o}/{r}/rules/branches/main` returns `[]`).
// `GET /repos/{o}/{r}/branches/main/protection/required_status_checks` — the
// endpoint an earlier revision of this script used — needs `administration`
// read, which `GITHUB_TOKEN` cannot be granted. That revision therefore
// warned and exited 0 on EVERY real run, and the warning was indistinguishable
// from the two states that actually matter: a wedged branch, and protection
// deleted outright. A gate that is green for a reason unrelated to the change
// under review is one nobody reads.
//
// The fix is an endpoint, not a credential. `GET /repos/{o}/{r}/branches/main`
// embeds the required contexts in `protection.required_status_checks.contexts`
// and needs only repository READ. Verified against three real repositories,
// UNAUTHENTICATED (strictly weaker than this workflow's `contents: read`):
//
//   edgeorgie/edgeorgie  HTTP 200  protected=true   contexts=["verify"]
//   edgeorgie/agentlens  HTTP 200  protected=true   contexts=[]        (ruleset)
//   edgeorgie/todo       HTTP 200  protected=false  contexts=[]
//
// while `/protection/required_status_checks` answered HTTP 401 on all three.
// So the live assertion is now REAL under the workflow's own credentials.
//
// Rulesets express the same requirement in a different shape and report
// nothing under `protection` (see `agentlens` above, which is ruleset-governed
// and reads back `contexts: []`). Both are therefore consulted and their
// contexts unioned, so this keeps working if `main` is ever migrated.
//
// WHAT HAPPENS WHEN THE READ GENUINELY FAILS
//
// It exits NON-ZERO with "could not verify", because an unverifiable claim is
// not a satisfied one. The one exception is rate limiting, which is neither a
// permissions problem nor a drift signal: an unauthenticated api.github.com
// call gets 60 requests/hour PER SOURCE IP, and GitHub-hosted runners share a
// NAT pool, so a job can be refused having made no call of its own. That is
// distinguished from a real permissions refusal by the `x-ratelimit-remaining`
// response header — `remaining: 0` means "wait or add a token", anything else
// on a 403 means "this credential is not allowed to read this" — and the two
// get different messages because they need different responses.
//
// The token is OPTIONAL so a local run works with no credential at all; it is
// passed in CI only to spend the authenticated 5000/hr quota instead of the
// shared-IP 60/hr one.

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

// ---------------------------------------------------------------------------
// STEP level. The checks above are all JOB level, and that was a real hole.
// ---------------------------------------------------------------------------
//
// Measured against the revision before this block, with every assertion above
// passing and the reported context name identical in all three cases:
//
//   - if: false              on the gate's only real step  → exit 0, ACCEPTED
//   - continue-on-error: true on the same step             → exit 0, ACCEPTED
//   fail: false              on the lychee action          → exit 0, ACCEPTED
//
// The discriminating controls, run in the same probe: a job-level `name:` and a
// job-level `if:` were both correctly REFUSED. So the guard was not broken — it
// was checking the job and ignoring the steps, which is where this workflow's
// gate actually lives. `verify` has exactly one substantive step, so disarming
// that step disarms the entire required check on this repository's `main`.
//
// A step-level `if:` is the worse of the three because it does not skip the
// JOB: the job runs, succeeds, reports `verify` green, and the work never
// happened.
const steps = gateJob.steps;
if (!Array.isArray(steps)) {
  // Fail CLOSED. `steps:` deleted or replaced by something this parser does
  // not resolve to a sequence means the step-level assertions below did not
  // run — which is unverified, not clean. A bare `if (Array.isArray(...))`
  // with no `else` is the exact vacuous-pass shape this guard exists to catch.
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job has no \`steps:\` sequence (got ` +
      `${steps === undefined ? "nothing" : typeof steps}). The gate's steps ` +
      "are where it can be disarmed without changing its context name, so " +
      "an unreadable step list is unverified rather than clean.",
  );
}

const conditionalSteps = steps.filter(
  (step) =>
    step !== null &&
    typeof step === "object" &&
    !Array.isArray(step) &&
    "if" in step &&
    step.if !== null &&
    step.if !== undefined,
);
if (conditionalSteps.length > 0) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job has ${conditionalSteps.length} ` +
      `conditional step(s) (\`if: ${conditionalSteps
        .map((step) => String(step.if))
        .join("`, `if: ")}\`).\n\n` +
      "A skipped STEP does not skip the job. The job runs, SUCCEEDS, and " +
      `reports \`${GATE_JOB_ID}\` green with that step's work never ` +
      "performed — the context name is unchanged and every job-level " +
      "assertion above still passes. This job has one substantive step, so " +
      "a condition on it disarms the entire merge gate.\n\n" +
      "Put the condition inside the command, or move the step to a job that " +
      "is not required.",
  );
}

const excusedSteps = steps.filter(
  (step) =>
    step !== null &&
    typeof step === "object" &&
    !Array.isArray(step) &&
    "continue-on-error" in step &&
    step["continue-on-error"] !== false,
);
if (excusedSteps.length > 0) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job has ${excusedSteps.length} step(s) ` +
      "with `continue-on-error` set. A failing step that is excused does not " +
      "fail the job, so the required context reports green regardless — with " +
      "no change to any context name.",
  );
}

// The gate must actually RUN its assertion. Every check above can pass on a
// job whose steps are `checkout` and nothing else: the context name is
// correct, no step is conditional or excused, and the job reports green having
// asserted nothing. That is the empty-gate shape, and it is reachable by
// DELETING a line rather than adding one, which no "is this flag set" check
// can see.
//
// `verify`'s assertion is `node .github/scripts/check-local-links.mjs`. This
// requires that some step still invokes it. Matching on the script path rather
// than on step count or step name, because a renamed step is fine and an
// extra step is fine — what is not fine is the assertion being gone.
const GATE_ASSERTION = ".github/scripts/check-local-links.mjs";

const runsAssertion = steps.some(
  (step) =>
    step !== null &&
    typeof step === "object" &&
    !Array.isArray(step) &&
    typeof step.run === "string" &&
    step.run.includes(GATE_ASSERTION),
);

if (!runsAssertion) {
  fail(
    `verify.yml's \`${GATE_JOB_ID}:\` job no longer runs \`${GATE_ASSERTION}\`.\n\n` +
      "That script IS the gate's assertion. Without it the job checks out the " +
      "repository, does nothing, and reports `" +
      GATE_JOB_ID +
      "` GREEN — a required check that passes unconditionally, with its " +
      "context name unchanged and every other assertion in this guard still " +
      "satisfied. An empty gate is reached by deleting a line, not by adding " +
      "a suspicious flag.\n\n" +
      `steps present: ${steps
        .map((step) =>
          step && typeof step === "object" && !Array.isArray(step)
            ? (step.name ?? step.uses ?? step.run ?? "<unnamed>")
            : String(step),
        )
        .map((label) => String(label).split("\n")[0].slice(0, 60))
        .join(" | ")}\n\n` +
      "If the gate's assertion legitimately moved or was renamed, update " +
      "`GATE_ASSERTION` in this guard in the SAME change.",
  );
}

// `fail: false` on lychee-action. The gate does not currently use lychee — its
// assertion is the Node script above, specifically so the required check does
// not depend on a third-party release asset being downloadable. This check
// stays because reintroducing a lychee step into the gate is a plausible
// future edit, and `fail: false` is the one-word way to disarm it.
//
// Read from the action's own `action.yml` rather than assumed: `fail` is
// declared `default: true, required: false`
// (lycheeverse/lychee-action action.yml, the `fail` input). An earlier draft of
// this comment claimed the default was FALSE and justified the check on that
// basis — wrong, and checked before shipping rather than after. The default
// being true is why OMITTING `fail` is safe, so the check demands only that it
// is not explicitly falsified; requiring the literal `true` would reject a
// correct workflow that simply relies on the documented default.
for (const [index, step] of steps.entries()) {
  if (
    step === null ||
    typeof step !== "object" ||
    Array.isArray(step) ||
    typeof step.uses !== "string" ||
    !step.uses.startsWith("lycheeverse/lychee-action")
  ) {
    continue;
  }
  const withBlock =
    step.with !== null && typeof step.with === "object" && !Array.isArray(step.with)
      ? step.with
      : {};
  // GitHub Actions inputs are strings, so a workflow may write `fail: false`
  // (parsed as a boolean by `yaml`) or `fail: "false"`. Both disarm the step.
  const failInput = withBlock.fail;
  const disarmed = failInput === false || failInput === "false";
  if (disarmed) {
    fail(
      `verify.yml's \`${GATE_JOB_ID}:\` job runs ${step.uses} at step ` +
        `${index + 1} with \`fail: ${JSON.stringify(failInput)}\`.\n\n` +
        "`fail` is lychee-action's switch between reporting findings and " +
        "failing the job (its `action.yml` declares `default: true`). With " +
        "it explicitly off, broken links are printed and " +
        `\`${GATE_JOB_ID}\` still reports SUCCESS: the required check on ` +
        "`main` becomes decorative with its context name unchanged.\n\n" +
        "Remove the override (the default fails the job), or move the step " +
        "to a job that is not required.",
    );
  }
}

console.log(
  `✓ \`${GATE_JOB_ID}:\`'s ${steps.length} step(s) carry no \`if:\`, no ` +
    "`continue-on-error`, and no lychee step disables `fail`, and the job " +
    `still runs \`${GATE_ASSERTION}\`, so the gate can still report red`,
);

console.log(
  `✓ verify.yml still declares \`${GATE_JOB_ID}:\` with no job-level ` +
    "`name:`, no `continue-on-error`, no job-level `if:` and no matrix, so it " +
    `reports exactly the context \`${GATE_JOB_ID}\``,
);

// ---------------------------------------------------------------------------
// Live half: does protection still require that context?
// ---------------------------------------------------------------------------

const headers = { Accept: "application/vnd.github+json" };
// OPTIONAL on purpose: with no token this still works locally, it just spends
// the 60/hr-per-source-IP unauthenticated quota instead of 5000/hr.
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

/** Exits non-zero because a check could not be PERFORMED. Distinct from drift. */
function unverified(message) {
  console.error(
    `✗ required-context drift check COULD NOT VERIFY\n\n${message}\n\n` +
      "  This is not a clean result. The local assertions above passed, but " +
      "whether live protection still requires a context this workflow " +
      `reports is UNKNOWN, so \`${GATE_JOB_ID}\` may already be wedged.`,
  );
  process.exit(1);
}

/**
 * GETs a path. Returns the parsed body on 200, and on failure classifies WHY,
 * because "wait or add a token", "this credential may not read this" and
 * "the resource is gone" need three different responses.
 *
 * 5xx and 429 are retried; a 403/404 is an answer rather than a blip. A 403 is
 * split by `x-ratelimit-remaining`: GitHub answers 403 BOTH for "forbidden" and
 * for "secondary rate limit", and on a shared runner NAT pool the latter can
 * happen having made no call of our own.
 */
async function get(path, attempts = 3) {
  let last = { kind: "unknown", detail: "unknown error" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, { headers });
    } catch (error) {
      last = { kind: "network", detail: `network error: ${error?.message ?? error}` };
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      break;
    }

    if (res.ok) return { ok: true, body: await res.json() };

    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    const detail =
      `HTTP ${res.status} ${res.statusText}` +
      (remaining === null ? "" : ` (x-ratelimit-remaining: ${remaining})`);

    // Rate limited: 403 or 429 with the budget actually exhausted.
    if ((res.status === 403 || res.status === 429) && remaining === "0") {
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
      last = {
        kind: "ratelimit",
        detail:
          `${detail}; quota resets at ${when}. ` +
          (process.env.GITHUB_TOKEN
            ? "A token WAS supplied, so this is the authenticated quota."
            : "No token was supplied, so this is the 60/hr-per-source-IP " +
              "unauthenticated quota, shared across GitHub-hosted runners."),
      };
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, attempt * 5000));
        continue;
      }
      break;
    }

    if (res.status === 403 || res.status === 401) {
      return { ok: false, kind: "forbidden", status: res.status, detail };
    }
    if (res.status === 404) {
      return { ok: false, kind: "missing", status: res.status, detail };
    }

    last = { kind: "http", detail };
    if (res.status < 500) return { ok: false, ...last, status: res.status };
    if (attempt === attempts) break;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return { ok: false, ...last };
}

// `GET /branches/{branch}` needs only repository read and embeds the required
// contexts. See the header for the three-repo verification of that claim.
const branch = await get(`/repos/${REPO}/branches/${BRANCH}`);

if (!branch.ok) {
  if (branch.kind === "ratelimit") {
    // The ONLY tolerated outcome: nothing is known about drift, but the cause
    // is unrelated to this repository's configuration and retrying fixes it.
    console.warn(
      `⚠ rate limited reading ${REPO}@${BRANCH} (${branch.detail}).\n` +
        "  The live half did NOT run. This is a shared-IP quota problem, not " +
        "a drift signal and not a permissions problem, so it does not fail " +
        "the job — but this run has NOT confirmed the live pairing.",
    );
    process.exit(0);
  }
  if (branch.kind === "missing") {
    unverified(
      `\`${BRANCH}\` does not exist in ${REPO} (${branch.detail}).\n\n` +
        "  A 404 here is NOT a permissions problem — the read itself " +
        "succeeded and reported no such branch. Either the default branch " +
        "was renamed (in which case protection and this guard both need " +
        "updating) or `GITHUB_REPOSITORY` is wrong.",
    );
  }
  if (branch.kind === "forbidden") {
    unverified(
      `not permitted to read ${REPO}@${BRANCH} (${branch.detail}).\n\n` +
        "  The rate-limit budget was NOT exhausted, so this is a real " +
        "permissions refusal rather than throttling. `GET /repos/{o}/{r}/" +
        "branches/{branch}` needs only repository read, so a refusal here " +
        "means the token is scoped below `contents: read` or the repository " +
        "is inaccessible to it.",
    );
  }
  unverified(`could not read ${REPO}@${BRANCH}: ${branch.detail}`);
}

// Rulesets are the other way to express the same requirement, and they report
// nothing under `protection`. Consulted so this keeps working after a
// migration. A failure here is only fatal if classic protection ALSO came back
// empty — otherwise the classic read already answered the question.
const rules = await get(`/repos/${REPO}/rules/branches/${BRANCH}`);

const classicContexts =
  branch.body?.protection?.required_status_checks?.contexts ?? [];
const rulesetContexts = Array.isArray(rules.body)
  ? rules.body
      .filter((rule) => rule?.type === "required_status_checks")
      .flatMap((rule) => rule?.parameters?.required_status_checks ?? [])
      .map((check) => check?.context)
      .filter((context) => typeof context === "string")
  : [];

const required = [...new Set([...classicContexts, ...rulesetContexts])];

if (required.length === 0) {
  if (!rules.ok) {
    unverified(
      `classic protection on ${REPO}@${BRANCH} requires no status checks, and ` +
        `the ruleset read failed (${rules.detail}), so the branch may be ` +
        "governed by a ruleset this run could not see.",
    );
  }
  // Both reads succeeded and both are empty. That is not an unverifiable
  // claim — it is a verified, and very bad, answer.
  fail(
    `\`${BRANCH}\` protection requires NO status checks, so nothing gates the ` +
      "branch and any commit can merge.\n\n" +
      `  Expected it to require \`${GATE_JOB_ID}\`. Both protection models were ` +
      `read successfully: classic \`protection.required_status_checks.contexts\` ` +
      `is [] and the ruleset list contributed no required check ` +
      `(protected: ${JSON.stringify(branch.body?.protected ?? null)}).\n\n` +
      "  This is what \"someone deleted branch protection\" looks like. " +
      "Restore it:\n\n" +
      `  gh api -X PUT repos/${REPO}/branches/${BRANCH}/protection \\\n` +
      `    -F 'required_status_checks[strict]=true' \\\n` +
      `    -f 'required_status_checks[contexts][]=${GATE_JOB_ID}' \\\n` +
      "    -F 'enforce_admins=true' -F 'required_pull_request_reviews=null' \\\n" +
      "    -F 'restrictions=null'",
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

const source =
  classicContexts.length > 0 && rulesetContexts.length > 0
    ? "classic protection + ruleset"
    : rulesetContexts.length > 0
      ? "ruleset"
      : "classic protection";

console.log(
  `✓ live protection on ${REPO}@${BRANCH} requires [${required.join(", ")}] ` +
    `(read from ${source}), every one of which a job in verify.yml reports`,
);
