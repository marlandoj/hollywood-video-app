import { readFileSync } from "node:fs";

/**
 * The provider settings a staging profile writes, read from the script that writes them
 * (scripts/staging-providers.py), so a profile change moves every test that reads one rather than
 * leaving it stale. A pool (HV-019-17) is returned as the JSON list the catalogue parses, spelled as the
 * script writes it.
 */
export function stagingProfile(name: string): Record<string, string> {
  const source = readFileSync(new URL("../../scripts/staging-providers.py", import.meta.url), "utf8");
  const constants = Object.fromEntries([...source.matchAll(/^(FAL_[A-Z_]+) = "([^"]+)"$/gm)].map(match => [match[1]!, match[2]!]));
  const line = source.split("\n").find(row => row.trim().startsWith(JSON.stringify(name) + ":"));
  if (!line) throw new Error("no staging profile " + name);
  const value = (token: string): string => {
    if (token.startsWith("\"")) return token.slice(1, -1);
    if (token.startsWith("[")) return JSON.stringify(token.slice(1, -1).split(",").map(item => value(item.trim())));
    const constant = constants[token];
    if (constant === undefined) throw new Error("unknown staging constant " + token);
    return constant;
  };
  return Object.fromEntries([...line.matchAll(/"(HV_[A-Z_]+)": (\[[^\]]*\]|[A-Z_]+|"[^"]*")/g)].map(match => [match[1]!, value(match[2]!)]));
}
