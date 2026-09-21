// ClicBoutique — fonction serveur (Vercel) : POST /api/generate  { niche, style }
//
// 1. Claude écrit la boutique (nom, textes, produits, descriptions, prix).
// 2. Pexels (ou Pixabay) fournit de vraies photos pour chaque produit (gratuit, usage commercial autorisé).
// 3. Le JSON renvoyé est celui que clicboutique.html sait afficher.
//
// Variables d'environnement à définir dans Vercel :
//   ANTHROPIC_API_KEY  (obligatoire)  clé sur console.anthropic.com
//   PEXELS_API_KEY     (photos)       clé gratuite sur pexels.com/api
//   PIXABAY_API_KEY    (photos)       alternative gratuite : pixabay.com/api/docs — utilisée si Pexels n'est pas configuré
//                                     (sans aucune des deux clés, la boutique s'affiche avec des visuels de remplacement)
//   ALLOWED_ORIGIN     (recommandée)  ex. https://ton-site.com — limite qui peut appeler la fonction
//   CLAUDE_MODEL       (optionnelle)  défaut : claude-haiku-4-5-20251001 (rapide, tient dans les 30 s)

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 24000;
const PEXELS_TIMEOUT_MS = 6000;

// Anti-abus simple (en mémoire, par instance) : 6 boutiques / 10 min / adresse IP.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 6;
}

const SYSTEM = `Tu es un expert e-commerce francophone. Tu crées le contenu d'une boutique en ligne professionnelle et crédible.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown.

Schéma exact :
{
  "name": "nom de boutique court et mémorable (2-3 mots, sans marque existante)",
  "tagline": "slogan de 6 à 12 mots",
  "about": "présentation de la boutique, 2 phrases",
  "heroTitle": "titre accrocheur de 4 à 8 mots",
  "heroSubtitle": "1 phrase de 12 à 20 mots",
  "niche_keyword": "le produit principal de la niche, en anglais, 1 à 3 mots (ex : « shin guards », « wooden lamp », « dog harness »)",
  "hero_query": "requête photo en anglais, 3-5 mots : le produit principal en situation (doit contenir niche_keyword)",
  "products": [
    {
      "name": "nom de produit précis et réaliste (jamais « Produit 1 »)",
      "price": 29.9,
      "compare_price": 0,
      "category": "catégorie parmi 2 ou 3 au total",
      "description": "2 phrases concrètes et vendeuses",
      "features": ["3 points forts courts et factuels"],
      "badge": "Best-seller | Nouveau | Promo | vide",
      "emoji": "1 emoji",
      "image_query": "requête photo en anglais, 2-4 mots : le nom EXACT de l'objet tel qu'on le photographierait (ex : « football shin guards », « gold ring », « yoga mat »)"
    }
  ],
  "testimonials": [{ "author": "Prénom + initiale", "rating": 5, "text": "avis crédible de 1-2 phrases" }],
  "trustPoints": [{ "title": "2-3 mots", "text": "5-8 mots" }]
}

Règles :
- Exactement 8 produits, répartis en 2 ou 3 catégories.
- TOUS les produits doivent appartenir directement à la niche demandée (ex. niche « protège tibia » : protège-tibias, chaussettes de maintien, sac de sport…), jamais un produit sans rapport.
- Chaque image_query désigne l'objet lui-même (jamais un mot abstrait comme « protection », « sport » ou « quality ») et contient toujours le mot-clé de la niche ou le nom exact du produit.
- Prix réalistes en euros pour la niche ; « compare_price » = ancien prix barré (supérieur au prix) pour 2 produits maximum, sinon 0.
- Exactement 3 testimonials et 3 trustPoints.
- N'utilise AUCUNE marque existante, ni certification ou label (bio, CE, etc.), ni allégation de santé ou médicale.
- Reste factuel : pas de chiffres ou de résultats inventés dans les descriptions.`;

function extractJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Réponse IA sans JSON');
  return JSON.parse(text.slice(a, b + 1));
}

