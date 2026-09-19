import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPERVISOR_CONFIG_ENV, ZO_SUPERVISOR_CONFIG, supervisorConfig } from "../../../scripts/host-config";

const scripts = join(import.meta.dir, "../../../scripts");

// HV-032-03: the evidence collectors ask the supervisor the deploy scripts registered
// programs with. The two halves must name the same file, or evidence would be read from
// a supervisor the studio does not run under.
describe("host supervisor configuration", () => {
  test("unset keeps Zo, so the current host is unchanged", () => {
    expect(supervisorConfig({})).toBe("/etc/zo/supervisord-user.conf");
  });

  test("the default and the variable are the Python module's", () => {
    const python = readFileSync(join(scripts, "host_config.py"), "utf8");
    expect(python).toContain(`ZO_SUPERVISOR_CONFIG = "${ZO_SUPERVISOR_CONFIG}"`);
    expect(python).toContain(`CONFIG_ENV = "${SUPERVISOR_CONFIG_ENV}"`);
  });

  test("a host names its own supervisor", () => {
    expect(supervisorConfig({HV_SUPERVISOR_CONFIG: "/etc/rough-cut/supervisord.conf"})).toBe("/etc/rough-cut/supervisord.conf");
  });

  test("refuses a path that depends on the working directory, as the Python module does", () => {
    for (const value of ["", "supervisord.conf", "./supervisord.conf", " /etc/x.conf", "/etc/x.conf\n"])
      expect(() => supervisorConfig({HV_SUPERVISOR_CONFIG: value})).toThrow("absolute path");
  });

  test("the collector reads the setting rather than naming a path", async () => {
    const source = readFileSync(join(scripts, "storage-wave-a-evidence.ts"), "utf8");
    expect(source).toContain("export const SUPERVISOR_CONFIG = supervisorConfig();");
    const previous = process.env.HV_SUPERVISOR_CONFIG;
    process.env.HV_SUPERVISOR_CONFIG = "/etc/rough-cut/supervisord.conf";
    try {
      const fresh = await import(join(scripts, "storage-wave-a-evidence.ts") + "?host-config-test");
      expect(fresh.SUPERVISOR_CONFIG).toBe("/etc/rough-cut/supervisord.conf");
    } finally {
      if (previous === undefined) delete process.env.HV_SUPERVISOR_CONFIG; else process.env.HV_SUPERVISOR_CONFIG = previous;
    }
  });

  test("no collector or script names the Zo supervisor itself", () => {
    const { readdirSync } = require("node:fs");
    const offenders = (readdirSync(scripts) as string[])
      .filter(name => /\.(ts|py)$/.test(name) && !name.startsWith("test_") && name !== "host_config.py" && name !== "host-config.ts")
      .filter(name => /\/etc\/zo|29011/.test(readFileSync(join(scripts, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
