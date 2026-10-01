/**
 * A throwaway C2PA signing identity, made fresh by each test run with openssl: a P-256 root CA, a
 * leaf with the C2PA documentSigning EKU signed by it, and a second leaf with no EKU at all. Nothing
 * here is a real key, and nothing is kept: the directory is the caller's temporary directory.
 *
 * The leaf key is written in SEC1 form (`EC PRIVATE KEY`), which is what `openssl ecparam -genkey`
 * produces and c2pa-node refuses, so every signed test also exercises the in-memory conversion.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface C2paTestIdentity {
  dir: string;
  /** SEC1 leaf key. */ keyPath: string;
  /** Leaf (documentSigning EKU) then root, PEM. */ chainPath: string;
  /** Leaf with no EKU then root, PEM, for the same key. */ noEkuChainPath: string;
  /** The root alone, as a user trust anchor. */ anchorPem: string;
}

function openssl(dir: string, ...args: string[]): void {
  const run = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error("openssl " + args[0] + " failed: " + run.stderr.toString().slice(-300));
}

export function makeC2paTestIdentity(dir: string): C2paTestIdentity {
  if (!Bun.which("openssl")) throw new Error("These tests generate a throwaway certificate with openssl, which is not on PATH.");
  mkdirSync(dir, { recursive: true });
  openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
  openssl(dir, "req", "-x509", "-new", "-key", "ca.key", "-days", "2", "-subj", "/CN=Rough Cut test root/O=Rough Cut test",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem");
  openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key");
  openssl(dir, "req", "-new", "-key", "leaf.key", "-subj", "/CN=Rough Cut test signer/O=Rough Cut test", "-out", "leaf.csr");
  writeFileSync(join(dir, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=1.3.6.1.5.5.7.3.36\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n");
  writeFileSync(join(dir, "noeku.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
  openssl(dir, "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "leaf.ext", "-out", "leaf.pem");
  openssl(dir, "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "noeku.ext", "-out", "noeku.pem");
  const anchorPem = readFileSync(join(dir, "ca.pem"), "utf8");
  writeFileSync(join(dir, "chain.pem"), readFileSync(join(dir, "leaf.pem"), "utf8") + anchorPem);
  writeFileSync(join(dir, "noeku-chain.pem"), readFileSync(join(dir, "noeku.pem"), "utf8") + anchorPem);
  return { dir, keyPath: join(dir, "leaf.key"), chainPath: join(dir, "chain.pem"), noEkuChainPath: join(dir, "noeku-chain.pem"), anchorPem };
}

/** Run `fn` with the two signing variables set to `values` (undefined deletes), restoring them after. */
export async function withC2paEnv<T>(values: { key?: string; cert?: string }, fn: () => Promise<T> | T): Promise<T> {
  const saved = { key: process.env.HV_C2PA_SIGNING_KEY, cert: process.env.HV_C2PA_SIGNING_CERT };
  const set = (name: string, value: string | undefined) => {if (value === undefined) delete process.env[name]; else process.env[name] = value;};
  set("HV_C2PA_SIGNING_KEY", values.key);set("HV_C2PA_SIGNING_CERT", values.cert);
  try {return await fn();} finally {set("HV_C2PA_SIGNING_KEY", saved.key);set("HV_C2PA_SIGNING_CERT", saved.cert);}
}
