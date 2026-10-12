#!/usr/bin/env node
//
// THE MERGE GATE'S ASSERTION. Resolves every relative link in this repository's
// tracked markdown and fails if one does not exist.
//
// WHY THIS EXISTS RATHER THAN A lychee STEP
//
// This is the sole required status check on `main`, which has
// `enforce_admins: true` and no bypass actor. A required gate that cannot pass
// is a branch nobody can merge to, so the gate's governing constraint is that
// it must only be able to fail for a reason that is THIS REPOSITORY'S FAULT.
//
// `lychee --offline` satisfied that for link TARGETS — no third-party host is
// contacted — but not for the gate's own SUPPLY CHAIN. `lycheeverse/lychee-action`
// downloads the lychee binary from a GitHub release asset on every run:
//
//     DOWNLOAD_URL="https://github.com/lycheeverse/lychee/releases/download/..."
//     curl -sfLO "${DOWNLOAD_URL}"
//
// (read from the action's own `action.yml` at the pinned SHA, not assumed).
// A `lycheeverse` release-asset outage or a GitHub release-CDN incident
// therefore reddened the only context standing between any commit and `main` —
// the precise deadlock the split was written to remove, relocated from the link
// targets to the toolchain. `curl -sf` has no retry and the step has no
// fallback, so that failure mode was a hard wedge.
//
// This repository's markdown contains ONE relative link. Asserting that it
// resolves does not need a 7MB binary fetched over the network at gate time.
// The whole check is the Node runtime already present on the runner plus
// `git ls-files`, so after `actions/checkout` the gate makes NO network request
// at all and has nothing left that can fail for someone else's reason.
//
// WHY `git ls-files` AND NOT A GLOB
//
// The inputs are the files git TRACKS. That is strictly narrower than a
// filesystem glob and it is the reason this cannot repeat the failure of this
// workflow's first real run, where `./**/*.md` reached into `node_modules` and
// failed the job on a dependency's own broken links. An untracked file cannot
// enter the input set, so `node_modules` is unreachable by construction rather
// than by a `.gitignore` the glob was free to ignore (and did).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const REPO_ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();

/** Exits non-zero with an explanation. */
function fail(message) {
  console.error(`\n✗ local link check FAILED\n\n${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inputs: tracked markdown only.
// ---------------------------------------------------------------------------

let tracked;
try {
  tracked = execFileSync("git", ["ls-files", "-z", "*.md", "**/*.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((p) => p.length > 0);
} catch (error) {
  // Fail CLOSED. If the file list cannot be produced the assertions below did
  // not run, which is unverified rather than clean.
  fail(
    `could not list tracked markdown via \`git ls-files\` in ${REPO_ROOT}: ` +
      `${error?.message ?? error}\n\n` +
      "The gate's input set is unknown, so no link was checked. That is " +
      "unverified, not passing.",
  );
}

if (tracked.length === 0) {
  // The empty-input case is the one that turns a gate decorative without any
  // edit to the gate itself: zero inputs means zero findings means green.
  fail(
    "no tracked markdown files found, so this gate checked nothing and would " +
      "have reported green. A required check with an empty input set is " +
      "decorative. If the repository genuinely has no markdown, this guard " +
      "needs replacing rather than passing.",
  );
}

// ---------------------------------------------------------------------------
// Link extraction.
// ---------------------------------------------------------------------------

// Inline links/images `[text](target)` and `![alt](target)`, plus reference
// definitions `[label]: target`. Angle-bracket targets `[t](<a b>)` and an
// optional title `[t](a "Title")` are both handled.
const INLINE = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFDEF = /^[ \t]{0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*(<[^>]*>|\S+)/gm;

// Fenced code blocks are not prose and a "link" inside one is a code sample.
function stripFences(text) {
  return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

function targetsIn(text) {
  const body = stripFences(text);
  const found = [];
  for (const re of [INLINE, REFDEF]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(body)) !== null) {
      let target = match[1];
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      const line = body.slice(0, match.index).split("\n").length;
      found.push({ target: target.trim(), line });
    }
  }
  return found;
}

