// Required check: pull requests opened by Claude need two human approvals on the current head commit.
// Pull requests opened by a person pass immediately.
//
// Runs two ways:
//   1. Inside GitHub Actions via actions/github-script (see .github/workflows/ai-pr-approvals.yml)
//   2. Locally for verification:  node scripts/check-ai-pr-approvals.js <owner> <repo> <pr-number>
//      (uses `gh api` for auth so no token handling is needed)

const REQUIRED_HUMAN_APPROVALS = 2;

// Only these authors are gated. Dependabot, Renovate, and other bots keep the repo's normal rules.
// REST returns the GitHub App as "claude[bot]"; GraphQL and `gh` render the same account as "app/claude".
const GATED_AUTHOR_LOGINS = new Set(
  (process.env.GATED_AUTHORS || "claude[bot],app/claude").split(",").map((s) => s.trim()).filter(Boolean)
);

// Accounts that are type "User" but are not people.
const NON_HUMAN_LOGINS = new Set(["claude"]);

// Only people with access to the repo can approve. On a public repo anyone can submit a review.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isGatedAuthor(user) {
  return Boolean(user) && GATED_AUTHOR_LOGINS.has(user.login);
}

// One vote per person, latest review wins, and only approvals given on the commit being merged count.
// A new push therefore resets the count, regardless of the repo's dismiss-stale setting.
function countHumanApprovals(reviews, headSha) {
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
    .map((r) => r.user.login);
}

function evaluate(pr, reviews) {
  if (!isGatedAuthor(pr.user)) {
    return { pass: true, reason: `Author ${pr.user.login} is not a gated bot. Standard review rules apply.` };
  }
  const approvers = countHumanApprovals(reviews, pr.head.sha);
  const pass = approvers.length >= REQUIRED_HUMAN_APPROVALS;
  return {
    pass,
    reason: `Author ${pr.user.login} is a bot. ${approvers.length} of ${REQUIRED_HUMAN_APPROVALS} required human approvals on ${pr.head.sha.slice(0, 7)}` +
      (approvers.length ? ` (${approvers.join(", ")})` : "") + ".",
  };
}

module.exports = { evaluate, isGatedAuthor, countHumanApprovals, REQUIRED_HUMAN_APPROVALS };

if (require.main === module) {
  const { execFileSync } = require("child_process");
  const [owner, repo, num] = process.argv.slice(2);
  if (!num) { console.error("usage: node check-ai-pr-approvals.js <owner> <repo> <pr>"); process.exit(2); }
  const api = (p) => JSON.parse(execFileSync("gh", ["api", "--paginate", p], { encoding: "utf8" }));
  const pr = api(`repos/${owner}/${repo}/pulls/${num}`);
  const reviews = api(`repos/${owner}/${repo}/pulls/${num}/reviews`);
  const result = evaluate(pr, reviews);
  console.log(`${owner}/${repo}#${num}: ${result.pass ? "PASS" : "FAIL"} - ${result.reason}`);
  process.exit(result.pass ? 0 : 1);
}
