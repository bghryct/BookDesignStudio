import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `base: './'` makes the build path-independent, so the same `dist/` works at
// https://<user>.github.io/<repo>/, at a custom domain root, or opened from any sub-folder.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          pdf: ['pdf-lib'],
          fontkit: ['@pdf-lib/fontkit'],
        },
      },
    },
  },
  optimizeDeps: { include: ['@pdf-lib/fontkit', 'hyphen/en'] },
});
