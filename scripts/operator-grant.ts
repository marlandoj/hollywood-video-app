import { mintOperatorGrant, operatorGrantSecret } from "../packages/api/src/tokens";

const [projectId, hoursArgument] = process.argv.slice(2);

if (!projectId) {
  console.error("usage: bun scripts/operator-grant.ts <projectId> [hours]");
  console.error("mints the elevated-capacity grant an operator hands to one project (FR-030)");
  process.exit(2);
}

if (!operatorGrantSecret()) {
  console.error("HV_OPERATOR_GRANT_SECRET must be set to at least 32 characters before minting a grant");
  process.exit(1);
}

const hours = Number(hoursArgument ?? 24);
if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
  console.error("hours must be a positive number no greater than 720");
  process.exit(2);
}

const grant = mintOperatorGrant(projectId, hours * 3600 * 1000);
console.log(JSON.stringify({
  projectId,
  tier: "elevated",
  expiresInHours: hours,
  grant,
  usage: 'POST /api/projects/<projectId>/jobs with {"operatorGrant":"<grant>"}',
}, null, 2));
