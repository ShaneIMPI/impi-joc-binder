import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: this must match your GitHub repo name exactly.
// If you name the repo something other than "impi-digital-cards",
// change the string below to "/your-repo-name/".
export default defineConfig({
  plugins: [react()],
  base: '/impi-digital-cards/'
})