// A target this gate deliberately does not resolve: anything that leaves the
// repository. Checking those is the ROT DETECTOR's job and it is not required,
// precisely because it needs the network.
function isExternal(target) {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || // http:, https:, mailto:, tel:, …
    target.startsWith("//") || // protocol-relative
    target.startsWith("{{") || // template placeholder
    target.startsWith("#{")
  );
}

// GitHub's heading-anchor slug: lowercase, drop anything that is not a word
// character, space or hyphen, then spaces to hyphens.
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(text) {
  const anchors = new Set();
  const body = stripFences(text);
  for (const match of body.matchAll(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    // Strip inline markup so `## [eval-lab](url) notes` slugs as GitHub does.
    const plain = match[2]
      .replace(/!?\[((?:[^\]\\]|\\.)*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "");
    anchors.add(slugify(plain));
  }
  for (const match of body.matchAll(/<a\s+[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    anchors.add(match[1]);
  }
  return anchors;
}

const anchorCache = new Map();
function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) {
    anchorCache.set(absPath, anchorsOf(readFileSync(absPath, "utf8")));
  }
  return anchorCache.get(absPath);
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

const problems = [];
let checked = 0;
let externalSkipped = 0;

for (const file of tracked) {
  const absFile = resolve(REPO_ROOT, file);
  const text = readFileSync(absFile, "utf8");

  for (const { target, line } of targetsIn(text)) {
    if (target.length === 0) continue;
    if (isExternal(target)) {
      externalSkipped++;
      continue;
    }

    const hashAt = target.indexOf("#");
    const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
    const fragment = hashAt === -1 ? "" : decodeURIComponent(target.slice(hashAt + 1));

    // Same-file anchor: `[x](#section)`.
    if (pathPart === "") {
      checked++;
      if (fragment !== "" && !anchorsOf(text).has(fragment.toLowerCase())) {
        problems.push(
          `${file}:${line}  in-file anchor \`#${fragment}\` has no matching heading in this file`,
        );
      }
      continue;
    }

    const decoded = decodeURIComponent(pathPart);
    const absTarget = decoded.startsWith("/")
      ? join(REPO_ROOT, decoded) // root-relative: repo root, not filesystem root
      : resolve(dirname(absFile), decoded);

    // A link must not escape the repository: it would resolve on a checkout and
    // 404 on github.com, which is the same defect in a less obvious costume.
    const rel = relative(REPO_ROOT, absTarget);
    if (rel.startsWith("..") || normalize(rel) === "..") {
      checked++;
      problems.push(
        `${file}:${line}  \`${target}\` resolves OUTSIDE the repository (${rel}), ` +
          "so it cannot work on github.com",
      );
      continue;
    }

    checked++;
    if (!existsSync(absTarget)) {
      problems.push(`${file}:${line}  \`${target}\` does not exist (looked for ${rel})`);
      continue;
    }

    if (fragment !== "" && statSync(absTarget).isFile() && /\.(md|markdown)$/i.test(absTarget)) {
      if (!anchorsFor(absTarget).has(fragment.toLowerCase())) {
        problems.push(
          `${file}:${line}  \`${target}\` — the file exists but has no heading anchoring \`#${fragment}\``,
        );
      }
    }
  }
}

if (problems.length > 0) {
  fail(
    `${problems.length} broken local link(s) in ${tracked.length} tracked ` +
      `markdown file(s):\n\n  ${problems.join("\n  ")}\n\n` +
      "These are links this repository owns and can fix: a relative path that " +
      "does not resolve, or an anchor with no matching heading. Nothing " +
      "external was contacted.",
  );
}

// An input set with no checkable link at all is the latent trip hazard worth
// naming: it is not a failure, but it means this gate asserted nothing about
// link integrity on this commit, so say so rather than printing a clean tick.
if (checked === 0) {
  console.log(
    `⚠ ${tracked.length} tracked markdown file(s) contain no local link to check ` +
      `(${externalSkipped} external target(s) skipped — those are the rot ` +
      "detector's job). This gate asserted nothing about link integrity on " +
      "this commit.",
  );
} else {
  console.log(
    `✓ ${checked} local link(s)/anchor(s) across ${tracked.length} tracked ` +
      `markdown file(s) all resolve (${externalSkipped} external target(s) ` +
      "left to the rot detector). No network request was made.",
  );
}
