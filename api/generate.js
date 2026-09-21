// ClicBoutique — fonction serveur (Vercel) : POST /api/generate  { niche, style }
//
// 1. Claude écrit le nom, les textes et la marque de la boutique.
// 2. Si CJ_API_KEY est configurée : de VRAIS produits (nom, photo, prix fournisseur) sont
//    sourcés chez CJ Dropshipping, et Claude écrit uniquement le texte marketing autour.
//    Sinon (ou si CJ échoue) : Claude invente les produits et Pexels/Pixabay fournit des
//    photos libres de droits du même type d'objet (mode précédent, en repli automatique).
// 3. Le JSON renvoyé est celui que clicboutique.html sait afficher.
//
// Variables d'environnement à définir dans Vercel :
//   ANTHROPIC_API_KEY  (obligatoire)  clé sur console.anthropic.com
//   CJ_API_KEY         (recommandée)  clé CJ Dropshipping → vrais produits/photos/prix réels
//   PEXELS_API_KEY     (photos)       clé gratuite sur pexels.com/api — utilisée en repli
//   PIXABAY_API_KEY    (photos)       alternative gratuite : pixabay.com/api/docs
//                                     (sans CJ ni Pexels/Pixabay, la boutique s'affiche avec des visuels de remplacement)
//   ALLOWED_ORIGIN     (recommandée)  ex. https://ton-site.com — limite qui peut appeler la fonction
//   CLAUDE_MODEL       (optionnelle)  défaut : claude-haiku-4-5-20251001 (rapide, tient dans les 30 s)

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 24000;
const PEXELS_TIMEOUT_MS = 6000;
const CJ_TIMEOUT_MS = 8000;
const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

// Jeton CJ mis en cache en mémoire (par instance serveur) : évite de redemander
// un token à chaque génération (CJ limite l'appel getAccessToken à 1 fois/5 min).
let cjTokenCache = { token: '', expiresAt: 0 };

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
  "heroKicker": "très courte accroche pour un badge au-dessus du titre, 2-4 mots (ex : « Édition automne », « Fait pour durer »)",
  "philosophy": "une phrase de marque forte et inspirante, 10-16 mots, ton éditorial (pas un simple résumé du tagline)",
  "about": "présentation de la boutique, 2 à 3 phrases, chaleureuses et concrètes",
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
      "image_query": "requête photo en anglais, 2-4 mots : l'objet SEUL, isolé, sans personne, sans mise en situation, comme une photo produit de catalogue (ex : « football shin guards », « gold ring », « yoga mat »), jamais une action ou une personne (jamais « man playing football », « woman wearing »)"
    }
  ],
  "testimonials": [{ "author": "Prénom + initiale", "rating": 5, "text": "avis crédible de 1-2 phrases" }],
  "trustPoints": [{ "title": "2-3 mots", "text": "5-8 mots" }]
}

Règles :
- Exactement 8 produits, répartis en 2 ou 3 catégories.
- TOUS les produits doivent appartenir directement à la niche demandée (ex. niche « protège tibia » : protège-tibias, chaussettes de maintien, sac de sport…), jamais un produit sans rapport.
- Chaque image_query désigne l'objet lui-même (jamais un mot abstrait comme « protection », « sport » ou « quality ») et contient toujours le mot-clé de la niche ou le nom exact du produit. Décris toujours l'objet seul, jamais une personne en train de l'utiliser ou de le porter.
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

// Cherche des photos (Pexels, sinon Pixabay) pour UNE requête.
// Renvoie { url, alt } pour permettre de vérifier que la photo correspond vraiment à la requête
// (Pexels/Pixabay renvoient parfois des résultats approximatifs pour une requête précise).
async function searchPhotos(query, orientation) {
  if (process.env.PEXELS_API_KEY) {
    const url = 'https://api.pexels.com/v1/search?per_page=15&orientation=' + orientation + '&query=' + encodeURIComponent(query);
    const r = await withTimeout(url, { headers: { Authorization: process.env.PEXELS_API_KEY } }, PEXELS_TIMEOUT_MS);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.photos || []).map(p => ({ url: p.src && p.src.large, alt: (p.alt || '').toLowerCase() }));
  }
  if (process.env.PIXABAY_API_KEY) {
    const url = 'https://pixabay.com/api/?key=' + encodeURIComponent(process.env.PIXABAY_API_KEY) +
      '&image_type=photo&safesearch=true&per_page=15&orientation=' + (orientation === 'landscape' ? 'horizontal' : 'all') +
      '&q=' + encodeURIComponent(query);
    const r = await withTimeout(url, {}, PEXELS_TIMEOUT_MS);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.hits || []).map(h => ({ url: orientation === 'landscape' ? h.largeImageURL : h.webformatURL, alt: (h.tags || '').toLowerCase() }));
  }
  return [];
}

