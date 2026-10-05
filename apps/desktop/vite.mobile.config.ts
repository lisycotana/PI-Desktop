import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "out/mobile",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: resolve(import.meta.dirname, "mobile.html") },
  },
  resolve: { alias: [
    {find:/^@pi-desktop\/i18n\/locales\/([^/]+)$/,replacement:resolve(import.meta.dirname,"../../packages/i18n/src/locales/$1/index.ts")},
    {find:"@pi-desktop/i18n/locale-info",replacement:resolve(import.meta.dirname,"../../packages/i18n/src/locale-info.ts")},
    {find:"@pi-desktop/i18n",replacement:resolve(import.meta.dirname,"../../packages/i18n/src/index.ts")},
  ] },
});
