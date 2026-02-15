import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // For GitHub Pages: set base to your repo name.
  // Change 'fb-explorer' to match your actual GitHub repo name.
  base: '/fb-explorer/',
})
