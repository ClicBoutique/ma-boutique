// ClicBoutique — génération mono-produit
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const s=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const withTimeout=async(url,options={},ms=20000)=>{
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),ms);
  try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(timer)}
};
function decode(v){
  return String(v||'')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\\u002F/gi,'/').replace(/\\u0026/g,'&').replace(/\\\//g,'/')
    .replace(/\\"/g,'"');
}
function cleanUrl(u,base){
  try{
    let x=decode(u).trim().replace(/^['"]|['"]$/g,'');
    if(x.startsWith('//')) x='https:'+x;
    if(x.startsWith('www.')) x='https://'+x;
    return new URL(x,base).href;
  }catch{return ''}
}
function extractImages(html,base){
  const out=[];
  const add=(u)=>{
    const x=cleanUrl(u,base);
    if(!/^https?:\/\//i.test(x)) return;
    if(!/(alicdn|aliexpress|ae01|alicdn\.com)/i.test(x)) return;
    if(/\.(?:mp4|webm|gif)(?:[?#]|$)/i.test(x)) return;
    if(/(logo|icon|avatar|sprite|placeholder|loading|shop-logo)/i.test(x)) return;
    if(!out.includes(x)) out.push(x);
  };
  const h=decode(html);

  // OG/Twitter + JSON-LD.
  for(const m of h.matchAll(/<(?:meta|link)[^>]+>/gi)){
    const tag=m[0];
    const prop=(tag.match(/(?:property|name)=["']([^"']+)["']/i)||[])[1]?.toLowerCase();
    if(prop==='og:image'||prop==='twitter:image'){
      const c=(tag.match(/content=["']([^"']+)["']/i)||[])[1]; add(c);
    }
  }
  for(const m of h.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{
      const obj=JSON.parse(m[1].trim());
      const walk=(x)=>{
        if(!x||typeof x!=='object') return;
        if(typeof x.image==='string') add(x.image);
        if(Array.isArray(x.image)) x.image.forEach(add);
        Object.values(x).forEach(walk);
      };
      walk(obj);
    }catch{}
  }

  // HTML image tags, src/srcset/data-src.
  for(const m of h.matchAll(/<(?:img|source)[^>]+>/gi)){
    const tag=m[0];
    for(const attr of ['src','data-src','data-original','data-lazy-src']){
      const v=(tag.match(new RegExp(attr+"=[\"']([^\"']+)[\"']","i"))||[])[1];
      if(v) add(v);
    }
    const ss=(tag.match(/srcset=["']([^"']+)["']/i)||[])[1];
    if(ss) ss.split(',').forEach(x=>add(x.trim().split(/\s+/)[0]));
  }

  // AliExpress embedded state commonly contains imagePathList/imageUrlList/skuImages.
  const keys=['imagePathList','imageUrlList','skuImages','images','imageList','galleryImages'];
  for(const key of keys){
    const re=new RegExp("[\"']"+key+"[\"']\\s*:\\s*\\[([\\s\\S]{0,20000}?)\\]","gi");
    for(const m of h.matchAll(re)){
      for(const u of m[1].matchAll(/["']([^"']{25,800})["']/g)) add(u[1]);
    }
  }

  // Last-resort: any escaped or normal AliExpress CDN image URL.
  const urlRe=/(?:https?:)?(?:\\\/\\\/|\/\/)[^"'<>\\\s]+/gi;
  for(const m of h.matchAll(urlRe)){
    let u=decode(m[0]);
    if(/(?:alicdn|ae01|aliexpress)/i.test(u) && /\.(?:jpe?g|png|webp)(?:[?#&]|$)/i.test(u)) add(u);
  }

  // Deduplicate variants that only differ by CDN resizing parameters.
  return out.map(u=>u.replace(/_\.webp(?=$|\?)/i,'.webp')).slice(0,40);
}
function proxyImages(images){
  return images.map(u=>'/api/image?url='+encodeURIComponent(u));
}
function fallback(page,style,url){
 return {brand:'ClicBoutique',announcement:'Une sélection pensée autour de votre produit',cta:'Acheter maintenant',
 about:'Une boutique dédiée à un seul produit, avec une présentation claire et soignée.',philosophy:'Un produit. Une expérience. Une présentation premium.',
 theme:style, product:{name:page.title||'Produit sélectionné',price:0,comparePrice:0,kicker:'Produit sélectionné',badge:'Nouveau',
 description:'Découvrez ce produit dans une boutique dédiée, conçue pour mettre en valeur ses photos et ses informations essentielles.',
 features:[{title:'Présentation claire',text:'Toutes les informations essentielles au même endroit'},{title:'Galerie produit',text:'Les photos disponibles de la fiche produit'},{title:'Achat simple',text:'Un parcours direct vers le produit'}],
 reviews:[],images:proxyImages(page.images||[]),image:proxyImages(page.images||[])[0]||''},
 trust:[{title:'Présentation claire',text:'Toutes les informations essentielles au même endroit'},{title:'Galerie produit',text:'Les photos accessibles de la fiche produit'},{title:'Achat simple',text:'Un parcours direct vers le produit'}],productUrl:url};
}
module.exports=async function(req,res){
 try{
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
   const r=await withTimeout(productUrl,{headers:{
     'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
     'accept-language':'fr-FR,fr;q=0.9,en;q=0.8','accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
   }},8000);
   if(r.ok){
     const html=await r.text();
     const title=(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)||html.match(/<title[^>]*>([^<]+)/i)||[])[1]||'';
     page.title=s(decode(title).replace(/\s+/g,' '),140);
     shop.product.images=proxyImages(all);
   }
 }catch{}
 const originalImages=page.images.slice(0,40);
 const promptImages=originalImages;
 const system=`Tu es le directeur artistique d'une boutique e-commerce mono-produit premium.

Réponds UNIQUEMENT avec du JSON valide.

RÈGLE ABSOLUE POUR LES IMAGES :
- Les images fournies dans "Images récupérées" sont les vraies images du fournisseur.
- Tu DOIS les conserver.
- Tu ne dois JAMAIS inventer d'URL d'image.
- Tu ne dois JAMAIS remplacer une image fournisseur par une image générique.
- Tu dois utiliser les images récupérées comme galerie officielle du produit.
- Toutes les images récupérées doivent être conservées dans product.images dans le même ordre.
- Si plusieurs images sont disponibles, conserve-les toutes.
- Le premier élément doit être l'image principale.

Schéma:
{"brand":"...","announcement":"...","cta":"Acheter maintenant","about":"...","philosophy":"...","product":{"name":"...","price":0,"comparePrice":0,"kicker":"...","badge":"...","description":"...","features":[{"title":"...","text":"..."}],"reviews":[],"images":[]},"trust":[{"title":"...","text":"..."}]}

Style: ${style}.
Un seul produit.
N'invente ni marque, certification, garantie, résultat médical ou caractéristique non fournie.
Les avis non vérifiés doivent rester vides.`;
 try{
   const ar=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:2200,system,messages:[{role:'user',content:`URL: ${productUrl}\nTitre: ${page.title}\nImages récupérées: ${JSON.stringify(promptImages)}\nCrée la boutique.`}]} )},18000);
   const raw=await ar.text();
   if(!ar.ok) throw new Error(`Anthropic HTTP ${ar.status}`);
   let d;try{d=JSON.parse(raw)}catch{throw new Error('Réponse Anthropic invalide')}
   const text=(d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
   const a=text.indexOf('{'),b=text.lastIndexOf('}');
   if(a<0||b<=a)throw new Error('JSON IA invalide');
   let shop=JSON.parse(text.slice(a,b+1));
   shop=Object.assign(fallback(page,style,productUrl),shop);
   shop.theme=style;
   shop.product=Object.assign(fallback(page,style,productUrl).product,shop.product||{});
   const all=[...originalImages,...(Array.isArray(shop.product.images)?shop.product.images:[])].filter((x,i,a)=>x&&a.indexOf(x)===i).slice(0,40);
   shop.product.images=proxyImages(all);
   shop.product.image=shop.product.images[0]||'';
   shop.productUrl=productUrl;
   return res.status(200).json({shop,source:{imageCount:all.length}});
 }catch(err){
   console.error('ClicBoutique generate error:', err?.stack || err?.message || err);
   const shop=fallback(page,style,productUrl);
   return res.status(200).json({shop,warning:'La rédaction IA n’a pas pu être terminée ; la boutique a été générée avec les informations récupérées.',source:{imageCount:page.images.length}});
 }
 }catch(err){
  console.error('ClicBoutique generate fatal:', err?.stack || err?.message || err);
  if(!res.headersSent) return res.status(500).json({error:'Erreur serveur pendant la génération.',detail:process.env.NODE_ENV==='development' ? String(err?.message||err) : undefined});
 }
};
