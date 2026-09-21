// ClicBoutique — génération mono-produit
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const s=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const withTimeout=async(url,options={},ms=20000)=>{
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),ms);
  try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(timer)}
};
const cleanUrl=(u,base)=>{try{let x=String(u||'').replace(/&amp;/g,'&').replace(/\\u002F/g,'/').replace(/\\\//g,'/').trim();if(x.startsWith('//'))x='https:'+x;return new URL(x,base).href}catch{return ''}};
function extractImages(html,base){
  const out=[]; const add=u=>{const x=cleanUrl(u,base);if(/^https?:\/\//i.test(x)&&!/(logo|icon|avatar|sprite|placeholder)/i.test(x)&&!out.includes(x))out.push(x)};
  for(const m of html.matchAll(/<(?:meta|link)[^>]+>/gi)){
    const tag=m[0], prop=(tag.match(/(?:property|name)=["']([^"']+)["']/i)||[])[1]?.toLowerCase();
    if(prop==='og:image'||prop==='twitter:image'){const c=(tag.match(/content=["']([^"']+)["']/i)||[])[1];add(c)}
  }
  for(const m of html.matchAll(/(?:https?:)?\/\/[^"'<>\\\s]+/gi)){
    const u=m[0].replace(/\\u002F/g,'/').replace(/\\\//g,'/');
    if(/(?:alicdn|aliexpress-media|ae01)\./i.test(u)&&/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(u))add(u);
  }
  for(const m of html.matchAll(/["'](?:imageUrl|imagePath|image|url)["']\s*:\s*["']([^"']{30,700})["']/gi)) add(m[1]);
  return out.slice(0,30);
}
function fallback(page,style,url){
 return {brand:'ClicBoutique',announcement:'Une sélection pensée autour de votre produit',cta:'Acheter maintenant',
 about:'Une boutique dédiée à un seul produit, avec une présentation claire et soignée.',philosophy:'Un produit. Une expérience. Une présentation premium.',
 theme:style, product:{name:page.title||'Produit sélectionné',price:0,comparePrice:0,kicker:'Produit sélectionné',badge:'Nouveau',
 description:'Découvrez ce produit dans une boutique dédiée, conçue pour mettre en valeur ses photos et ses informations essentielles.',
 features:['Présentation claire','Galerie produit','Commande simplifiée'],reviews:'',images:page.images||[],image:(page.images||[])[0]||''},
 trust:[{title:'Présentation claire',text:'Toutes les informations essentielles au même endroit'},{title:'Galerie produit',text:'Les photos accessibles de la fiche produit'},{title:'Achat simple',text:'Un parcours direct vers le produit'}]};
}
module.exports=async function(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS')return res.status(204).end();
 if(req.method!=='POST')return res.status(405).json({error:'Méthode non autorisée'});
 const key=process.env.ANTHROPIC_API_KEY;
 if(!key)return res.status(500).json({error:'ANTHROPIC_API_KEY est manquante dans Vercel.'});
 let body=req.body;try{if(typeof body==='string')body=JSON.parse(body)}catch{}
 const productUrl=s(body?.productUrl,1200),style=s(body?.style,20)||'mini';
 if(!/^https?:\/\/[^\s]+$/i.test(productUrl))return res.status(400).json({error:'URL AliExpress invalide.'});
 let page={title:'Produit sélectionné',images:[]};
 try{
   const r=await withTimeout(productUrl,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36','accept-language':'fr-FR,fr;q=0.9,en;q=0.8','accept':'text/html,application/xhtml+xml'}},8000);
   if(r.ok){const html=await r.text();const title=(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)||html.match(/<title[^>]*>([^<]+)/i)||[])[1]||'';page.title=s(title.replace(/\s+/g,' '),140);page.images=extractImages(html,productUrl)}
 }catch{}
 const system=`Tu es le directeur artistique d'une boutique e-commerce mono-produit premium. Réponds UNIQUEMENT avec JSON valide, sans markdown.
Schéma: {"brand":"...","announcement":"...","cta":"Acheter maintenant","about":"...","philosophy":"...","product":{"name":"...","price":0,"comparePrice":0,"kicker":"...","badge":"...","description":"...","features":["..."],"reviews":"","images":[]},"trust":[{"title":"...","text":"..."}]}
Style: ${style}. Un seul produit. N'invente ni marque, certification, garantie, résultat médical ou caractéristique non fournie. Les avis non vérifiés doivent rester vides. Utilise les images fournies.`;
 try{
   const ar=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:1800,system,messages:[{role:'user',content:`URL: ${productUrl}\nTitre: ${page.title}\nImages: ${JSON.stringify(page.images)}\nCrée la boutique.`}]} )},18000);
   const raw=await ar.text();
   if(!ar.ok) throw new Error(`Anthropic HTTP ${ar.status}`);
   let d;try{d=JSON.parse(raw)}catch{throw new Error('Réponse Anthropic invalide')}
   const text=(d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
   const a=text.indexOf('{'),b=text.lastIndexOf('}');
   if(a<0||b<=a)throw new Error('JSON IA invalide');
   let shop=JSON.parse(text.slice(a,b+1));
   shop=Object.assign(fallback(page,style,productUrl),shop);
   shop.theme=style;shop.product=Object.assign(fallback(page,style,productUrl).product,shop.product||{});
   shop.product.images=[...(page.images||[]),...(Array.isArray(shop.product.images)?shop.product.images:[])].filter((x,i,a)=>x&&a.indexOf(x)===i).slice(0,30);
   shop.product.image=shop.product.images[0]||'';
   return res.status(200).json({shop,source:{imageCount:shop.product.images.length}});
 }catch(err){
   // Même si Claude échoue, renvoyer une boutique valide : l'utilisateur ne doit jamais recevoir "A server error".
   const shop=fallback(page,style,productUrl);
   return res.status(200).json({shop,warning:'La rédaction IA n’a pas pu être terminée ; la boutique a été générée avec les informations récupérées.'});
 }
};