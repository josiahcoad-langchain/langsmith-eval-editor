import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two builds of one UI:
//   --mode web   a normal web app (index.html -> src/web.tsx) served by the eval server, which also proxies the
//                LangSmith API. `npm run dev:web` serves it with hot reload and proxies /api to the server.
//   (default)    the custom-app bundle: one dependency-free CJS file exporting render(data, root, metadata),
//                which LangSmith's sandbox evaluates. This is what `langsmith apps dev` / `push` use.
export default defineConfig(({ mode }) =>
  mode === 'web'
    ? {
        plugins: [react()],
        resolve: { dedupe: ['react', 'react-dom'] },
        build: { outDir: 'dist-web', emptyOutDir: true },
        server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8765' } },
      }
    : {
        plugins: [react()],
        resolve: { dedupe: ['react', 'react-dom'] },
        // Library mode doesn't replace process.env.NODE_ENV, and the sandbox has no `process` global.
        define: { 'process.env.NODE_ENV': '"production"' },
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          lib: { entry: 'src/entry.tsx', formats: ['cjs'], fileName: () => 'bundle.js' },
        },
      },
);
