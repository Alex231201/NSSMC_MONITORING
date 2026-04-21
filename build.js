const fs = require("fs");
const path = require("path");

const BASE = "https://www.nssmc.gov.ua";
const OUT_DIR = "site";

// Main sections to scan
const SECTION_CONFIGS = [
  { url: "https://www.nssmc.gov.ua/news/", pages: 15 },
  { url: "https://www.nssmc.gov.ua/category/news/", pages: 15 },
  { url: "https://www.nssmc.gov.ua/en/category/news/", pages: 15 },
  { url: "https://www.nssmc.gov.ua/en/category/news/zasidannia-komisii/", pages: 12 },
  { url: "https://www.nssmc.gov.ua/en/category/news/ltsenzuvannya/", pages: 12 },
  { url: "https://www.nssmc.gov.ua/en/category/news/naglyad/", pages: 12 }
];

// Add more variants here over time when you notice misses.
const ENTITIES = [
  {
    name: "АТ «ЗНВКІФ ««ДІМІДІУМ»",
    aliases: [
      "АТ «ЗНВКІФ ««ДІМІДІУМ»",
      "АКЦІОНЕРНЕ ТОВАРИСТВО «ЗАКРИТИЙ НЕДИВЕРСИФІКОВАНИЙ ВЕНЧУРНИЙ КОРПОРАТИВНИЙ ІНВЕСТИЦІЙНИЙ ФОНД «ДІМІДІУМ»",
      "ЗНВКІФ ДІМІДІУМ",
      "ДІМІДІУМ",
      "46201433"
    ]
  },
  {
    name: 'ТОВ "КУА "УНІВЕР МЕНЕДЖМЕНТ"',
    aliases: [
      "ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ КОМПАНІЯ З УПРАВЛІННЯ АКТИВАМИ УНІВЕР МЕНЕДЖМЕНТ",
      'ТОВ "КУА "УНІВЕР МЕНЕДЖМЕНТ"',
      "КУА УНІВЕР МЕНЕДЖМЕНТ",
      "УНІВЕР МЕНЕДЖМЕНТ",
      "33777261"
    ]
  },
  {
    name: 'ТОВ "УКРСОЦ-КАПІТАЛ"',
    aliases: [
      'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "КОМПАНІЯ З УПРАВЛІННЯ АКТИВАМИ- АДМІНІСТРАТОР ПЕНСІЙНИХ ФОНДІВ "УКРСОЦ-КАПІТАЛ"',
      'ТОВ "УКРСОЦ-КАПІТАЛ"',
      'ТОВ "КУА-АПФ "УКРСОЦ-КАПІТАЛ"',
      "КУА-АПФ УКРСОЦ-КАПІТАЛ",
      "УКРСОЦ-КАПІТАЛ",
      "33058377"
    ]
  },
  {
    name: 'ТОВ "ФК "ЗЕНИТ-ДТ"',
    aliases: [
      'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ФОНДОВА КОМПАНІЯ "ЗЕНИТ-ДТ"',
      'ТОВ "ФК "ЗЕНИТ-ДТ"',
      "ФК ЗЕНИТ-ДТ",
      "ЗЕНИТ-ДТ",
      "35309589"
    ]
  }
];

