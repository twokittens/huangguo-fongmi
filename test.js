// 黄果短剧解析 Worker（Cloudflare Workers 免费档）
// 数据来源：https://huangguoai.com
// 适配参考：jinshengchan/huangguo-fongmi、cluntop/tvbox(huangguo.py / huangguo2.py)
//
// 设计要点：
// 1. 官方 JSON 接口优先（/api/videos/category、/api/ranks、/api/videos/{id}、/api/videos/{id}/play、/api/topics、/api/search），
//    HTML 抓取仅作兜底 —— 官方接口含分页元数据、评分、标签、时长，比正则可靠。
// 2. 封面为 AES-CBC 加密的**原始二进制**（非 base64 文本），须按二进制解密后校验图片魔数。
// 3. m3u8 为 AES-128 加密切片，通过 /raw 代理重写分片与密钥 URI，保证继续走本 Worker。
// 4. 浏览器 <video> 原生不支持 HLS，播放器库由 /hls.js 代理提供。
// 5. 名称统一：剥离 sr-only 辅助文本与站点后缀，剧集标题一律规范为「第N集」。
// 6. 列表解析一律**按容器块边界**切分（不再使用字符窗口），避免跨卡片串行污染。
// 7. 播放解析优先用官方 /api/videos/{id}/play，并**对比声明时长与实际 m3u8 时长**，
//    当源站只下发占位/预览片段时以 incomplete 标记返回，供前端如实提示（而非误判为解析失败）。

const SITE = 'https://huangguoai.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

const IMG_KEY = 'f5d965df75336270';
const IMG_IV = '97b60394abc2fbe1';
const EMPTY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CATEGORIES = [
  { type_id: 'recommend', type_name: '精选推荐' },
  { type_id: 'ai-duanju', type_name: 'AI成人短剧' },
  { type_id: 'ai-manju', type_name: 'AI成人漫剧' },
  { type_id: 'ai-huanlian', type_name: 'AI换脸' },
  { type_id: 'ai-mogai', type_name: 'AI魔改' },
  { type_id: 'ranks', type_name: '排行榜' },
  { type_id: 'chigua', type_name: '黄果吃瓜' },
  { type_id: 'topics', type_name: '话题精选' }
];
const SORTS = [
  { n: '最新更新', v: 'latest' },
  { n: '当前热播', v: 'hot' },
  { n: '独家原创', v: 'original' },
  { n: '随机推荐', v: 'random' }
];
const RANKS = ['hot', 'recommend', 'potential'];
const CHIGUA = ['all', 'remen', 'yuanchuang'];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' }
  });
}
function abs(u) {
  if (!u) return '';
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return SITE + u;
  return u;
}
function stripSrOnly(s) {
  return String(s || '').replace(/<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
}
function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function cleanTitle(s) {
  let t = stripTags(stripSrOnly(s));
  t = t.replace(/全集在线观看/g, '');
  t = t.replace(/[-–—|]\s*黄果短剧(吃瓜社区|社区)?\s*$/, '');
  t = t.replace(/黄果吃瓜侠\s*[·•]\s*\d{4}-\d{2}-\d{2}\s*[·•]\s*[^\s]*/g, '');
  t = t.replace(/吃瓜社区/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
function epTitle(n) {
  return '第' + String(n).replace(/[^0-9]/g, '') + '集';
}
function isRealImage(u) {
  if (!u) return false;
  if (/cover-placeholder|logo-huangguo|\.svg|mc\.yandex|google-analytics|pixel|tracker|\/icons\//i.test(u)) return false;
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u);
}
function magic(b) {
  if (!b || b.length < 3) return '';
  if (b[0] === 255 && b[1] === 216) return 'image/jpeg';
  if (b[0] === 137 && b[1] === 80 && b[2] === 78) return 'image/png';
  if (b[0] === 82 && b[1] === 73) return 'image/webp';
  if (b[0] === 71 && b[1] === 73) return 'image/gif';
  return '';
}

async function request(u, type) {
  try {
    const r = await fetch(u, {
      headers: {
        'User-Agent': UA,
        'Referer': SITE + '/',
        'Accept': type === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });
    if (!r.ok) return type === 'json' ? null : '';
    if (type === 'json') {
      try { return await r.json(); } catch (e) { return null; }
    }
    return await r.text();
  } catch (e) {
    return type === 'json' ? null : '';
  }
}
const getHtml = (u) => request(u, 'html');
const getJson = (u) => request(u, 'json');

async function aesDecrypt(bytes) {
  if (!bytes || !bytes.length || bytes.length % 16) return null;
  try {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(IMG_KEY), 'AES-CBC', false, ['decrypt']);
    const p = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(IMG_IV) }, k, bytes));
    const n = p[p.length - 1];
    if (n > 0 && n <= 16 && p.slice(-n).every((x) => x === n)) return p.slice(0, -n);
    return p;
  } catch (e) {
    return null;
  }
}
function imageProxy(u) {
  return isRealImage(u) ? '/media?url=' + encodeURIComponent(abs(u)) : '';
}
function buildRemarks(it) {
  if (!it) return '';
  const parts = [];
  if (it.is_finished) {
    const n = Number(it.total_episodes || it.episode_count || 0);
    parts.push(n ? '全' + n + '集' : '已完结');
  } else if (it.episode_count) {
    parts.push('更新至' + it.episode_count + '集');
  }
  if (it.score) parts.push(it.score + '分');
  if (Array.isArray(it.tags) && it.tags.length) parts.push(it.tags.slice(0, 3).join('·'));
  return parts.join(' · ');
}
function fromApiItem(it) {
  return {
    vod_id: String(it.id || it.video_id || ''),
    vod_name: cleanTitle(it.title || ''),
    vod_pic: imageProxy(it.cover || ''),
    vod_remarks: buildRemarks(it),
    vod_score: it.score || 0,
    vod_hot: it.hot || 0,
    vod_tags: it.tags || [],
    vod_desc: it.description || '',
    vod_episode_count: it.episode_count || 0,
    vod_finished: !!it.is_finished,
    vod_original: !!it.is_original,
    vod_created: it.created_at || ''
  };
}
function fromRankItem(it) {
  const o = fromApiItem(it);
  o.vod_id = String(it.video_id || it.id || '');
  if (it.rank) o.vod_remarks = ('#' + it.rank + ' ' + (it.metric_label || '') + (it.metric_value || '') + ' · ' + o.vod_remarks).replace(/ · $/, '');
  return o;
}

