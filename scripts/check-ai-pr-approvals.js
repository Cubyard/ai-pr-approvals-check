// Required status check: PRs opened by a bot or GitHub App need two human approvals.
// PRs opened by a person are unaffected and pass immediately.
//
// Runs two ways:
//   1. Inside GitHub Actions via actions/github-script (see .github/workflows/ai-pr-approvals.yml)
//   2. Locally for verification:  node scripts/check-ai-pr-approvals.js <owner> <repo> <pr-number>
//      (uses `gh api` for auth so no token handling is needed)

const REQUIRED_HUMAN_APPROVALS = 2;

function isBotAuthor(user) {
  return user.type === "Bot" || user.login.startsWith("app/") || user.login.endsWith("[bot]");
}

// Latest review per human user wins; dismissed or superseded approvals do not count.
function countHumanApprovals(reviews) {
  const latestByUser = new Map();
  for (const r of reviews) {
    if (!r.user || r.user.type !== "User") continue;
    if (r.state === "COMMENTED") continue; // comments never change approval state
    latestByUser.set(r.user.login, r.state);
  }
  const approvers = [...latestByUser].filter(([, s]) => s === "APPROVED").map(([u]) => u);
  return approvers;
}

function evaluate(pr, reviews) {
  if (!isBotAuthor(pr.user)) {
    return { pass: true, reason: `Author ${pr.user.login} is a person. Standard review rules apply.` };
  }
  const approvers = countHumanApprovals(reviews);
  const pass = approvers.length >= REQUIRED_HUMAN_APPROVALS;
  return {
    pass,
    reason: `Author ${pr.user.login} is a bot. ${approvers.length} of ${REQUIRED_HUMAN_APPROVALS} required human approvals` +
      (approvers.length ? ` (${approvers.join(", ")})` : "") + ".",
  };
}

module.exports = { evaluate, isBotAuthor, countHumanApprovals, REQUIRED_HUMAN_APPROVALS };

// Local verification entry point
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
