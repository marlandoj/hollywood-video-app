import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/storage/src/schema.ts",
  out: "./infra/drizzle",
  dbCredentials: { url: process.env.HV_PG_ADMIN_URL ?? "" },
  strict: true,
});
