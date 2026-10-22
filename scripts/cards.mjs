// Renders the profile cards (assets/*.svg) from the GitHub GraphQL API.
// No dependencies and no third-party services: Node 20+ fetch and string templates.
//
//   GITHUB_TOKEN=... node scripts/cards.mjs
//
// With a token that can read private repositories, their languages and private
// contributions are counted too (only totals are drawn, never repository names).

import { mkdir, writeFile } from 'node:fs/promises';

const LOGIN = process.env.PROFILE_LOGIN || 'nightlightmare';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');

const QUERY = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    createdAt
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $cursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date } }
      }
    }
  }
}`;

async function gql(variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'User-Agent': `${LOGIN}-profile-cards` },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data.user;
}

async function load() {
  let cursor = null;
  let first;
  const repos = [];
  do {
    const user = await gql({ login: LOGIN, cursor });
    first ??= user;
    repos.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (cursor);
  return { user: first, repos };
}

// Generated files and markup inflate byte counts without saying anything about the work.
const IGNORED_LANGUAGES = new Set(['HTML', 'CSS', 'SCSS', 'Dockerfile', 'Shell', 'PowerShell', 'Batchfile', 'PLpgSQL', 'Makefile']);

function languages(repos) {
  const total = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      if (IGNORED_LANGUAGES.has(node.name)) continue;
      const prev = total.get(node.name) ?? { size: 0, color: node.color ?? '#8b949e' };
      prev.size += size;
      total.set(node.name, prev);
    }
  }
  const sorted = [...total.entries()].sort((a, b) => b[1].size - a[1].size);
  const sum = sorted.reduce((s, [, v]) => s + v.size, 0) || 1;
  const top = sorted.slice(0, 6).map(([name, v]) => ({ name, color: v.color, share: v.size / sum }));
  const rest = 1 - top.reduce((s, l) => s + l.share, 0);
  if (rest > 0.005) top.push({ name: 'Other', color: '#8b949e', share: rest });
  return top;
}

const THEMES = {
  light: { bg: '#ffffff', border: '#d0d7de', title: '#1f2328', text: '#59636e', muted: '#eff2f5', accent: '#1a7f37' },
  dark: { bg: '#0d1117', border: '#30363d', title: '#e6edf3', text: '#9198a1', muted: '#161b22', accent: '#3fb950' },
};

const W = 420;
const H = 190;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function frame(t, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
<style>text{font-family:${FONT}}</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="${t.bg}" stroke="${t.border}"/>
<text x="20" y="32" font-size="15" font-weight="600" fill="${t.title}">${esc(title)}</text>
${body}
</svg>
`;
}

function languagesCard(t, langs, repoCount) {
  const barX = 20;
  const barW = W - 40;
  let x = barX;
  const segments = langs
    .map((l) => {
      const w = Math.max(l.share * barW, 2);
      const seg = `<rect x="${x.toFixed(1)}" y="50" width="${Math.max(w - 2, 1).toFixed(1)}" height="10" fill="${l.color}"/>`;
      x += w;
      return seg;
    })
    .join('');
  const legend = langs
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const lx = 20 + col * 200;
      const ly = 88 + row * 24;
      return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/>
<text x="${lx + 16}" y="${ly}" font-size="12" fill="${t.title}">${esc(l.name)}</text>
<text x="${lx + 180}" y="${ly}" font-size="12" fill="${t.text}" text-anchor="end">${(l.share * 100).toFixed(1)}%</text>`;
    })
    .join('\n');
  return frame(
    t,
    'Languages',
    `<clipPath id="bar"><rect x="${barX}" y="50" width="${barW}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)">${segments}</g>
${legend}
<text x="20" y="${H - 18}" font-size="11" fill="${t.text}">Across ${repoCount} repositories, public and private</text>`,
  );
}

function activityCard(t, cc) {
  const weeks = cc.contributionCalendar.weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0));
  const max = Math.max(...weeks, 1);
  const chartX = 20;
  const chartY = 120;
  const chartH = 54;
  const step = (W - 40) / weeks.length;
  const bars = weeks
    .map((n, i) => {
      const h = n === 0 ? 2 : Math.max((n / max) * chartH, 3);
      const fill = n === 0 ? t.muted : t.accent;
      const opacity = n === 0 ? 1 : (0.35 + 0.65 * (n / max)).toFixed(2);
      return `<rect x="${(chartX + i * step).toFixed(1)}" y="${(chartY + chartH - h).toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${fill}" fill-opacity="${opacity}"/>`;
    })
    .join('');
  const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  let streak = 0;
  let longest = 0;
  for (const d of days) {
    streak = d.contributionCount > 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const stats = [
    ['Contributions', cc.contributionCalendar.totalContributions],
    ['Commits', cc.totalCommitContributions + cc.restrictedContributionsCount],
    ['Active days', days.filter((d) => d.contributionCount > 0).length],
    ['Longest streak', longest],
  ]
    .map(([label, value], i) => {
      const x = 20 + i * 100;
      return `<text x="${x}" y="72" font-size="22" font-weight="600" fill="${t.title}">${value.toLocaleString('en-US')}</text>
<text x="${x}" y="92" font-size="11" fill="${t.text}">${label}</text>`;
    })
    .join('\n');
  return frame(t, 'Last 12 months', `${stats}\n${bars}`);
}

const { user, repos } = await load();
const langs = languages(repos);
const cc = user.contributionsCollection;

await mkdir('assets', { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  await writeFile(`assets/languages-${name}.svg`, languagesCard(t, langs, repos.length));
  await writeFile(`assets/activity-${name}.svg`, activityCard(t, cc));
}
console.log(
  `repos: ${repos.length}, contributions: ${cc.contributionCalendar.totalContributions}, languages: ${langs.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', ')}`,
);