// Mots qui trahissent une photo « en situation » avec une personne plutôt qu'un objet seul :
// on les pénalise dans le score pour privilégier les photos produit pur (fond neutre, objet seul).
const PEOPLE_WORDS = ['man', 'woman', 'men', 'women', 'person', 'people', 'player', 'boy', 'girl',
  'child', 'kid', 'model', 'holding', 'wearing', 'hand', 'hands', 'walking', 'running', 'standing', 'smiling'];

// Score une photo par rapport aux mots de la requête, à partir de sa légende/ses tags (quand l'API les fournit),
// en pénalisant les indices de présence humaine pour privilégier une vraie photo produit.
// Sans légende (Pexels y répond souvent par une chaîne vide), on garde la photo avec un score neutre :
// on préfère alors l'ordre de pertinence renvoyé par l'API plutôt que de la rejeter à tort.
function scorePhoto(photo, words) {
  if (!photo.alt) return 0;
  const match = words.reduce((n, w) => n + (photo.alt.includes(w) ? 1 : 0), 0);
  const penalty = PEOPLE_WORDS.reduce((n, w) => n + (photo.alt.includes(w) ? 1 : 0), 0);
  return match - penalty * 2;
}

// Essaie plusieurs requêtes de la plus précise à la plus générale, sans réutiliser deux fois la même photo.
// Renvoie jusqu'à `count` photos (pour une mini-galerie par produit), classées par pertinence décroissante ;
// si une requête ne suffit pas à remplir la galerie, on complète avec la requête suivante, plus générale.
async function findPhotos(queries, orientation, used, count) {
  const picks = [];
  for (const q of queries.filter(Boolean)) {
    if (picks.length >= count) break;
    try {
      const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const results = (await searchPhotos(q, orientation)).filter(p => p.url && !used.has(p.url));
      results.sort((a, b) => scorePhoto(b, words) - scorePhoto(a, words));
      for (const r of results) {
        if (picks.length >= count) break;
        used.add(r.url);
        picks.push(r.url);
      }
    } catch (e) { /* on essaie la requête suivante */ }
  }
  return picks;
}

async function findPhoto(queries, orientation, used) {
  return (await findPhotos(queries, orientation, used, 1))[0] || '';
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

// ---- CJ Dropshipping : vrais produits, vraies photos, vrai prix fournisseur ----
// N'est utilisé que si CJ_API_KEY est configurée dans Vercel. Sinon, on retombe
// automatiquement sur l'ancien mode (Claude invente les produits + photos Pexels/Pixabay).

async function getCJAccessToken() {
  const now = Date.now();
  if (cjTokenCache.token && cjTokenCache.expiresAt > now + 60000) return cjTokenCache.token;
  const r = await withTimeout(CJ_BASE + '/authentication/getAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ email: process.env.CJ_EMAIL, apiKey: process.env.CJ_API_KEY })
  }, CJ_TIMEOUT_MS);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.result || !j.data || !j.data.accessToken) {
    throw new Error('CJ auth échouée : HTTP ' + r.status + ' — ' + (j && (j.message || j.code) || 'réponse invalide'));
  }
  console.log('CJ auth OK, token obtenu');
  cjTokenCache = {
    token: j.data.accessToken,
    // On se garde une marge : token valable 15 jours, on le garde en cache 12h max par sécurité.
    expiresAt: now + 12 * 60 * 60 * 1000
  };
  return cjTokenCache.token;
}

