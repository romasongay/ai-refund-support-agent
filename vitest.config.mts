import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Vite (via Vitest 4) resolves the tsconfig "@/*" paths natively — no plugin needed.
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["tests/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"],
  },
});
