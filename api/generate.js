// ClicBoutique — POST /api/generate { productUrl, style }
// Variables Vercel: ANTHROPIC_API_KEY (obligatoire), CLAUDE_MODEL (optionnelle)
const MODEL=process.env.CLAUDE_MODEL||'claude-haiku-4-5-20251001';
const TIMEOUT=22000;
const s=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const withTimeout=async(url,options={},ms=TIMEOUT)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(t)}};
function jsonFrom(t){const a=t.indexOf('{'),b=t.lastIndexOf('}');if(a<0||b<=a)throw Error('JSON invalide');return JSON.parse(t.slice(a,b+1))}
function abs(u,base){try{return new URL(u,base).href}catch{return ''}}
function extract(html,base){
 const title=(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)||html.match(/<title[^>]*>([^<]+)/i)||[])[1]||'';
 const imgs=[];const push=u=>{u=abs(String(u||'').replace(/&amp;/g,'&'),base);if(/^https?:\/\//i.test(u)&&!imgs.includes(u))imgs.push(u)};
 for(const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/gi))push(m[1]);
 for(const m of html.matchAll(/https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi))push(m[0]);
 for(const m of html.matchAll(/["'](?:imageUrl|imagePath|image)["']\s*:\s*["']([^"']{20,500})["']/gi))push(m[1]);
 return {title:s(title.replace(/\s+/g,' '),140),images:imgs.slice(0,24)};
}
const SYSTEM=`Tu es le directeur artistique d'une marque e-commerce premium. Tu reçois UNE fiche produit AliExpress et dois créer le contenu d'une boutique dédiée à ce seul produit.
Réponds UNIQUEMENT avec un objet JSON valide.
Schéma exact:
{"brand":"2 mots","announcement":"phrase courte","cta":"Acheter maintenant","about":"2 phrases","philosophy":"1 phrase","product":{"name":"nom précis","price":29.9,"comparePrice":0,"kicker":"2-4 mots","badge":"Nouveau ou Offre ou vide","description":"2-3 phrases","features":["3 à 5 points factuels"],"reviews":"4,8 · 126 avis","images":[]},"trust":[{"title":"2-3 mots","text":"5-8 mots"},{"title":"2-3 mots","text":"5-8 mots"},{"title":"2-3 mots","text":"5-8 mots"}]}
Règles: UN SEUL produit. Ne crée jamais de second produit, de catalogue, de catégorie ou de niche. N'invente pas de marque, certification, résultat médical, garantie ou caractéristique non fournie. Si le prix est inconnu, mets 0. Utilise les images fournies si elles sont accessibles. Le style demandé est une direction artistique, pas une raison pour inventer des informations produit. Texte en français.`;
module.exports=async function(req,res){
 res.setHeader('Access-Control-Allow-Origin',process.env.ALLOWED_ORIGIN||'*');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'Méthode non autorisée'});if(!process.env.ANTHROPIC_API_KEY)return res.status(500).json({error:'ANTHROPIC_API_KEY manquante'});
 let body=req.body;try{if(typeof body==='string')body=JSON.parse(body)}catch{body={}};
 const productUrl=s(body?.productUrl,1000),style=s(body?.style,20)||'mini';
 if(!/^https?:\/\/[^\s]+/i.test(productUrl))return res.status(400).json({error:'URL produit invalide'});
 let page={title:'Produit sélectionné',images:[]};
 try{const r=await withTimeout(productUrl,{headers:{'user-agent':'Mozilla/5.0 (compatible; ClicBoutique/1.0)','accept-language':'fr-FR,fr;q=0.9,en;q=0.8'}},9000);if(r.ok)page=extract(await r.text(),productUrl)}catch(e){}
 let ai;
 try{const r=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:1800,system:SYSTEM,messages:[{role:'user',content:'URL produit: '+productUrl+'\nTitre récupéré: '+page.title+'\nImages récupérées: '+JSON.stringify(page.images)+'\nStyle choisi: '+style+'\nCrée la boutique mono-produit.'}]})});if(!r.ok)throw Error('Claude HTTP '+r.status);const d=await r.json();ai=jsonFrom((d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''));
 }catch(e){ai={brand:'Studio Produit',announcement:'Sélection du moment',cta:'Acheter maintenant',about:'Une présentation claire et soignée, pensée autour de cet article.',philosophy:'Un seul produit, présenté avec exigence.',trust:[{title:'Commande simple',text:'Une page dédiée à cet article'},{title:'Présentation claire',text:'Les informations essentielles au même endroit'},{title:'Design premium',text:'Une expérience pensée pour vendre'}],product:{name:page.title||'Produit sélectionné',price:0,comparePrice:0,kicker:'Produit sélectionné',badge:'',description:'Découvrez cet article dans une boutique dédiée, conçue pour mettre en valeur ses détails.',features:['Présentation claire','Sélection produit','Commande simplifiée'],reviews:'',images:[]}}}
 ai.product=ai.product||{};ai.product.name=s(ai.product.name,140)||page.title||'Produit sélectionné';ai.product.images=[...(page.images||[]),...(Array.isArray(ai.product.images)?ai.product.images:[])].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(0,24);ai.product.image=ai.product.images[0]||'';ai.product.features=Array.isArray(ai.product.features)?ai.product.features.slice(0,5):[];ai.product.price=Number(ai.product.price)||0;ai.product.comparePrice=Number(ai.product.comparePrice)||0;ai.brand=s(ai.brand,50)||'Studio Produit';ai.announcement=s(ai.announcement,100)||'Produit sélectionné';ai.cta=s(ai.cta,40)||'Acheter maintenant';ai.theme=style;return res.status(200).json({shop:ai,source:{url:productUrl,title:page.title,imageCount:ai.product.images.length}});
};
