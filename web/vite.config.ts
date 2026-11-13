import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: "/poe1-campaign-helper/",
  server: {
    host: true,
  },
  plugins: [
    react(),
    // The desktop overlay (`--mode overlay`) loads files locally, so it gets
    // no service worker: one would only cache stale builds inside Electron.
    mode !== "overlay" &&
      VitePWA({
        registerType: "autoUpdate",
        manifest: {
          name: "Exile Leveling",
          short_name: "Exile Leveling",
          description:
            "Exile Leveling is a Path of Exile leveling guide with Path of Building integration",
          theme_color: "#000000",
          background_color: "#000000",
          icons: [
            {
              src: "android-chrome-192x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any maskable",
            },
            {
              src: "android-chrome-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
      }),
  ],
}));
