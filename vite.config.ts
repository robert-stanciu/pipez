import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    // TresJS resolves <TresMesh>, <TresBoxGeometry> and friends against three.js at runtime,
    // so they have to be treated as custom elements. Its own options are used rather than a
    // hand-rolled `tag.startsWith('Tres')`, which would also swallow <TresCanvas> itself and
    // leave the scene without its context provider.
    vue({ ...templateCompilerOptions }),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
