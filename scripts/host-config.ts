// The TypeScript half of scripts/host_config.py: where the staging host keeps the
// supervisor the evidence collectors read. Unset, it is Zo's; a host that runs its own
// supervisor sets HV_SUPERVISOR_CONFIG. packages/storage/test/host-config.test.ts holds
// the default and the refusals equal to the Python module's.
import { isAbsolute } from "node:path";

export const SUPERVISOR_CONFIG_ENV = "HV_SUPERVISOR_CONFIG";
export const ZO_SUPERVISOR_CONFIG = "/etc/zo/supervisord-user.conf";

export function supervisorConfig(env: Record<string, string | undefined> = process.env): string {
  const value = env[SUPERVISOR_CONFIG_ENV];
  if (value === undefined) return ZO_SUPERVISOR_CONFIG;
  if (!value || !isAbsolute(value) || value !== value.trim())
    throw new Error(`${SUPERVISOR_CONFIG_ENV} must be an absolute path, got ${JSON.stringify(value)}`);
  return value;
}
