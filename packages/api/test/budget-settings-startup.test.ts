import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";

/**
 * HV-024-13: the API reads every budget line at startup, as plain dollars. HV-024-10 said a nonsense
 * value fails there, but nothing tested the server's own read, and the monthly cap was read with
 * `Number()`: "abc" became NaN, no comparison refused it, and a $1,000,000 music line started.
 */
const KEYS = ["HV_TOKEN_SECRET", "HV_MONTHLY_BUDGET_USD", "HV_FILM_SPEND_CAP_USD", "HV_VOICE_VENDOR_CAP_USD", "HV_MUSIC_VENDOR_CAP_USD", "HV_MUSIC_PROVIDER", "HV_STORAGE", "HV_ARTIFACT_STORAGE"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const root = mkdtempSync(join(tmpdir(), "hv-budget-startup-"));
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};

function environment(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {HV_TOKEN_SECRET: "budget-startup-fixture-secret-at-least-thirty-two"}, values);
}
const start = () => createApiServer({port: 0, hostname: "127.0.0.1", ...paths});

afterEach(() => {for (const key of KEYS) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];});
afterAll(() => rmSync(root, {recursive: true, force: true}));

describe("the API's budget settings at startup", () => {
  /** A monthly cap that is not plain dollars above zero stops the API, naming the setting. */
  test("a monthly cap that is not plain dollars stops the API at startup", () => {
    for (const raw of ["abc", "0x10", "1e3", " 500", "", "0", "-500", "Infinity"]) {
      environment({HV_MONTHLY_BUDGET_USD: raw});
      expect(start).toThrow("Set HV_MONTHLY_BUDGET_USD to a plain dollar amount above zero");
    }
  });

  /** The review's case, through the server: a $1,000,000 music line under a monthly cap of "abc". */
  test("a million-dollar music line under a monthly cap of abc does not start", () => {
    environment({HV_MONTHLY_BUDGET_USD: "abc", HV_MUSIC_VENDOR_CAP_USD: "1000000"});
    expect(start).toThrow("HV_MONTHLY_BUDGET_USD");
  });

  /** Each line under the monthly cap is read as plain dollars by the server too. */
  test("a film, voice or music line in hex, exponent or padded form stops the API at startup", () => {
    for (const key of ["HV_FILM_SPEND_CAP_USD", "HV_VOICE_VENDOR_CAP_USD", "HV_MUSIC_VENDOR_CAP_USD"] as const) {
      for (const raw of ["0x10", "1e1", " 5 "]) {
        environment({HV_MONTHLY_BUDGET_USD: "500", [key]: raw});
        expect(start).toThrow("Set " + key + " to a plain dollar amount");
      }
      environment({HV_MONTHLY_BUDGET_USD: "500", [key]: "501"});
      expect(start).toThrow("Set " + key + " between 0 and the monthly cap.");
    }
  });

  /** The documented values still start: an unset monthly cap ($5,000) and the staging host's $500. */
  test("the documented values still start the API", async () => {
    for (const values of [{}, {HV_MONTHLY_BUDGET_USD: "500"}, {HV_MONTHLY_BUDGET_USD: "500", HV_FILM_SPEND_CAP_USD: "40", HV_VOICE_VENDOR_CAP_USD: "25", HV_MUSIC_VENDOR_CAP_USD: "10"}]) {
      environment(values);
      const server = start();
      await server.stop(true);
    }
  });
});
