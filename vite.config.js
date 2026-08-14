import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this project under /Daily-Sales-Leaders/.
export default defineConfig({
  base: '/Daily-Sales-Leaders/',
  plugins: [react()],
  server: { port: 5175 },
});