// Cherche jusqu'à `count` produits réels chez CJ pour un mot-clé donné.
// Renvoie { pid, name, image, images, sellPrice } — tout vient réellement du catalogue CJ.
async function searchCJProducts(keyword, count) {
  const token = await getCJAccessToken();
  const url = CJ_BASE + '/product/listV2?page=1&size=' + Math.min(40, count * 5) +
    '&keyWord=' + encodeURIComponent(keyword);
  const r = await withTimeout(url, { headers: { 'CJ-Access-Token': token } }, CJ_TIMEOUT_MS);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.result) {
    throw new Error('CJ product search échouée : HTTP ' + r.status + ' — ' + (j && (j.message || j.code) || 'réponse invalide'));
  }
  // La forme exacte de la réponse varie selon les comptes CJ (list / content / data direct) :
  // on essaie les formes connues plutôt que de supposer une seule structure.
  const d = j.data;
  const list = Array.isArray(d) ? d : (d && (d.list || d.content || d.pageData || d.products)) || [];
  console.log('CJ search "' + keyword + '" → ' + list.length + ' résultat(s) bruts');
  return list
    .filter(p => p && p.productImage && (p.sellPrice || p.productSellPrice) && p.pid)
    .slice(0, count)
    .map(p => ({
      pid: p.pid,
      name: s(p.productNameEn || p.productName, 90),
      image: p.productImage,
      images: (p.productImageSet || []).slice(0, 4).length ? p.productImageSet.slice(0, 4) : [p.productImage],
      sellPrice: Number(p.sellPrice || p.productSellPrice) || 0
    }));
}

