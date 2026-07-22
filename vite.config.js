import { defineConfig } from 'vite';

export default defineConfig({
  base: '/city-builder-survival/',
  test: {
    include: ['tests/**/*.test.js'],
  },
});
