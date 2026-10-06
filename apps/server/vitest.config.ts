import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@clinicvoice/source"] },
  ssr: { resolve: { conditions: ["@clinicvoice/source"] } },
  test: {
    include: ["test/**/*.test.ts"],
    // Integration files reseed one shared database; run files one at a time.
    fileParallelism: false,
  },
});
