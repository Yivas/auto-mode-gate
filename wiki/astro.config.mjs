import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://yivas.github.io',
  base: '/auto-mode-gate',
  integrations: [
    starlight({
      title: 'Auto Mode Gate',
      description: 'Deterministic Bash permission gate for OpenCode and Pi.',
      customCss: ['./src/styles/custom.css'],
      editLink: {
        baseUrl: 'https://github.com/Yivas/auto-mode-gate/edit/main/wiki/',
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Yivas/auto-mode-gate',
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', link: '/' },
            { slug: 'getting-started/install', label: 'Install' },
            { slug: 'getting-started/configure', label: 'Configure' },
          ],
        },
        {
          label: 'Use the gate',
          collapsed: true,
          items: [
            { slug: 'guide/verify-and-operate', label: 'Verify and operate' },
            { slug: 'guide/decisions', label: 'Understand decisions' },
            { slug: 'guide/modes-and-logs', label: 'Modes and sanitized logs' },
            { slug: 'guide/coverage-and-boundaries', label: 'Coverage and boundaries' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [{ slug: 'reference/validated-baselines', label: 'Validated baselines' }],
        },
        {
          label: 'Project',
          collapsed: true,
          items: [{ slug: 'project/participation-and-provenance', label: 'Participation and provenance' }],
        },
      ],
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      disable404Route: true,
    }),
  ],
});
