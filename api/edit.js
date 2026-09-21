// ClicBoutique — fonction serveur (Vercel) : POST /api/edit  { instruction, shop }
//
// Le chat de l'aperçu envoie ici la demande de la personne + l'état de la boutique.
// Claude répond avec une liste de modifications (couleurs, textes, produits, prix, photos…),
// que le site vérifie puis applique. Les nouvelles photos sont cherchées ici (Pexels / Pixabay).
//
// Mêmes variables d'environnement que generate.js :
//   ANTHROPIC_API_KEY, PEXELS_API_KEY ou PIXABAY_API_KEY, ALLOWED_ORIGIN, CLAUDE_MODEL

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 20000;
const PHOTO_TIMEOUT_MS = 5000;

// Anti-abus simple (en mémoire, par instance) : 40 demandes / 10 min / adresse IP.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 40;
}

const SYSTEM = `Tu es l'assistant qui modifie une boutique en ligne pour son propriétaire. Tu reçois l'état actuel de la boutique et une demande de modification.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown :
{ "reply": "1 à 2 phrases en français, sur un ton simple, qui disent ce que tu as fait", "ops": [ ... ] }

Opérations possibles (« ops ») :
- {"op":"theme","value":"mini|color|lux"}                     style général (minimaliste, coloré, luxe)
- {"op":"colors","accent":"#rrggbb","bg":"#rrggbb","fg":"#rrggbb"}   couleurs personnalisées (toutes les clés sont facultatives ; accent = boutons, badges, liens ; bg = fond ; fg = texte)
- {"op":"colors","reset":true}                                retour aux couleurs du style
- {"op":"text","field":"name|tagline|about|heroTitle|heroSubtitle|promoText","value":"..."}
- {"op":"banner","value":true|false}                          bandeau promo en haut (le texte se change avec field promoText)
- {"op":"testimonials","value":true|false}                    section avis clients
- {"op":"product_update","index":0,"fields":{"name","price","comparePrice","category","description","features":[...],"badge","emoji"}}
- {"op":"product_add","product":{"name","price","category","description","features":[3 points],"badge","emoji","image_query"}}
- {"op":"product_remove","index":2}
- {"op":"image","target":"hero" ou un numéro de produit,"query":"requête photo en anglais, 2 à 4 mots, le nom exact de l'objet"}

Règles :
- Fais uniquement ce qui est demandé, sans toucher au reste.
- Les numéros de produits (index) sont ceux de la liste fournie, avant toute modification. Ne les décale pas.
- Prix en euros (nombre). Textes en français, sauf si la personne demande une autre langue.
- Pour changer une couleur, choisis un code hexadécimal précis et lisible (ex : rouge → #d62828, bleu marine → #0b2545).
- Un produit ajouté doit être réaliste et cohérent avec la boutique, avec un « image_query » précis.
- Pas de marque existante, de label ou de certification, ni de promesse de santé inventés.
- Maximum 14 opérations.
- Si la demande est impossible ici (paiement, nom de domaine, livraison réelle, ajouter une page, envoyer une image depuis l'ordinateur, code…), mets "ops": [] et explique en une phrase ce que tu peux faire à la place.
- Si la demande est ambiguë, fais le choix le plus raisonnable et dis-le dans « reply ».`;

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

async function findPhoto(query, orientation) {
  if (!query) return '';
  try {
    if (process.env.PEXELS_API_KEY) {
      const url = 'https://api.pexels.com/v1/search?per_page=3&orientation=' + orientation + '&query=' + encodeURIComponent(query);
      const r = await withTimeout(url, { headers: { Authorization: process.env.PEXELS_API_KEY } }, PHOTO_TIMEOUT_MS);
      if (!r.ok) return '';
      const j = await r.json();
      return (j.photos && j.photos[0] && j.photos[0].src && j.photos[0].src.large) || '';
    }
    if (process.env.PIXABAY_API_KEY) {
      const url = 'https://pixabay.com/api/?key=' + encodeURIComponent(process.env.PIXABAY_API_KEY) +
        '&image_type=photo&safesearch=true&per_page=3&orientation=' + (orientation === 'landscape' ? 'horizontal' : 'all') +
        '&q=' + encodeURIComponent(query);
      const r = await withTimeout(url, {}, PHOTO_TIMEOUT_MS);
      if (!r.ok) return '';
      const j = await r.json();
      const h = j.hits && j.hits[0];
      return h ? (orientation === 'landscape' ? h.largeImageURL : h.webformatURL) : '';
    }
  } catch (e) { /* pas de photo */ }
  return '';
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
  const instruction = s(body && body.instruction, 500).replace(/[\u0000-\u001f]/g, ' ');
  const shop = body && body.shop;
  if (instruction.length < 2 || !shop || !Array.isArray(shop.products)) return res.status(400).json({ error: 'Demande invalide' });

  // état de la boutique, compacté pour rester rapide
  const state = {
    name: s(shop.name, 60), tagline: s(shop.tagline, 140), about: s(shop.about, 300),
    heroTitle: s(shop.heroTitle, 90), heroSubtitle: s(shop.heroSubtitle, 200), promoText: s(shop.promoText, 100),
    style: s(shop.theme, 10), customColors: shop.colors || null, bannerVisible: !!(shop.opts && shop.opts.banner), testimonialsVisible: !!(shop.opts && shop.opts.testi),
    products: shop.products.slice(0, 12).map((p, i) => ({
      index: i, name: s(p.name, 90), price: Number(p.price) || 0, comparePrice: Number(p.comparePrice) || 0,
      category: s(p.category, 40), badge: s(p.badge, 14), description: s(p.description, 140)
    }))
  };

  try {
    const r = await withTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        system: SYSTEM,
        messages: [{ role: 'user', content: 'Boutique actuelle :\n' + JSON.stringify(state) + '\n\nDemande : ' + instruction }]
      })
    }, CLAUDE_TIMEOUT_MS);
    if (!r.ok) throw new Error('Claude HTTP ' + r.status);
    const data = await r.json();
    const out = extractJson((data.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));

    const ops = Array.isArray(out.ops) ? out.ops.filter(o => o && typeof o.op === 'string').slice(0, 14) : [];
    let missingPhoto = false;

    // Les demandes de photos sont résolues ici : on renvoie des URL, jamais de recherche à faire côté site
    const resolved = await Promise.all(ops.map(async o => {
      if (o.op === 'image') {
        const url = await findPhoto(s(o.query, 60), o.target === 'hero' ? 'landscape' : 'square');
        if (!url) { missingPhoto = true; return null; }
        return { op: 'image', target: o.target, url };
      }
      if (o.op === 'product_add' && o.product) {
        const url = await findPhoto(s(o.product.image_query, 60) || s(o.product.name, 60), 'square');
        if (!url && o.product.image_query) missingPhoto = true;
        const { image_query, ...product } = o.product;
        return { op: 'product_add', product: { ...product, image: url } };
      }
      return o;
    }));

    let reply = s(out.reply, 400);
    if (missingPhoto) reply += ' Je n\'ai pas trouvé de photo adaptée pour certaines images.';
    return res.status(200).json({ reply, ops: resolved.filter(Boolean) });
  } catch (err) {
    console.error('edit error:', err && err.message);
    return res.status(502).json({ error: 'Modification impossible pour le moment' });
  }
};
