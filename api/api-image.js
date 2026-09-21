const withTimeout = async (url, options = {}, ms = 20000) => {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  finally { clearTimeout(timer); }
};

module.exports = async function(req, res) {
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
    const raw = typeof req.query?.url === 'string' ? req.query.url : '';
    let target;
    try { target = new URL(raw); } catch { return res.status(400).send('Invalid image URL'); }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).send('Invalid protocol');
    const r = await withTimeout(target.href, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'referer': 'https://www.aliexpress.com/'
      }
    }, 15000);
    if (!r.ok) return res.status(r.status).send('Image fetch failed');
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) return res.status(415).send('Not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).send('Image proxy error');
  }
};
