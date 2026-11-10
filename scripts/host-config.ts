// The TypeScript half of scripts/host_config.py: where the staging host keeps the
// supervisor the evidence collectors read. HV_SUPERVISOR_CONFIG is required: Zo, whose
// file used to be the default, is gone (HV-032-09), so unset is refused by name.
// packages/storage/test/host-config.test.ts holds the refusals equal to the Python module's.
import { isAbsolute } from "node:path";

export const SUPERVISOR_CONFIG_ENV = "HV_SUPERVISOR_CONFIG";

export function supervisorConfig(env: Record<string, string | undefined> = process.env): string {
  const value = env[SUPERVISOR_CONFIG_ENV];
  if (value === undefined)
    throw new Error(`${SUPERVISOR_CONFIG_ENV} is not set: source /etc/rough-cut/host.env, or name the host's supervisord.conf`);
  if (!value || !isAbsolute(value) || value !== value.trim())
    throw new Error(`${SUPERVISOR_CONFIG_ENV} must be an absolute path, got ${JSON.stringify(value)}`);
  return value;
}
