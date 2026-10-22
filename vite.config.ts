import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/; local dev serves from /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.BASE_PATH ?? '/sheep-herding/') : '/',
  build: { target: 'es2022' },
}));
