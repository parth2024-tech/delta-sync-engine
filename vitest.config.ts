import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts", "shared/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
    env: {
      JWT_SECRET: "test-secret-at-least-32-chars-long-deltasync!!",
      STORAGE_DRIVER: "local",
      NODE_ENV: "test",
    },
  },
});