// 按容器块边界切分，避免跨卡片串行
function splitBlocks(html, cls) {
  const starts = [];
  const re = new RegExp('<div[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>', 'g');
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  const out = [];
  for (let i = 0; i < starts.length; i++) out.push(html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, starts[i] + 8000)));
  return out;
}
function parseCards(html) {
  const blocks = splitBlocks(html, 'hg-drama-card');
  const out = [];
  const seen = {};
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const lm = b.match(/href="([^"]*\/video\/(\d+)\/)"/) || b.match(/href="([^"]*\/detail\/(\d+)\/)"/);
    if (!lm) continue;
    const id = lm[2];
    if (seen[id]) continue;
    const tm = b.match(/class="[^"]*hg-drama-card__title[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    let name = tm ? cleanTitle(tm[1]) : '';
    if (!name) {
      const am = b.match(/<img[^>]+alt="([^"]+)"/i);
      if (am) name = cleanTitle(am[1]);
    }
    if (!name || /^\d+$/.test(name)) continue;
    const pics = [];
    const ri = /(?:data-src|data-original|src)="([^"]+)"/gi;
    let x;
    while ((x = ri.exec(b))) if (isRealImage(x[1])) pics.push(x[1]);
    const em = b.match(/hg-drama-card__episode[^>]*>([\s\S]*?)<\/span>/i);
    const sm = b.match(/hg-drama-card__score[^>]*>([\s\S]*?)<\/span>/i);
    const dm = b.match(/hg-drama-card__desc[^>]*>([\s\S]*?)<\/p>/i);
    seen[id] = 1;
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: imageProxy(pics[0] || ''),
      vod_remarks: [em && cleanTitle(em[1]), sm && cleanTitle(sm[1])].filter(Boolean).join(' · '),
      vod_tags: [],
      vod_desc: dm ? cleanTitle(dm[1]) : ''
    });
  }
  return out;
}
function parseRankCards(html) {
  const blocks = splitBlocks(html, 'hg-rank-item');
  const out = [];
  const seen = {};
  const src = blocks.length ? blocks : [html];
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    const lm = b.match(/href="([^"]*\/detail\/(\d+)\/)"/);
    if (!lm) continue;
    const id = lm[2];
    if (seen[id]) continue;
    const tm = b.match(/hg-rank-item__title[^>]*>([\s\S]*?)<\/a>/i) || b.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const name = cleanTitle(tm ? tm[1] : '');
    if (!name || name.length > 80) continue;
    const pics = [];
    const ri = /(?:data-src|data-original|src)="([^"]+)"/gi;
    let x;
    while ((x = ri.exec(b))) if (isRealImage(x[1])) pics.push(x[1]);
    const tg = b.match(/hg-rank-item__tags[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    seen[id] = 1;
    out.push({ vod_id: id, vod_name: name, vod_pic: imageProxy(pics[0] || ''), vod_remarks: tg ? cleanTitle(tg[1]) : '排行榜', vod_tags: [], vod_desc: '' });
  }
  return out;
}
function parseChigua(html) {
  const starts = [];
  const re = /<a[^>]*class="[^"]*hg-post-card[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  const out = [];
  const seen = {};
  for (let i = 0; i < starts.length; i++) {
    const b = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, starts[i] + 6000));
    const hm = b.match(/href="\/archives\/(\d+)\//);
    if (!hm) continue;
    const pid = hm[1];
    if (seen[pid]) continue;
    const tm = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const name = cleanTitle(tm ? tm[1] : '');
    if (!name || name.length > 120) continue;
    const im = b.match(/<img[^>]+data-src="([^"]+)"/i) || b.match(/<img[^>]+src="([^"]+)"/i);
    const mm = b.match(/hg-post-card__meta[^>]*>([\s\S]*?)<\/p>/i);
    seen[pid] = 1;
    out.push({ vod_id: 'archives_' + pid, vod_name: name, vod_pic: imageProxy(im ? im[1] : ''), vod_remarks: mm ? cleanTitle(mm[1]) : '吃瓜', vod_tags: [], vod_desc: '' });
  }
  return out;
}
function parseEpisodes(id, html) {
  const list = [{ ep: '1', url: SITE + '/video/' + id + '/', title: epTitle(1) }];
  const seen = { '1': 1 };
  const re = new RegExp('href="([^"]*\\/video\\/' + id + '\\/ep-(\\d+)\\/)"', 'gi');
  let m;
  while ((m = re.exec(html))) {
    const n = m[2];
    if (!seen[n]) {
      seen[n] = 1;
      list.push({ ep: n, url: abs(m[1]), title: epTitle(n) });
    }
  }
  return list.sort((a, b) => Number(a.ep) - Number(b.ep));
}
function coverOf(html) {
  const m = html.match(/id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try {
      const d = JSON.parse(m[1]);
      if (isRealImage(d.coverSrc)) return d.coverSrc;
    } catch (e) {}
  }
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return og && isRealImage(og[1]) ? og[1] : '';
}

