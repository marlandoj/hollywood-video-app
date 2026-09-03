import { describe, expect, test } from "bun:test";

const html = await Bun.file(`${import.meta.dir}/../src/index.html`).text();

describe("the bearer token can only travel to the page's own origin", () => {
  test("the API base is not overridable from the URL or a global", () => {
    expect(html).not.toContain('params.get("api")');
    expect(html).not.toContain("HV_API_BASE");
    expect(html).toContain("location.origin");
  });

  test("the build-time meta tag is the only other source, and ships empty", () => {
    expect(html).toContain('<meta name="hv-api-base" content="" />');
  });
});
