// Macaw's stylesheet pulls in every @fontsource subset (Cyrillic, Greek,
// Vietnamese, Latin-ext, ...) and they all get base64-inlined into
// dist/bundle.js, pushing it past the 1 MB custom-app limit. Keep only the
// basic Latin faces; other scripts fall back to system fonts.
const latinFontsOnly = () => ({
  postcssPlugin: 'latin-fonts-only',
  AtRule: {
    'font-face': (rule) => {
      let range;
      rule.walkDecls('unicode-range', (decl) => {
        range = decl.value;
      });
      if (range && !/U\+0000-00FF/i.test(range)) rule.remove();
    },
  },
});
latinFontsOnly.postcss = true;

export default {
  plugins: [latinFontsOnly(), (await import('tailwindcss')).default(), (await import('autoprefixer')).default()],
}
