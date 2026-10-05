/**
 * Preset: the smallest useful starting point. Everything here is meant to be
 * renamed — the copy says so out loud.
 */

import { genericSite, theme, TITLE_FIELD, SUMMARY_FIELD, bodyField } from './shared.js';

export const blank = {
  site: genericSite({
    name: 'Your Catalog',
    tagline: 'A short line describing what this catalog collects',
    description: 'A browsable, filterable catalog. Replace this description with your own.',
    organization: {
      name: 'Your Organization',
      short_name: 'ORG',
      url: 'https://example.org',
      contact_email: 'you@example.org',
    },
    logo: { image: '', text: 'ORG' },
    modules: {
      catalog: true,
      submit: true,
      carousel: false,
      stats: false,
      events: false,
      cohorts: false,
      resources: false,
      governance: false,
      status: true,
    },
    hero: {
      eyebrow: 'Your Organization',
      title: 'A catalog of things worth sharing',
      lead: 'Replace this line with a sentence about what people will find here and why it is worth their time.',
      primary_cta: { label: 'Browse the catalog', url: '/catalog/', module: 'catalog' },
      secondary_cta: { label: 'Submit an entry', url: '/submit/', module: 'submit' },
    },
    home: { featured_count: 6, recent_count: 6, highlights: [] },
    submit: {
      intro:
        'Submit an entry for the catalog. Submissions open a GitHub issue for the maintainers to review; nothing is published until it is approved.',
      turnaround: 'A maintainer reviews it, usually within two weeks.',
      review_note: 'Please do not include confidential or non-public information in your submission.',
      fallback_email: 'you@example.org',
    },
    footer: {
      about:
        'Replace this with a sentence or two about who maintains this catalog and how entries are reviewed.',
      links: [
        { label: 'Organization home', url: 'https://example.org' },
        { label: 'Submit an entry', url: '/submit/', module: 'submit' },
      ],
      copyright: 'Your Organization',
    },
  }),
  theme: theme({ primary: '#475569', primary_dark: '#1E293B', secondary: '#64748B', accent: '#0F766E' }),
  schema: {
    entry: { singular: 'Entry', plural: 'Entries', path: 'catalog', sort: 'published', sort_order: 'desc' },
    groups: [
      { key: 'about', title: 'About', description: 'What this entry is.' },
      { key: 'details', title: 'Details', description: 'How you want people to find it.' },
      {
        key: 'links',
        title: 'Links & images',
        description: 'Anything to look at or click through to.',
        placement: 'rail',
      },
    ],
    fields: [
      { ...TITLE_FIELD, placeholder: 'A clear, specific title' },
      { ...SUMMARY_FIELD, placeholder: 'One or two sentences describing this entry.' },
      {
        key: 'category',
        label: 'Category',
        prompt: 'Which category does it belong to?',
        type: 'select',
        group: 'about',
        weight: 3,
        facet: true,
        card: 'badge',
        icon: 'layers',
        options: ['Category one', 'Category two', 'Category three'],
        option_meta: {
          'Category one': {
            short: 'One',
            icon: 'star',
            description: 'Replace this with what the first category means.',
          },
          'Category two': {
            short: 'Two',
            icon: 'flag',
            description: 'Replace this with what the second category means.',
          },
          'Category three': {
            short: 'Three',
            icon: 'bolt',
            description: 'Replace this with what the third category means.',
          },
        },
        description: 'Replace these options with your own categories.',
      },
      {
        key: 'tags',
        label: 'Tags',
        prompt: 'What topics does it touch?',
        type: 'list',
        group: 'details',
        weight: 1,
        facet: true,
        card: 'chip',
        search: true,
        icon: 'tag',
        description: 'Free-form tags, one per line or comma-separated.',
        placeholder: 'tag one, tag two',
      },
      {
        key: 'link_url',
        label: 'Link',
        prompt: 'Is there somewhere to send people?',
        type: 'url',
        group: 'links',
        weight: 1,
        icon: 'globe',
        placeholder: 'https://example.org',
        description: 'An external link for this entry, if there is one.',
      },
      {
        key: 'resources',
        label: 'Other links',
        prompt: 'Anything else worth linking?',
        type: 'links',
        group: 'links',
        weight: 2,
        icon: 'link',
        placeholder: 'Documentation | https://example.org/docs',
        description: 'One per line as “Label | URL”.',
      },
      {
        key: 'screenshots',
        label: 'Images',
        prompt: 'Do you have pictures of it?',
        type: 'images',
        group: 'links',
        weight: 3,
        icon: 'image',
        description: 'Optional. Drop images into the issue, or paste image URLs one per line.',
      },
      bodyField({
        label: 'Details',
        group: 'details',
        weight: 2,
        required: false,
        description: 'Markdown is supported.',
        placeholder: '## Overview\n\n## Details\n',
      }),
    ],
  },
};

export default blank;
