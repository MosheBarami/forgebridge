/**
 * Tailwind v4 has no `tailwind.config.js`: the design system is declared in CSS
 * (`src/app/globals.css`, `@theme inline`) so that a token has exactly one
 * definition and it is the one the browser reads. This file is the whole build
 * integration.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