function normalizeText(text) {
  return String(text || "")
    .replaceAll("«", '"')
    .replaceAll("»", '"')
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("’", "'")
    .replaceAll("`", "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateHuman(dateObj) {
  const dd = String(dateObj.getUTCDate()).padStart(2, "0");
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = dateObj.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatDateIso(dateObj) {
  const dd = String(dateObj.getUTCDate()).padStart(2, "0");
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = dateObj.getUTCFullYear();
  return `${yyyy}-${mm}-${dd}`;
}

function parseInputDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return d;
}

function buildDateVariants(fromStr, toStr) {
  const from = parseInputDate(fromStr);
  const to = parseInputDate(toStr);

  if (from > to) {
    throw new Error("DATE_FROM cannot be later than DATE_TO");
  }

  const variants = [];
  const current = new Date(from);

  while (current <= to) {
    variants.push(formatDateHuman(current));
    variants.push(formatDateIso(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return [...new Set(variants)];
}

function toIsoDate(dateString) {
  if (!dateString) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return dateString;

  const m = dateString.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return "";
}

function isDateWithinRange(foundDate, fromStr, toStr) {
  const iso = toIsoDate(foundDate);
  if (!iso) return false;
  return iso >= fromStr && iso <= toStr;
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function isArticleLikeUrl(url) {
  if (!url || !url.startsWith(BASE)) return false;

  // Skip feeds, tags, authors, file downloads, embeds, admin-ish endpoints
  if (
    /\/feed\/?$|\/tag\/|\/author\/|\/users\/|\/embed\/?$|\/trackback\/?$|\/wp-json\/|\/xmlrpc\.php/i.test(url) ||
    /\.(pdf|doc|docx|xls|xlsx|zip|rar|jpg|jpeg|png|gif|webp)($|\?)/i.test(url)
  ) {
    return false;
  }

  // Prefer real article-looking paths.
  const u = new URL(url);
  const path = u.pathname;

  if (
    path === "/" ||
    path === "/news/" ||
    path === "/category/news/" ||
    path === "/en/category/news/" ||
    path.includes("/page/")
  ) {
    return false;
  }

  return true;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; NSSMC-GitHub-Monitor/2.0)"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.text();
}

function extractLinks(html, baseUrl) {
  const matches = [...html.matchAll(/href\s*=\s*["']([^"'#>]+)["']/gi)];
  const out = new Set();

  for (const match of matches) {
    const full = absoluteUrl(match[1], baseUrl);
    if (!full) continue;
    if (!isArticleLikeUrl(full)) continue;
    out.add(full);
  }

  return [...out];
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html, fallbackUrl) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (m ? htmlToText(m[1]) : fallbackUrl).replace(/\s+/g, " ").trim();
}

function matchEntities(text) {
  const norm = normalizeText(text);
  const hits = [];

  for (const entity of ENTITIES) {
    for (const alias of entity.aliases) {
      if (norm.includes(normalizeText(alias))) {
        hits.push({
          entity: entity.name,
          matchedBy: alias
        });
        break;
      }
    }
  }

  return hits;
}

function extractExcerpt(text, alias) {
  const normText = normalizeText(text);
  const normAlias = normalizeText(alias);
  const idx = normText.indexOf(normAlias);

  if (idx < 0) {
    return text.slice(0, 700);
  }

  const start = Math.max(0, idx - 250);
  const end = Math.min(text.length, idx + alias.length + 700);
  return text.slice(start, end).trim();
}

function detectPageDate(text, html = "") {
  const patterns = [
    /\b(\d{2}\.\d{2}\.\d{4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/
  ];

  // First try text
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m[1];
  }

  // Then try HTML meta/date-ish attributes
  const htmlPatterns = [
    /datetime=["'](\d{4}-\d{2}-\d{2})/i,
    /published[^>]*?(\d{2}\.\d{2}\.\d{4})/i,
    /date[^>]*?(\d{2}\.\d{2}\.\d{4})/i
  ];

  for (const pattern of htmlPatterns) {
    const m = html.match(pattern);
    if (m) return m[1];
  }

  return "";
}

function buildPaginatedUrls(sectionUrl, pageCount) {
  const urls = [sectionUrl];

  for (let i = 2; i <= pageCount; i += 1) {
    const clean = sectionUrl.endsWith("/") ? sectionUrl : `${sectionUrl}/`;
    urls.push(`${clean}page/${i}/`);
  }

  return urls;
}

async function collectSectionLinks() {
  const all = new Set();

  for (const config of SECTION_CONFIGS) {
    const paginated = buildPaginatedUrls(config.url, config.pages);

    for (const pageUrl of paginated) {
      try {
        console.log(`Loading section page: ${pageUrl}`);
        const html = await fetchText(pageUrl);
        const links = extractLinks(html, pageUrl);
        for (const link of links) {
          all.add(link);
        }
      } catch (err) {
        console.warn(`Section page failed: ${pageUrl} :: ${err.message}`);
      }
    }
  }

  return [...all];
}

async function scanPage(url, dateVariants, fromStr, toStr) {
  try {
    const html = await fetchText(url);
    const text = htmlToText(html);
    const title = extractTitle(html, url);

    if (!text) return [];

    // Must contain a target date somewhere
    if (!dateVariants.some(v => text.includes(v) || html.includes(v))) {
      return [];
    }

    const foundDate = detectPageDate(text, html);
    if (!isDateWithinRange(foundDate, fromStr, toStr)) {
      return [];
    }

    const hits = matchEntities(text);
    if (!hits.length) return [];

    return hits.map(hit => ({
      entity: hit.entity,
      matchedBy: hit.matchedBy,
      title,
      url, // direct NSSMC article URL
      date: foundDate || "within selected period",
      excerpt: extractExcerpt(text, hit.matchedBy)
    }));
  } catch (err) {
    console.warn(`Page failed: ${url} :: ${err.message}`);
    return [];
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = `${item.entity}|||${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function groupByEntity(items) {
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.entity]) grouped[item.entity] = [];
    grouped[item.entity].push(item);
  }
  return grouped;
}

function sortResults(items) {
  return [...items].sort((a, b) => {
    const da = toIsoDate(a.date) || "0000-00-00";
    const db = toIsoDate(b.date) || "0000-00-00";
    return db.localeCompare(da);
  });
}

function buildHtml(results, fromStr, toStr, generatedAt) {
  const grouped = groupByEntity(results);

  const controls = `
    <div class="controls">
      <h3>Choose another period</h3>
      <div class="controls-row">
        <div class="control-group">
          <label for="dateFrom">From</label>
          <input type="date" id="dateFrom" value="${escapeHtml(fromStr)}">
        </div>
        <div class="control-group">
          <label for="dateTo">To</label>
          <input type="date" id="dateTo" value="${escapeHtml(toStr)}">
        </div>
      </div>
      <div class="controls-row">
        <button class="button" onclick="openWorkflow()">Open GitHub workflow</button>
      </div>
      <p class="muted">
        Select the dates here, then click the button. The GitHub workflow page will open in a new tab.
        Copy the same dates there and run the workflow.
      </p>
    </div>
  `;

  let body = "";

  if (!results.length) {
    body = `
      <div class="empty">
        <h2>No matches found</h2>
        <p>No matching NSSMC HTML pages were found for the selected period.</p>
      </div>
    `;
  } else {
    for (const [entity, rows] of Object.entries(grouped)) {
      const sortedRows = sortResults(rows);
      body += `
        <section class="entity">
          <h2>${escapeHtml(entity)}</h2>
          ${sortedRows.map(row => `
            <div class="item">
              <div class="meta">
                <span class="badge">${escapeHtml(row.date)}</span>
              </div>
              <h3>${escapeHtml(row.title)}</h3>
              <p><strong>Matched by:</strong> ${escapeHtml(row.matchedBy)}</p>
              <p><strong>Source:</strong> <a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.url)}</a></p>
              <div class="excerpt">${escapeHtml(row.excerpt)}</div>
            </div>
          `).join("")}
        </section>
      `;
    }
  }

  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NSSMC Monitor Report</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f5f7fb; color:#1f2937; margin:0; padding:0; }
    .container { max-width:1100px; margin:0 auto; padding:24px; }
    .header, .entity, .empty { background:#fff; border-radius:16px; padding:20px; box-shadow:0 8px 24px rgba(0,0,0,.08); margin-bottom:20px; }
    .item { border:1px solid #e5e7eb; border-radius:12px; padding:14px; margin-top:14px; background:#fafafa; }
    .badge { display:inline-block; background:#dbeafe; color:#1d4ed8; border-radius:999px; padding:4px 10px; font-size:12px; font-weight:700; }
    .excerpt { white-space:pre-wrap; background:#fff; border-left:4px solid #6366f1; padding:12px; border-radius:10px; margin-top:10px; line-height:1.5; }
    a { color:#2563eb; word-break:break-all; }
    .muted { color:#6b7280; }
    .controls { margin-top:24px; padding:16px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa; }
    .controls h3 { margin-top:0; }
    .controls-row { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:12px; }
    .control-group { display:flex; flex-direction:column; gap:6px; }
    .control-group label { font-weight:700; font-size:14px; }
    .control-group input { padding:10px 12px; border:1px solid #d1d5db; border-radius:10px; font-size:14px; }
    .button { background:#2563eb; color:#fff; border:none; border-radius:10px; padding:12px 16px; font-weight:700; cursor:pointer; }
    .button:hover { opacity:0.95; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>NSSMC Monitor Report</h1>
      <p><strong>Period:</strong> ${escapeHtml(fromStr)} to ${escapeHtml(toStr)}</p>
      <p><strong>Generated:</strong> ${escapeHtml(generatedAt)}</p>
      <p><strong>Total matches:</strong> ${results.length}</p>
      <p class="muted">This version scans HTML article pages and pagination, and links directly to NSSMC pages.</p>
      ${controls}
    </div>
    ${body}
  </div>

  <script>
    function openWorkflow() {
      const from = document.getElementById('dateFrom').value;
      const to = document.getElementById('dateTo').value;
      const workflowUrl = 'https://github.com/Alex231201/NSSMC_MONITORING/actions/workflows/build-report.yml';

      try {
        localStorage.setItem('nssmc_monitor_date_from', from);
        localStorage.setItem('nssmc_monitor_date_to', to);
      } catch (e) {}

      window.open(workflowUrl, '_blank');
    }

    (function restoreDates() {
      try {
        const savedFrom = localStorage.getItem('nssmc_monitor_date_from');
        const savedTo = localStorage.getItem('nssmc_monitor_date_to');

        if (savedFrom) document.getElementById('dateFrom').value = savedFrom;
        if (savedTo) document.getElementById('dateTo').value = savedTo;
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}

async function main() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const defaultDate = formatDateIso(yesterday);

  const fromStr = process.env.DATE_FROM || defaultDate;
  const toStr = process.env.DATE_TO || defaultDate;

  const dateVariants = buildDateVariants(fromStr, toStr);
  const links = await collectSectionLinks();

  let results = [];
  let i = 0;

  for (const url of links) {
    i += 1;
    console.log(`Scanning ${i}/${links.length}: ${url}`);
    const hits = await scanPage(url, dateVariants, fromStr, toStr);
    if (hits.length) results.push(...hits);
  }

  results = dedupe(results);
  results = sortResults(results);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const generatedAt = new Date().toISOString();
  const html = buildHtml(results, fromStr, toStr, generatedAt);

  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html, "utf8");

  const json = {
    period: { from: fromStr, to: toStr },
    generatedAt,
    totalMatches: results.length,
    results
  };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(json, null, 2), "utf8");

  console.log(`Done. Matches: ${results.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
