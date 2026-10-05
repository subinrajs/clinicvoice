import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@clinicvoice/source"] },
  ssr: { resolve: { conditions: ["@clinicvoice/source"] } },
  test: { include: ["test/**/*.test.ts"] },
});
