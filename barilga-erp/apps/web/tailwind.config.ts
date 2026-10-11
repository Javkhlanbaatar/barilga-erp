import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        steel: {
          950: '#0c1014',
          900: '#141a21',
          800: '#1c2630',
          700: '#2a3846',
        },
        amber: {
          brand: '#e8b923',
        },
      },
      fontFamily: {
        sans: ['Segoe UI', 'Noto Sans Mongolian', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