async function withTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function askClaude(niche, style) {
  const r = await withTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Niche : ${niche}\nStyle visuel souhaité : ${style || 'minimaliste'}` }]
    })
  }, CLAUDE_TIMEOUT_MS);
  if (!r.ok) throw new Error('Claude HTTP ' + r.status);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return extractJson(text);
}

// Cherche des photos (Pexels, sinon Pixabay) pour UNE requête
async function searchPhotos(query, orientation) {
  if (process.env.PEXELS_API_KEY) {
    const url = 'https://api.pexels.com/v1/search?per_page=10&orientation=' + orientation + '&query=' + encodeURIComponent(query);
    const r = await withTimeout(url, { headers: { Authorization: process.env.PEXELS_API_KEY } }, PEXELS_TIMEOUT_MS);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.photos || []).map(p => p.src && p.src.large);
  }
  if (process.env.PIXABAY_API_KEY) {
    const url = 'https://pixabay.com/api/?key=' + encodeURIComponent(process.env.PIXABAY_API_KEY) +
      '&image_type=photo&safesearch=true&per_page=10&orientation=' + (orientation === 'landscape' ? 'horizontal' : 'all') +
      '&q=' + encodeURIComponent(query);
    const r = await withTimeout(url, {}, PEXELS_TIMEOUT_MS);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.hits || []).map(h => orientation === 'landscape' ? h.largeImageURL : h.webformatURL);
  }
  return [];
}

// Essaie plusieurs requêtes de la plus précise à la plus générale, sans réutiliser deux fois la même photo
async function findPhoto(queries, orientation, used) {
  for (const q of queries.filter(Boolean)) {
    try {
      const pick = (await searchPhotos(q, orientation)).find(u => u && !used.has(u));
      if (pick) { used.add(pick); return pick; }
    } catch (e) { /* on essaie la requête suivante */ }
  }
  return '';
}

// Garantit que la requête contient le mot-clé de la niche (évite les photos sans rapport)
function withKeyword(query, keyword) {
  const q = (query || '').trim();
  if (!keyword) return q;
  const words = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const has = words.some(w => q.toLowerCase().includes(w));
  return has ? q : (keyword + ' ' + q).trim();
}

const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { body = {}; }
  const niche = s(body && body.niche, 120).replace(/[\u0000-\u001f]/g, ' ');
  const style = ['mini', 'color', 'lux'].includes(body && body.style)
    ? { mini: 'minimaliste', color: 'coloré', lux: 'luxe' }[body.style] : 'minimaliste';
  if (niche.length < 2) return res.status(400).json({ error: 'Niche manquante' });

  try {
    const raw = await askClaude(niche, style);
    const list = (Array.isArray(raw.products) ? raw.products : []).filter(p => p && p.name).slice(0, 8);
    if (list.length < 3) throw new Error('Pas assez de produits');

    // Photos en parallèle : 1 pour la bannière + 1 par produit
    const used = new Set();
    const keyword = s(raw.niche_keyword, 40);
    const [heroImage, ...images] = await Promise.all([
      findPhoto([withKeyword(s(raw.hero_query, 60), keyword), keyword], 'landscape', used),
      ...list.map(p => findPhoto([withKeyword(s(p.image_query, 60), keyword), keyword], 'square', used))
    ]);

    const products = list.map((p, i) => {
      const price = Math.max(1, Number(p.price) || 19.9);
      const compare = Number(p.compare_price);
      return {
        name: s(p.name, 90),
        price,
        comparePrice: compare > price ? compare : 0,
        category: s(p.category, 40) || 'Boutique',
        description: s(p.description, 500),
        features: (Array.isArray(p.features) ? p.features : []).map(f => s(f, 80)).filter(Boolean).slice(0, 4),
        rating: Math.round((4.4 + ((i * 7) % 6) / 10) * 10) / 10,   // exemples d'affichage, pas de vrais avis
        reviews: 24 + (i * 67) % 380,
        badge: ['Best-seller', 'Nouveau', 'Promo'].includes(p.badge) ? p.badge : '',
        image: images[i] || '',
        emoji: s(p.emoji, 4) || '🛍️'
      };
    });

    return res.status(200).json({
      name: s(raw.name, 60),
      tagline: s(raw.tagline, 140),
      about: s(raw.about, 600),
      heroTitle: s(raw.heroTitle, 90),
      heroSubtitle: s(raw.heroSubtitle, 200),
      heroImage,
      products,
      testimonials: Array.isArray(raw.testimonials) ? raw.testimonials.slice(0, 3) : [],
      trustPoints: Array.isArray(raw.trustPoints) ? raw.trustPoints.slice(0, 3) : []
    });
  } catch (err) {
    console.error('generate error:', err && err.message);
    return res.status(502).json({ error: 'Génération impossible pour le moment' });
  }
};
