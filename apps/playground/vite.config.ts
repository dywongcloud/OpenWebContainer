import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // A host that boots this runtime provisions cross-origin isolation; the
  // coep value is fixed at first boot and cannot change on a later reboot.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  optimizeDeps: {
    exclude: ['quickjs-emscripten']
  },
  resolve: {
    alias: {
      // Add this if you need to resolve WASM files
      'quickjs-emscripten-module': 'quickjs-emscripten/dist/quickjs.wasm'
    }
  },
  assetsInclude: ['**/*.wasm']
})