// Demande à Claude d'écrire uniquement le texte marketing (description, points forts,
// catégorie, badge) pour de VRAIS produits déjà trouvés chez CJ — jamais le nom, jamais le prix,
// jamais la photo : ceux-là restent exactement ceux du fournisseur.
async function askClaudeCopyForRealProducts(niche, style, cjProducts) {
  const sys = `Tu es un expert e-commerce francophone. On te donne une liste de VRAIS produits réels (nom déjà fixé).
Pour CHACUN, écris uniquement : une catégorie courte (parmi 2-3 au total), une description vendeuse de 2 phrases,
3 points forts courts, un badge parmi "Best-seller"|"Nouveau"|"Promo"|"" et 1 emoji.
Réponds UNIQUEMENT avec un tableau JSON, un objet par produit, dans le MÊME ORDRE que la liste reçue :
[{"category":"...","description":"...","features":["...","...","..."],"badge":"...","emoji":"..."}]
Aucun texte autour, aucune balise markdown. N'invente ni nom, ni prix, ni certification/allégation santé.`;
  const userMsg = `Niche : ${niche}\nStyle : ${style}\nProduits (nom réel, ne pas modifier) :\n` +
    cjProducts.map((p, i) => (i + 1) + '. ' + p.name).join('\n');
  const r = await withTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: sys, messages: [{ role: 'user', content: userMsg }] })
  }, CLAUDE_TIMEOUT_MS);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('Copie IA sans JSON');
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
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { body = {}; }
  const niche = s(body && body.niche, 120).replace(/[\u0000-\u001f]/g, ' ');
  const style = ['mini', 'color', 'lux'].includes(body && body.style)
    ? { mini: 'minimaliste', color: 'coloré', lux: 'luxe' }[body.style] : 'minimaliste';
  if (niche.length < 2) return res.status(400).json({ error: 'Niche manquante' });

  try {
    const raw = await askClaude(niche, style);
    const keyword = s(raw.niche_keyword, 40);
    let products = [];
    let usedRealSupplier = false;

    // 1) Mode "vrais produits" : si CJ_API_KEY est configurée, on essaie de sourcer
    //    de vrais articles réels chez CJ Dropshipping (nom, photo et prix fournisseur réels).
    if (process.env.CJ_API_KEY) {
      try {
        const cjList = await searchCJProducts(keyword || niche, 8);
        if (cjList.length >= 3) {
          const copy = await askClaudeCopyForRealProducts(niche, style, cjList);
          products = cjList.map((p, i) => {
            const c = copy[i] || {};
            const cost = p.sellPrice;
            // Marge : ~2.4x le prix fournisseur, arrondi à ,90 — à ajuster selon ta marge voulue.
            const price = Math.max(cost + 1, Math.round(cost * 2.4) - 0.1);
            return {
              name: p.name,
              price: Math.round(price * 100) / 100,
              comparePrice: 0,
              category: s(c.category, 40) || 'Boutique',
              description: s(c.description, 500),
              features: (Array.isArray(c.features) ? c.features : []).map(f => s(f, 80)).filter(Boolean).slice(0, 4),
              rating: Math.round((4.4 + ((i * 7) % 6) / 10) * 10) / 10,
              reviews: 24 + (i * 67) % 380,
              badge: ['Best-seller', 'Nouveau', 'Promo'].includes(c.badge) ? c.badge : '',
              image: p.image,
              images: p.images,
              emoji: s(c.emoji, 4) || '🛍️',
              supplierPid: p.pid   // à retrouver dans "My CJ" pour commander/vérifier l'article
            };
          });
          usedRealSupplier = true;
        } else {
          console.log('CJ : seulement ' + cjList.length + ' produit(s) valide(s) pour "' + (keyword || niche) + '" (3 minimum requis) — repli sur le mode précédent');
        }
      } catch (e) {
        console.error('CJ sourcing error (repli sur le mode précédent):', e && e.message);
      }
    }

    // 2) Repli : pas de CJ_API_KEY, ou CJ a échoué, ou pas assez de résultats pour cette niche
    //    → on garde l'ancien mode (Claude invente les produits + photos Pexels/Pixabay).
    let heroImage = '';
    if (!usedRealSupplier) {
      const list = (Array.isArray(raw.products) ? raw.products : []).filter(p => p && p.name).slice(0, 8);
      if (list.length < 3) throw new Error('Pas assez de produits');
      const used = new Set();
      const heroPromise = findPhoto([withKeyword(s(raw.hero_query, 60), keyword), keyword], 'landscape', used);
      const galleryPromises = list.map(p =>
        findPhotos([withKeyword(s(p.image_query, 60), keyword) + ' product photo', withKeyword(s(p.image_query, 60), keyword), keyword], 'square', used, 4)
      );
      const [hero, ...galleries] = await Promise.all([heroPromise, ...galleryPromises]);
      heroImage = hero;
      products = list.map((p, i) => {
        const price = Math.max(1, Number(p.price) || 19.9);
        const compare = Number(p.compare_price);
        const gallery = galleries[i] || [];
        return {
          name: s(p.name, 90),
          price,
          comparePrice: compare > price ? compare : 0,
          category: s(p.category, 40) || 'Boutique',
          description: s(p.description, 500),
          features: (Array.isArray(p.features) ? p.features : []).map(f => s(f, 80)).filter(Boolean).slice(0, 4),
          rating: Math.round((4.4 + ((i * 7) % 6) / 10) * 10) / 10,
          reviews: 24 + (i * 67) % 380,
          badge: ['Best-seller', 'Nouveau', 'Promo'].includes(p.badge) ? p.badge : '',
          image: gallery[0] || '',
          images: gallery,
          emoji: s(p.emoji, 4) || '🛍️'
        };
      });
    } else {
      // Bannière : on prend la photo du produit vedette CJ, à défaut Pexels/Pixabay.
      heroImage = products[0] && products[0].image
        ? products[0].image
        : await findPhoto([withKeyword(s(raw.hero_query, 60), keyword), keyword], 'landscape', new Set());
    }

    return res.status(200).json({
      name: s(raw.name, 60),
      tagline: s(raw.tagline, 140),
      heroKicker: s(raw.heroKicker, 40),
      philosophy: s(raw.philosophy, 160),
      about: s(raw.about, 600),
      heroTitle: s(raw.heroTitle, 90),
      heroSubtitle: s(raw.heroSubtitle, 200),
      heroImage,
      products,
      realSupplier: usedRealSupplier,
      sourcingNote: usedRealSupplier
        ? 'Produits réels sourcés chez CJ Dropshipping.'
        : 'Repli sur le mode précédent (IA + photos stock) — vérifie les logs Vercel pour la cause exacte si CJ_API_KEY est configurée.',
      testimonials: Array.isArray(raw.testimonials) ? raw.testimonials.slice(0, 3) : [],
      trustPoints: Array.isArray(raw.trustPoints) ? raw.trustPoints.slice(0, 3) : []
    });
  } catch (err) {
    console.error('generate error:', err && err.message);
    return res.status(502).json({ error: 'Génération impossible pour le moment' });
  }
};
