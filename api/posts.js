/* GET /api/posts
   Reads Substack, decides which posts go under each of the four headers,
   and returns them as JSON for the page to draw.

   Order inside a header:
     1. posts pinned on Substack that belong to that header (newest first)
     2. your starting list from posts.config.json (in the order you wrote it)
     3. if that is still under `min`, the newest matching posts top it up
   Then it is cut to `max`.

   Source: Substack's archive JSON (it knows about pins). If that fails it falls
   back to the RSS feed (no pin info), and if that fails too it returns the
   starting lists, so the page never comes back empty. */

const config = require('../posts.config.json');

const UA = 'Mozilla/5.0 (compatible; anmolshrivastava.in personal site)';
const PAGE = 12;

async function get(url, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept, 'user-agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r;
  } finally { clearTimeout(timer); }
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const urlFor = slug => `${config.publication}/p/${slug}`;

/* ---------- Source 1: archive JSON (has pins, sections, tags) ---------- */
async function fromArchive() {
  const posts = [];
  let cursor = null;
  for (let page = 0; page < config.pagesToFetch; page++) {
    const q = `${config.publication}/api/v1/archive?sort=new&limit=${PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const body = await (await get(q, 'application/json')).json();
    const rows = Array.isArray(body) ? body : body.posts;
    if (!Array.isArray(rows)) throw new Error('Unexpected archive shape');
    for (const p of rows) {
      if (!p.slug || (p.type && p.type !== 'newsletter')) continue;
      posts.push({
        slug: p.slug,
        title: clean(p.title),
        url: p.canonical_url || urlFor(p.slug),
        date: p.post_date || '',
        homePinned: Array.isArray(p.pins) && p.pins.length > 0,
        sectionPinned: p.is_section_pinned === true,
        section: p.section_name || '',
        tags: (p.postTags || []).map(t => t.name)
      });
    }
    cursor = Array.isArray(body) ? null : body.nextCursor;
    if (!cursor || rows.length === 0) break;
  }
  if (posts.length === 0) throw new Error('Archive returned no posts');
  return posts;
}

/* ---------- Source 2: RSS (no pins) ---------- */
async function fromRss() {
  const xml = await (await get(`${config.publication}/feed`, 'application/rss+xml')).text();
  const posts = [];
  for (const chunk of xml.split('<item>').slice(1)) {
    const title = (chunk.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s) || [])[1];
    const link = (chunk.match(/<link>(.*?)<\/link>/s) || [])[1];
    const date = (chunk.match(/<pubDate>(.*?)<\/pubDate>/s) || [])[1];
    const slug = link && link.split('/p/')[1];
    if (title && slug) posts.push({ slug, title: clean(title), url: link, date: date ? new Date(date).toISOString() : '',
      homePinned: false, sectionPinned: false, section: '', tags: [] });
  }
  if (posts.length === 0) throw new Error('RSS returned no posts');
  return posts;
}

/* ---------- Which header does a post belong to? ---------- */
function categoryOf(post, seedOwner) {
  if (config.overrides[post.slug]) return config.overrides[post.slug];   // 1. you said so
  if (seedOwner[post.slug]) return seedOwner[post.slug];                  // 2. it is in a starting list
  if (config.sections[post.section]) return config.sections[post.section]; // 3. Substack section
  for (const t of post.tags) if (config.tags[t]) return config.tags[t];    // 4. Substack tag
  const text = ` ${post.title} `.toLowerCase();                            // 5. keywords in the title
  for (const rule of config.keywords) {
    if (rule.words.some(w => text.includes(w))) return rule.category;
  }
  return config.defaultCategory;                                           // 6. default
}

/* ---------- Pick the posts for every header ---------- */
function build(posts) {
  const hidden = new Set(config.hide);
  const bySlug = new Map(posts.map(p => [p.slug, p]));
  const seedOwner = {};
  for (const [id, c] of Object.entries(config.categories)) for (const s of c.seed) seedOwner[s.slug] = id;

  const visible = posts.filter(p => !hidden.has(p.slug));
  const isPinned = p => p.homePinned || (config.useSectionPins && p.sectionPinned);
  const newestFirst = (a, b) => String(b.date).localeCompare(String(a.date));

  const out = {};
  for (const [id, c] of Object.entries(config.categories)) {
    const mine = visible.filter(p => categoryOf(p, seedOwner) === id);
    const pinned = mine.filter(isPinned).sort(newestFirst);
    const seeded = c.seed.filter(s => !hidden.has(s.slug)).map(s => {
      const live = bySlug.get(s.slug);
      return live ? { ...live } : { slug: s.slug, title: s.title, url: urlFor(s.slug), homePinned: false, sectionPinned: false };
    });
    const pool = mine.slice().sort(newestFirst);

    const list = [];
    const seen = new Set();
    const add = p => { if (!seen.has(p.slug) && list.length < config.max) { seen.add(p.slug); list.push(p); } };
    pinned.forEach(add);
    seeded.forEach(add);
    for (const p of pool) { if (list.length >= config.min) break; add(p); }

    out[id] = list.map(p => ({ title: p.title, url: p.url, pinned: isPinned(p) }));
  }
  return out;
}

function seedOnly() {
  const out = {};
  for (const [id, c] of Object.entries(config.categories)) {
    out[id] = c.seed.map(s => ({ title: s.title, url: urlFor(s.slug), pinned: false }));
  }
  return out;
}

module.exports = async function handler(req, res) {
  let posts = null, source = 'seed', note;
  try { posts = await fromArchive(); source = 'archive'; }
  catch (e1) {
    note = String(e1.message || e1);
    try { posts = await fromRss(); source = 'rss'; }
    catch (e2) { note += ' | ' + String(e2.message || e2); }
  }
  const categories = posts ? build(posts) : seedOnly();

  // Fresh on a reload, but not hammering Substack on every single visit.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({ updatedAt: new Date().toISOString(), source, ...(note ? { note } : {}), categories });
};

module.exports.build = build;           // exported for the test script
module.exports.categoryOf = categoryOf;
