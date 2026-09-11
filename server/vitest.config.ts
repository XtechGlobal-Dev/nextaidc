import { defineConfig } from "vitest/config";

export default defineConfig({
  // The source uses NodeNext ".js" import specifiers; strip them so Vitest
  // resolves to the real ".ts" files.
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
