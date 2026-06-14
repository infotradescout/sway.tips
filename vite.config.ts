import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const demoPublicDir: string | false =
    process.env.VITE_SWAY_DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production'
      ? path.resolve(__dirname, 'fixtures/demo')
      : false;

  return {
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
          public: path.resolve(__dirname, 'shells/public.html'),
          patron: path.resolve(__dirname, 'shells/patron.html'),
          talent: path.resolve(__dirname, 'shells/talent.html'),
          overlay: path.resolve(__dirname, 'shells/overlay.html'),
          admin: path.resolve(__dirname, 'shells/admin.html'),
          'dev-sandbox': path.resolve(__dirname, 'shells/dev-sandbox.html'),
        },
      },
    },
    publicDir: demoPublicDir,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      allowedHosts: ['sway.tips', 'www.sway.tips', 'app.sway.tips'],
      // HMR can be disabled in hosted edit environments with DISABLE_HMR.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
