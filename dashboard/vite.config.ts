import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react";
          if (/node_modules\/(recharts|recharts-scale|d3-[^/]+)\//.test(id))
            return "charts";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
