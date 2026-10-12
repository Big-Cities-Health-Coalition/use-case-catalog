import defaultTheme from 'tailwindcss/defaultTheme';
import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';

// Colors are CSS variables (RGB channel triples) emitted by _includes/theme.html
// from _data/theme.yml, so the palette is data-driven and alpha modifiers
// (e.g. bg-brand-primary/10) still work.
const rgb = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  // Wraps every `hover:` rule (including the ones composed with @apply inside
  // components/*.css) in `@media (hover: hover)`, so a tap on a touch device no longer
  // leaves a pill or a card stuck in its hover state. +95 B gzip; Tailwind 4's default.
  future: { hoverOnlyWhenSupported: true },
  content: [
    './_layouts/**/*.html',
    './_includes/**/*.html',
    './_plugins/**/*.rb',
    './*.md',
    './*.html',
    './catalog/**/*.{md,html}',
    './cohorts/**/*.{md,html}',
    './events/**/*.{md,html}',
    './resources/**/*.{md,html}',
    './submit/**/*.{md,html}',
    './status/**/*.{md,html}',
    './setup/**/*.{md,html}',
    './about/**/*.{md,html}',
    './governance/**/*.{md,html}',
    './styleguide/**/*.{md,html}',
    './assets/js/**/*.js',
  ],
  // No safelist. Badge tones are `class="badge" data-tone="…"` (see
  // assets/css/components/badges.css) and every chip/signal variant is a literal in a
  // template, so Tailwind's scanner sees everything it needs. test/styles/tokens.test.mjs
  // builds the stylesheet and fails if a tone ever goes missing again.
  theme: {
    extend: {
      colors: {
        brand: {
          primary: rgb('primary'),
          'primary-dark': rgb('primary-dark'),
          secondary: rgb('secondary'),
          accent: rgb('accent'),
          ink: rgb('ink'),
          muted: rgb('muted'),
          line: rgb('line'),
          'line-strong': rgb('line-strong'),
          'on-dark': rgb('on-dark'),
          warn: rgb('warn'),
        },
        surface: {
          base: rgb('surface'),
          // Tinted bands and panels: the fact strip, the sidebar cards, the home page's
          // "Browse by" band. Sits between `base` and `card` so a panel can be a panel
          // without a border — see docs/design-system.md → Surfaces.
          tint: rgb('surface-tint'),
          card: rgb('card'),
        },
      },
      fontFamily: {
        heading: ['var(--font-heading)', ...defaultTheme.fontFamily.sans],
        sans: ['var(--font-body)', ...defaultTheme.fontFamily.sans],
      },
      borderRadius: {
        // Semantic names — what component CSS should use. Each says what it is for, so
        // the token it returns cannot drift out of step with its name the way the numeric
        // scale below has (`rounded-lg` returns the *medium* token).
        hairline: 'var(--radius-xs)', // checkbox-sized corners, focus targets
        control: 'var(--radius-md)', // inputs, toggles, small panels
        card: 'var(--radius-xl)', // cards, panels
        sheet: 'var(--radius-2xl)', // sheets, dialogs, hero blocks
        pill: '9999px', // badges, chips, buttons — never themed
        // Legacy numeric names, kept because page markup uses them widely. The offset
        // (`lg` → --radius-md) is preserved deliberately: correcting it would resize every
        // corner on the site. `sm` used to escape the theme entirely at Tailwind's fixed
        // 0.125rem, which looked wrong under `radius: round`; it now maps to --radius-xs.
        DEFAULT: 'var(--radius-sm)',
        sm: 'var(--radius-xs)',
        md: 'var(--radius-sm)',
        lg: 'var(--radius-md)',
        xl: 'var(--radius-lg)',
        '2xl': 'var(--radius-xl)',
        '3xl': 'var(--radius-2xl)',
      },
      // Elevation: E0 = resting card (a hairline drawn as a shadow ring plus a 1px ambient,
      // so a card needs no border and its edge stays crisp on every surface token). E1 =
      // hover lift. E2 = sticky bars, sheets, popovers.
      boxShadow: {
        e0: '0 0 0 1px rgb(var(--c-ink) / 0.10), 0 1px 2px rgb(var(--c-ink) / 0.05), 0 6px 12px -8px rgb(var(--c-ink) / 0.10)',
        e1: '0 1px 2px rgb(var(--c-ink) / 0.06), 0 8px 16px -8px rgb(var(--c-ink) / 0.12)',
        e2: '0 2px 4px rgb(var(--c-ink) / 0.06), 0 16px 32px -12px rgb(var(--c-ink) / 0.18)',
        // Legacy aliases kept for older layouts; prefer e1/e2.
        card: '0 1px 2px rgb(var(--c-ink) / 0.06), 0 8px 16px -8px rgb(var(--c-ink) / 0.12)',
        subtle: 'none',
      },
      // Motion, like colour and radius, is a theme token: _data/theme.yml → motion,
      // emitted as --motion-* / --ease-brand by _includes/theme.html. A fork that wants
      // calmer motion changes one YAML key instead of grepping ~20 component rules.
      transitionTimingFunction: { brand: 'var(--ease-brand)' },
      animationTimingFunction: { brand: 'var(--ease-brand)' },
      transitionDuration: {
        fast: 'var(--motion-fast)', // state changes
        base: 'var(--motion-base)', // hover, expand
        slow: 'var(--motion-slow)', // sheets, overlays
        // Legacy numeric aliases: the same three tokens under their old default values'
        // names, so existing `duration-120/180/240` markup keeps working and keeps
        // tracking the theme. Prefer the semantic names in new CSS.
        120: 'var(--motion-fast)',
        180: 'var(--motion-base)',
        240: 'var(--motion-slow)',
      },
      maxWidth: { prose: '68ch' },
      typography: () => ({
        DEFAULT: {
          css: {
            // The measure is a theme token (_data/theme.yml -> type.measure, emitted as
            // --measure by _includes/theme.html), not `ch`: the CSS `ch` unit is the advance
            // width of "0" (~0.66em in Inter) while an average running-English character is
            // ~0.48em, so Tailwind's 65ch prose default renders ~88 characters. Owning it
            // here rather than via `max-w-prose` also keeps `@apply prose` collision-free.
            maxWidth: 'var(--measure)',
            '--tw-prose-body': 'rgb(var(--c-ink))',
            '--tw-prose-headings': 'rgb(var(--c-primary-dark))',
            '--tw-prose-links': 'rgb(var(--c-primary))',
            '--tw-prose-bold': 'rgb(var(--c-ink))',
            '--tw-prose-quotes': 'rgb(var(--c-ink))',
            '--tw-prose-quote-borders': 'rgb(var(--c-primary))',
            '--tw-prose-bullets': 'rgb(var(--c-primary))',
            '--tw-prose-counters': 'rgb(var(--c-primary))',
            '--tw-prose-hr': 'rgb(var(--c-line))',
            '--tw-prose-th-borders': 'rgb(var(--c-line))',
            '--tw-prose-td-borders': 'rgb(var(--c-line))',
            '--tw-prose-code': 'rgb(var(--c-primary-dark))',
            '--tw-prose-pre-bg': 'rgb(var(--c-primary-dark))',
            '--tw-prose-pre-code': 'rgb(var(--c-on-dark))',
            h1: { fontFamily: 'var(--font-heading)' },
            h2: { fontFamily: 'var(--font-heading)' },
            h3: { fontFamily: 'var(--font-heading)' },
            // Links keep their colour on --tw-prose-links (so the variable contract still
            // holds) and carry a permanent underline: colour alone is not a sufficient
            // distinguisher for in-text links (WCAG 1.4.1). The 35% decoration keeps the
            // rule quiet at body size and goes solid on hover.
            a: {
              fontWeight: '500',
              textDecoration: 'underline',
              textDecorationColor: 'rgb(var(--c-primary) / 0.35)',
              textUnderlineOffset: '2px',
              '&:hover': { color: 'rgb(var(--c-primary-dark))', textDecorationColor: 'currentColor' },
            },
          },
        },
      }),
    },
  },
  plugins: [forms, typography],
};
