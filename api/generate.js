// ClicBoutique — POST /api/generate
// Reçoit { productUrl, style } et construit une boutique dédiée à UN produit AliExpress.
// Le serveur lit les métadonnées publiques de la fiche (titre, prix, images, description)
// puis demande à Claude de rédiger la boutique. L'URL fournisseur est conservée pour l'export.

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 24000;
const FETCH_TIMEOUT_MS = 10000;

const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 6;
}

const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

function validAliExpressUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return (u.protocol === 'https:' || u.protocol === 'http:') &&
      (host === 'aliexpress.com' || host.endsWith('.aliexpress.com'));
  } catch (_) {
    return false;
  }
}

async function withTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(v) {
  return String(v || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/').replace(/&#x27;/gi, "'")
    .replace(/\\u0026/g, '&');
}

function stripHtml(v) {
  return decodeHtml(String(v || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function meta(html, key, attr='property') {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp("<meta[^>]+(?:" + attr + ")=[\\\"']" +
    escaped +
    "[\\\"'][^>]+content=[\\\"']([^\\\"']*)[\\\"'][^>]*>", 'i');
  const m = html.match(re);
  return m ? decodeHtml(m[1]) : '';
}

function allMeta(html, keys) {
  for (const key of keys) {
    const v = meta(html, key, 'property') || meta(html, key, 'name');
    if (v) return v;
  }
  return '';
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch (_) {}
  }
  return out;
}

function collectImages(html) {
  const found = [];
  const add = (u) => {
    if (!u || typeof u !== 'string') return;
    const clean = decodeHtml(u).replace(/\\u002F/g, '/').trim();
    if (!/^https?:\/\//i.test(clean)) return;
    if (!found.includes(clean)) found.push(clean);
  };
  add(meta(html, 'og:image'));
  add(meta(html, 'og:image:url'));
  for (const item of extractJsonLd(html)) {
    const image = item && item.image;
    if (Array.isArray(image)) image.slice(0, 8).forEach(add);
    else if (typeof image === 'string') add(image);
    else if (image && typeof image.url === 'string') add(image.url);
  }
  // AliExpress embeds additional image URLs in JSON. Keep only a modest number.
  const re = /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi;
  let m;
  while ((m = re.exec(html)) && found.length < 8) add(m[0].replace(/\\\//g, '/'));
  return found.slice(0, 8);
}

function extractProductPage(html, finalUrl) {
  const ld = extractJsonLd(html);
  let product = null;
  for (const item of ld) {
    if (item && (item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product')))) {
      product = item;
      break;
    }
  }
  const offers = product && product.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  const title = s(
    (product && product.name) ||
    allMeta(html, ['og:title', 'twitter:title']) ||
    stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1]),
    180
  );
  const description = s(
    (product && product.description) ||
    allMeta(html, ['og:description', 'description', 'twitter:description']),
    1200
  );
  const price = Number(
    (offer && (offer.price || offer.lowPrice)) ||
    allMeta(html, ['product:price:amount'])
  ) || 0;
  const currency = s((offer && offer.priceCurrency) || allMeta(html, ['product:price:currency']), 8);
  const images = collectImages(html);
  return {
    url: finalUrl,
    title,
    description: stripHtml(description),
    price,
    currency,
    images,
    rawText: stripHtml(html).slice(0, 12000)
  };
}

async function fetchProduct(url) {
  const r = await withTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  }, FETCH_TIMEOUT_MS);
  const final = r.url || url;
  if (!validAliExpressUrl(final)) throw new Error('La redirection ne reste pas sur AliExpress');
  if (!r.ok) throw new Error('AliExpress HTTP ' + r.status);
  const html = await r.text();
  if (!html || html.length < 200) throw new Error('Fiche AliExpress vide');
  return extractProductPage(html, final);
}

const SYSTEM = `Tu es un expert e-commerce francophone. Tu crées une boutique en ligne professionnelle dédiée à UN SEUL produit fourni par une fiche AliExpress.
Réponds UNIQUEMENT avec un objet JSON valide, sans markdown.

Schéma :
{
  "name": "nom de boutique court et mémorable, sans marque existante",
  "tagline": "slogan de 6 à 12 mots",
  "heroKicker": "2 à 4 mots",
  "philosophy": "10 à 16 mots",
  "about": "2 à 3 phrases concrètes",
  "heroTitle": "4 à 8 mots",
  "heroSubtitle": "12 à 20 mots",
  "products": [{
    "name": "nom clair du produit",
    "price": 29.9,
    "comparePrice": 0,
    "category": "Produit",
    "description": "2 phrases factuelles et vendeuses",
    "features": ["3 points forts factuels"],
    "badge": "Best-seller | Nouveau | Promo | vide",
    "emoji": "1 emoji",
    "image": "URL d'une image fournie par la fiche, sinon vide",
    "images": ["jusqu'à 4 URL d'images fournies par la fiche"]
  }],
  "testimonials": [{"author":"Prénom + initiale","rating":5,"text":"exemple clairement présenté comme avis à remplacer"}],
  "trustPoints": [{"title":"2-3 mots","text":"5-8 mots"}]
}

Règles :
- Il y a EXACTEMENT 1 produit dans products.
- Utilise le titre, la description, le prix et les images de la fiche comme source principale.
- Ne fabrique pas de caractéristiques techniques, dimensions, matériaux, certifications, résultats, chiffres ou promesses absentes de la fiche.
- Si le prix source est disponible, propose un prix de vente en euros raisonnable en le signalant seulement comme prix de vente ; sinon utilise 0.
- N'utilise aucune marque existante dans le nom de boutique ou le marketing.
- Ne présente jamais un faux avis comme un avis réel : les 3 testimonials doivent être explicitement formulés comme exemples à remplacer.
- Aucun label/certification ni allégation médicale.
- Les images doivent être choisies uniquement parmi les URLs d'images fournies.
- Les textes sont en français.`;

async function askClaude(style, product) {
  const user = [
    'Style visuel : ' + style,
    'URL fournisseur : ' + product.url,
    'Titre source : ' + product.title,
    'Prix source : ' + (product.price || 'inconnu') + ' ' + (product.currency || ''),
    'Description source : ' + product.description,
    'Images disponibles : ' + JSON.stringify(product.images),
    'Contenu public extrait de la fiche : ' + product.rawText
  ].join('\n\n');

  const r = await withTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3500,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }]
    })
  }, CLAUDE_TIMEOUT_MS);
  if (!r.ok) throw new Error('Claude HTTP ' + r.status);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Réponse IA sans JSON');
  return JSON.parse(text.slice(a, b + 1));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';
  if (tooMany(ip)) return res.status(429).json({ error: 'Trop de demandes, réessaie dans quelques minutes' });

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (_) { body = {}; }

  const productUrl = s(body && body.productUrl, 1000).replace(/[\u0000-\u001f]/g, '');
  const style = ['mini', 'color', 'lux'].includes(body && body.style)
    ? { mini: 'minimaliste', color: 'coloré', lux: 'luxe' }[body.style]
    : 'minimaliste';

  if (!validAliExpressUrl(productUrl)) {
    return res.status(400).json({ error: 'URL AliExpress invalide' });
  }

  try {
    let source;
    try {
      source = await fetchProduct(productUrl);
    } catch (e) {
      console.warn('Lecture AliExpress impossible :', e && e.message);
      // On continue avec l'URL seule : Claude peut au moins construire la structure,
      // et l'interface signalera que les données doivent être vérifiées.
      source = { url: productUrl, title: '', description: '', price: 0, currency: '', images: [], rawText: '' };
    }

    let raw = await askClaude(style, source);
    const p = Array.isArray(raw.products) && raw.products[0] ? raw.products[0] : {};
    const allowedImages = new Set(source.images || []);
    const image = allowedImages.has(p.image) ? p.image : (source.images[0] || '');
    const images = Array.isArray(p.images)
      ? p.images.filter(x => allowedImages.has(x)).slice(0, 4)
      : [];
    if (image && !images.includes(image)) images.unshift(image);

    const price = Number(p.price) > 0 ? Number(p.price) : 0;
    const product = {
      name: s(p.name, 90) || source.title || 'Produit AliExpress',
      price,
      comparePrice: Number(p.comparePrice) > price ? Number(p.comparePrice) : 0,
      category: 'Produit',
      description: s(p.description, 500),
      features: Array.isArray(p.features) ? p.features.map(x => s(x, 80)).filter(Boolean).slice(0, 4) : [],
      rating: 5,
      reviews: 0,
      reviewsList: [],
      badge: ['Best-seller', 'Nouveau', 'Promo'].includes(p.badge) ? p.badge : '',
      image,
      images,
      emoji: s(p.emoji, 4) || '🛍️'
    };

    return res.status(200).json({
      name: s(raw.name, 60) || 'Ma Boutique',
      tagline: s(raw.tagline, 140),
      heroKicker: s(raw.heroKicker, 40),
      philosophy: s(raw.philosophy, 160),
      about: s(raw.about, 600),
      heroTitle: s(raw.heroTitle, 90) || product.name,
      heroSubtitle: s(raw.heroSubtitle, 200),
      heroImage: image,
      heroEmoji: product.emoji,
      productUrl: source.url || productUrl,
      products: [product],
      realSupplier: true,
      sourcingNote: source.title ? 'Informations récupérées depuis la fiche AliExpress.' : 'La fiche AliExpress n’a pas pu être lue complètement : vérifie les informations avant publication.',
      testimonials: Array.isArray(raw.testimonials) ? raw.testimonials.slice(0, 3) : [],
      trustPoints: Array.isArray(raw.trustPoints) ? raw.trustPoints.slice(0, 3) : []
    });
  } catch (err) {
    console.error('generate error:', err && err.message);
    return res.status(502).json({ error: 'Génération impossible pour le moment' });
  }
};