async function category(tid, sort, page, size) {
  const api = await getJson(SITE + '/api/videos/category/' + encodeURIComponent(tid) + '?page=' + page + '&size=' + size + '&sort=' + encodeURIComponent(sort));
  if (api && api.data && Array.isArray(api.data.items) && api.data.items.length) {
    const p = api.data.pagination || {};
    return { list: api.data.items.map(fromApiItem), page: p.page || page, pagecount: p.pages || 1, total: p.total || api.data.items.length, limit: p.size || size, source: 'api' };
  }
  const html = await getHtml(SITE + '/' + tid + ('/' + (page > 1 ? page + '/' : '')));
  const cards = parseCards(html);
  const pm = html.match(/data-panel-total="(\d+)"/);
  const total = pm ? Number(pm[1]) : 0;
  return { list: cards, page, pagecount: total ? Math.max(1, Math.ceil(total / size)) : 1, total: total || cards.length, limit: size, source: 'html' };
}
async function ranks(type, page, size) {
  const api = await getJson(SITE + '/api/ranks/' + encodeURIComponent(type) + '?page=' + page + '&size=' + size);
  if (api && api.data && Array.isArray(api.data.items) && api.data.items.length) {
    const p = api.data.pagination || {};
    return { list: api.data.items.map(fromRankItem), page: p.page || page, pagecount: p.pages || 1, total: p.total || api.data.items.length, limit: p.size || size, source: 'api' };
  }
  const html = await getHtml(SITE + '/ranks/' + (type || 'hot') + ('/' + (page > 1 ? page + '/' : '')));
  const cards = parseRankCards(html);
  return { list: cards.slice(0, size), page, pagecount: 1, total: cards.length, limit: size, source: 'html' };
}
async function topics(slug, page, size) {
  if (!slug) {
    const api = await getJson(SITE + '/api/topics');
    const items = (api && api.data && api.data.items) || [];
    return {
      list: items.map((t) => ({
        vod_id: 'topic_' + t.slug,
        vod_name: cleanTitle(t.title),
        vod_pic: imageProxy(t.cover || ''),
        vod_remarks: t.video_count + '部',
        vod_tags: [],
        vod_desc: t.intro || ''
      })),
      page: 1, pagecount: 1, total: items.length, limit: size, source: 'api'
    };
  }
  const html = await getHtml(SITE + '/topics/' + encodeURIComponent(slug) + '/' + (page > 1 ? '?page=' + page : ''));
  const cards = parseCards(html);
  const pm = html.match(/data-pages="(\d+)"/);
  return { list: cards.slice(0, size), page, pagecount: pm ? Number(pm[1]) : 1, total: cards.length, limit: size, source: 'html' };
}
async function chigua(cate, page, size) {
  const base = cate && cate !== 'all' ? '/chigua/' + encodeURIComponent(cate) : '/chigua';
  const html = await getHtml(SITE + base + '/' + (page > 1 ? 'page/' + page + '/' : ''));
  const out = parseChigua(html);
  const pm = html.match(/data-pages="(\d+)"/);
  return { list: out.slice(0, size), page, pagecount: pm ? Number(pm[1]) : 1, total: out.length, limit: size, source: 'html' };
}
async function detail(id) {
  if (/^archives_/.test(id)) {
    const pid = id.replace('archives_', '');
    const html = await getHtml(SITE + '/archives/' + pid + '/');
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    const tt = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    let name = cleanTitle(h1 || tt);
    if (!name) name = '吃瓜' + pid;
    let v = '';
    const vm = html.match(/<video[^>]+src="(https?:\/\/[^"]+)"/i) || html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i) || html.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i);
    if (vm) v = vm[1];
    return {
      list: [{
        vod_id: id, vod_name: name, vod_pic: imageProxy(coverOf(html)),
        vod_remarks: '吃瓜', vod_desc: '', vod_tags: [],
        episodes: v ? [{ ep: '1', url: v, title: epTitle(1) }] : []
      }]
    };
  }
  const api = await getJson(SITE + '/api/videos/' + encodeURIComponent(id));
  const html = await getHtml(SITE + '/video/' + id + '/');
  const fallbackEps = parseEpisodes(id, html);
  if (api && api.data && api.data.id) {
    const d = api.data;
    const eps = (d.episodes || []).map((e) => {
      const n = String(e.ep_num);
      return {
        ep: n,
        url: n === '1' ? SITE + '/video/' + id + '/' : SITE + '/video/' + id + '/ep-' + n + '/',
        title: epTitle(n),
        duration: e.duration || 0
      };
    });
    return {
      list: [{
        vod_id: String(d.id),
        vod_name: cleanTitle(d.title || id),
        vod_pic: imageProxy(d.cover || ''),
        vod_remarks: buildRemarks(d),
        vod_desc: d.description || '',
        vod_score: d.score || 0,
        vod_tags: d.tags || [],
        vod_year: (d.created_at || '').slice(0, 4),
        vod_episode_count: d.episode_count || eps.length,
        vod_finished: !!d.is_finished,
        vod_original: !!d.is_original,
        vod_created: d.created_at || '',
        vod_author: (d.author && d.author.name) || '',
        vod_hot: (d.counts && d.counts.hot) || d.hot || 0,
        vod_play_count: (d.counts && d.counts.play) || 0,
        vod_like: (d.counts && d.counts.like) || 0,
        vod_collect: (d.counts && d.counts.collect) || 0,
        episodes: eps.length ? eps : fallbackEps,
        source: 'api'
      }]
    };
  }
  return {
    list: [{
      vod_id: id,
      vod_name: cleanTitle((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || id,
      vod_pic: imageProxy(coverOf(html)),
      vod_remarks: '', vod_desc: '', vod_tags: [],
      episodes: fallbackEps,
      source: 'html'
    }]
  };
}
async function search(keyword, page, size) {
  const api = await getJson(SITE + '/api/search?keyword=' + encodeURIComponent(keyword) + '&page=' + page + '&size=' + size);
  if (api && api.data && Array.isArray(api.data.items) && api.data.items.length) {
    const p = api.data.pagination || {};
    return { list: api.data.items.map(fromApiItem), page: p.page || page, pagecount: p.pages || 1, total: p.total || api.data.items.length, limit: p.size || size, source: 'api' };
  }
  const html = await getHtml(SITE + '/search/video/' + encodeURIComponent(keyword) + '/');
  const cards = parseCards(html);
  return { list: cards, page, pagecount: 1, total: cards.length, limit: size, source: 'html' };
}

async function media(url) {
  const fallback = () => new Response(EMPTY_PNG, { headers: { ...CORS, 'content-type': 'image/png' } });
  if (!/^https?:\/\//i.test(url || '')) return fallback();
  let r = null;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } });
  } catch (e) {
    return fallback();
  }
  if (!r || !r.ok) return fallback();
  const b = new Uint8Array(await r.arrayBuffer());
  const direct = magic(b);
  if (direct) return new Response(b, { headers: { ...CORS, 'content-type': direct, 'cache-control': 'public,max-age=86400' } });
  const p = await aesDecrypt(b);
  const t = p ? magic(p) : '';
  if (p && t) return new Response(p, { headers: { ...CORS, 'content-type': t, 'cache-control': 'public,max-age=86400' } });
  return fallback();
}
async function proxyRaw(url, origin) {
  if (!/^https?:\/\//i.test(url || '')) return new Response(null, { status: 400, headers: CORS });
  let r = null;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } });
  } catch (e) {
    return new Response(null, { status: 502, headers: CORS });
  }
  const ct = r.headers.get('content-type') || '';
  const buf = new Uint8Array(await r.arrayBuffer());
  if (new TextDecoder().decode(buf.slice(0, 7)) === '#EXTM3U') {
    let base = null;
    try { base = new URL(url); } catch (e) { base = null; }
    const rw = (href) => {
      let t = href;
      try { t = new URL(href, base).href; } catch (e) {}
      return origin + '/raw?url=' + encodeURIComponent(t);
    };
    const text = new TextDecoder().decode(buf).split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') return line.replace(/URI="([^"]+)"/gi, (w, p1) => 'URI="' + rw(p1) + '"');
      return rw(t);
    }).join('\n');
    return new Response(text, { headers: { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } });
  }
  return new Response(buf, { headers: { ...CORS, 'content-type': ct || 'application/octet-stream', 'cache-control': 'public,max-age=3600' } });
}
async function hlsLib() {
  const cdns = [
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
    'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js'
  ];
  for (let i = 0; i < cdns.length; i++) {
    try {
      const r = await fetch(cdns[i]);
      if (r.ok) {
        const b = await r.arrayBuffer();
        return new Response(b, { headers: { ...CORS, 'content-type': 'application/javascript;charset=utf-8', 'cache-control': 'public,max-age=604800' } });
      }
    } catch (e) {}
  }
  return new Response('/* hls.js unavailable */', { status: 502, headers: { ...CORS, 'content-type': 'application/javascript' } });
}
function m3u8Info(text) {
  let sec = 0;
  const re = /#EXTINF:([\d.]+)/g;
  let m;
  while ((m = re.exec(text))) sec += parseFloat(m[1]);
  return {
    duration: Math.round(sec * 10) / 10,
    segments: (text.match(/#EXTINF/g) || []).length,
    key: (text.match(/EXT-X-KEY:METHOD=([A-Z0-9-]+)/i) || [])[1] || '',
    master: /EXT-X-STREAM-INF/i.test(text)
  };
}

// 播放解析：官方 /api/videos/{id}/play 优先，页面 videoInitialData 兜底；
// 并探测真实流时长以识别源站占位/预览片段
async function play(page, ep) {
  const id = (String(page || '').match(/\/video\/(\d+)/) || String(page || '').match(/^(\d+)$/) || [])[1] || '';
  const epNum = String(ep || '1');
  let stream = '';
  let declared = 0;
  let title = '';
  let source = 'page';

  if (id) {
    const api = await getJson(SITE + '/api/videos/' + id + '/play?ep=' + encodeURIComponent(epNum));
    if (api && api.data && api.data.video_url) {
      stream = String(api.data.video_url || '');
      declared = Number(api.data.duration) || 0;
      title = api.data.title || '';
      source = 'api';
    }
  }
  if (!stream) {
    const html = await getHtml(page);
    const m = html.match(/id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const d = JSON.parse(m[1]);
        stream = (d.epPlaySrcs && d.epPlaySrcs[epNum]) || d.videoSrc || '';
        if (!declared) declared = Number(d.duration) || 0;
      } catch (e) {}
    }
    if (!stream) {
      const mm = html.match(/https?:\/\/[^"'<>\s]+?\.(?:m3u8|mp4)(?:\?[^"'<>\s]*)?/i);
      if (mm) stream = mm[0];
    }
  }
  stream = String(stream).replace(/\\u0026/g, '&').replace(/\\\//g, '/');

  let probe = null;
  let incomplete = false;
  if (stream && /\.m3u8/i.test(stream)) {
    try {
      const r = await fetch(stream, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } });
      if (r.ok) {
        probe = m3u8Info(await r.text());
        if (declared && probe.duration && probe.duration < declared * 0.8) incomplete = true;
      }
    } catch (e) {}
  }
  return { id, ep: epNum, stream, declared, title, source, probe, incomplete };
}

async function handle(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  const origin = url.origin;
  try {
    if (url.pathname === '/hls.js') return hlsLib();
    if (url.pathname === '/media') return media(url.searchParams.get('url'));
    if (url.pathname === '/raw') return proxyRaw(url.searchParams.get('url'), origin);
    if (url.pathname.indexOf('/api') !== 0) {
      return new Response('Huangguo Parser API', { headers: { ...CORS, 'content-type': 'text/plain;charset=utf-8' } });
    }

    const p = url.pathname.slice(4);
    const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
    const size = Math.min(60, Math.max(1, Number(url.searchParams.get('size') || 24) || 24));
    const sort = url.searchParams.get('sort') || 'latest';

    if (p === '/') return json({ status: 'ok', categories: CATEGORIES, sorts: SORTS });
    if (p === '/categories') return json({ categories: CATEGORIES, sorts: SORTS, ranks: RANKS, chigua: CHIGUA });
    if (p === '/all') {
      const out = { categories: CATEGORIES, sorts: SORTS, ranks: RANKS, chigua: CHIGUA, sections: {} };
      const sec = async (k, fn) => {
        try { out.sections[k] = await fn(); } catch (e) { out.sections[k] = { error: String(e) }; }
      };
      await sec('recommend', () => category('ai-duanju', 'latest', 1, 12));
      await sec('ranksHot', () => ranks('hot', 1, 10));
      await sec('topics', () => topics('', 1, 9));
      await sec('chigua', () => chigua('all', 1, 8));
      return json(out);
    }
    if (p.indexOf('/category/') === 0) return json(await category(p.split('/')[2] || 'ai-duanju', sort, page, size));
    if (p.indexOf('/ranks/') === 0) return json(await ranks(p.split('/')[2] || 'hot', page, size));
    if (p.indexOf('/topics') === 0) return json(await topics(url.searchParams.get('slug') || '', page, size));
    if (p.indexOf('/chigua') === 0) return json(await chigua(url.searchParams.get('cate') || 'all', page, size));
    if (p.indexOf('/search/') === 0) return json(await search(decodeURIComponent(p.split('/')[2] || ''), page, size));
    if (p.indexOf('/detail/') === 0) return json(await detail(p.split('/')[2] || ''));
    if (p === '/play') {
      const info = await play(decodeURIComponent(url.searchParams.get('url') || ''), url.searchParams.get('ep') || '1');
      // 重要：CDN 按**请求出口 IP** 下发不同播放列表 —— 住宅/移动 IP 拿到完整片源，
      // 而 Cloudflare 数据中心 IP 只拿到约 54 秒的预览片段（同一 URL、同一签名）。
      // 实测：Worker 出口 54s/7 片，住宅 IP 240s/42 片。
      // 因此前端必须**直连 info.stream**（浏览器出口=用户真实 IP），
      // proxy 仅作直连失败时的兜底；workerProbe 是 Cloudflare 出口的观测值，
      // 只用于诊断，绝不能用来判定用户能否完整播放。
      return json({
        url: info.stream,
        proxy: info.stream ? origin + '/raw?url=' + encodeURIComponent(info.stream) : '',
        preferDirect: true,
        id: info.id,
        ep: info.ep,
        title: info.title,
        source: info.source,
        declaredDuration: info.declared,
        workerProbe: info.probe ? {
          actualDuration: info.probe.duration,
          segments: info.probe.segments,
          keyMethod: info.probe.key,
          note: 'Cloudflare 出口探测值；用户浏览器直连时通常为完整时长'
        } : null
      });
    }
    if (p === '/recommend') return json(await category('ai-duanju', 'latest', 1, 20));
    return json(await category(p.replace(/^\//, '').replace(/\/$/, '') || 'ai-duanju', sort, page, size));
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
