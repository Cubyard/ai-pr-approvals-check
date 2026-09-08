// Required check: pull requests opened by Claude need two human approvals on the current head commit.
// Pull requests opened by a person pass immediately.
//
// Runs two ways:
//   1. Inside GitHub Actions via actions/github-script (see .github/workflows/ai-pr-approvals.yml)
//   2. Locally for verification:  node scripts/check-ai-pr-approvals.js <owner> <repo> <pr-number>
//      (uses `gh api` for auth so no token handling is needed)

const REQUIRED_HUMAN_APPROVALS = 2;

// Only these authors are gated. Dependabot, Renovate, and other bots keep the repo's normal rules.
// The list lives here, on the default branch, and nowhere else. The workflow file cannot widen or narrow it.
// REST returns the GitHub App as "claude[bot]"; GraphQL and `gh` render the same account as "app/claude".
const GATED_AUTHOR_LOGINS = new Set(["claude[bot]", "app/claude"]);

// Accounts that are type "User" but are not people.
const NON_HUMAN_LOGINS = new Set(["claude"]);

// author_association is a cheap first filter. MEMBER means "member of the org", not "has access to this repo",
// so the real test is the reviewer's repository permission (see countHumanApprovals).
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

// A pull request that edits the gate is judged by its own copy of the workflow file (GitHub runs
// pull_request workflows from the PR's merge ref). Fail closed on those and let a code owner review them.
const SELF_GATE_PATHS = [".github/workflows/ai-pr-approvals.yml", "scripts/check-ai-pr-approvals.js", ".github/CODEOWNERS"];

function isGatedAuthor(user) {
  return Boolean(user) && GATED_AUTHOR_LOGINS.has(user.login);
}

function touchesOwnGate(files) {
  return (files || []).map((f) => f.filename).filter((name) => SELF_GATE_PATHS.includes(name));
}

// One vote per person, latest review wins, and only approvals given on the commit being merged count.
// A new push therefore resets the count, regardless of the repo's dismiss-stale setting.
// `permissions` maps reviewer login to their repository permission. A reviewer with no entry does not count.
function countHumanApprovals(reviews, headSha, permissions) {
  const latestByUser = new Map();
  for (const r of [...reviews].sort((a, b) => a.id - b.id)) {
    if (!r.user || r.user.type !== "User") continue;
    if (NON_HUMAN_LOGINS.has(r.user.login.toLowerCase())) continue;
    if (!TRUSTED_ASSOCIATIONS.has(r.author_association)) continue;
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    latestByUser.set(r.user.login, r);
  }
  return [...latestByUser.values()]
    .filter((r) => r.state === "APPROVED" && r.commit_id === headSha)
    .filter((r) => permissions && WRITE_PERMISSIONS.has(permissions.get(r.user.login)))
    .map((r) => r.user.login);
}

// Logins whose repository permission the caller must look up before calling evaluate.
function candidateApprovers(reviews) {
  return [...new Set(reviews.filter((r) => r.user && r.user.type === "User" && r.state === "APPROVED").map((r) => r.user.login))];
}

function evaluate(pr, reviews, files, permissions) {
  if (!isGatedAuthor(pr.user)) {
    return { pass: true, reason: `Author ${pr.user.login} is not a gated bot. Standard review rules apply.` };
  }
  const gateEdits = touchesOwnGate(files);
  if (gateEdits.length) {
    return { pass: false, reason: `Author ${pr.user.login} is a bot and this pull request edits the approval check itself (${gateEdits.join(", ")}). A code owner must review it.` };
  }
  const approvers = countHumanApprovals(reviews, pr.head.sha, permissions);
  const pass = approvers.length >= REQUIRED_HUMAN_APPROVALS;
  return {
    pass,
    reason: `Author ${pr.user.login} is a bot. ${approvers.length} of ${REQUIRED_HUMAN_APPROVALS} required human approvals with write access on ${pr.head.sha.slice(0, 7)}` +
      (approvers.length ? ` (${approvers.join(", ")})` : "") + ".",
  };
}

module.exports = { evaluate, isGatedAuthor, countHumanApprovals, candidateApprovers, touchesOwnGate, REQUIRED_HUMAN_APPROVALS, SELF_GATE_PATHS };

if (require.main === module) {
  const { execFileSync } = require("child_process");
  const [owner, repo, num] = process.argv.slice(2);
  if (!num) { console.error("usage: node check-ai-pr-approvals.js <owner> <repo> <pr>"); process.exit(2); }
  const api = (p) => JSON.parse(execFileSync("gh", ["api", "--paginate", p], { encoding: "utf8" }));
  const pr = api(`repos/${owner}/${repo}/pulls/${num}`);
  const reviews = api(`repos/${owner}/${repo}/pulls/${num}/reviews`);
  const files = api(`repos/${owner}/${repo}/pulls/${num}/files`);
  const permissions = new Map();
  for (const login of candidateApprovers(reviews)) {
    try { permissions.set(login, api(`repos/${owner}/${repo}/collaborators/${login}/permission`).permission); } catch { /* no access: does not count */ }
  }
  const result = evaluate(pr, reviews, files, permissions);
  console.log(`${owner}/${repo}#${num}: ${result.pass ? "PASS" : "FAIL"} - ${result.reason}`);
  process.exit(result.pass ? 0 : 1);
}
