import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// `cloudflare:workers` exists only inside the Cloudflare runtime. The catch-all
// route imports it lazily, so every build step has to leave it alone. Alchemy
// injects its own Cloudflare plugin, so none is added here.
const config = defineConfig({
  build: {
    rolldownOptions: {
      external: ["cloudflare:workers"],
    },
  },
  resolve: { tsconfigPaths: true },
  optimizeDeps: {
    exclude: ["cloudflare:workers"],
  },
  ssr: {
    external: ["cloudflare:workers"],
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})

export default config
