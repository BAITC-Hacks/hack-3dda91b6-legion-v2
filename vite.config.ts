import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, strictPort: true,
    // Runtime/test files can be locked by Python or an isolated test browser.
    watch: { ignored: ["**/artifacts/**", "**/.venv/**", "**/test-results/**", "**/playwright-report/**"] },
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  preview: { proxy: { "/api": "http://127.0.0.1:8000" } },
});
