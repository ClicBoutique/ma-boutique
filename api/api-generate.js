// ClicBoutique — génération mono-produit + récupération des vraies images fournisseur
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const s=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const withTimeout=async(url,options={},ms=20000)=>{
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),ms);
  try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(timer)}
};
function decode(v){
  return String(v||'')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&#x2F;/gi,'/').replace(/&#x26;/gi,'&')
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
function normalizeImageUrl(u){
  let x=String(u||'').trim();
  x=x.replace(/\\u002F/gi,'/').replace(/\\\//g,'/').replace(/&amp;/g,'&');
  // AliExpress can expose CDN URLs with protocol-relative or escaped forms.
  if(x.startsWith('//')) x='https:'+x;
  if(x.startsWith('https:/')&&!x.startsWith('https://')) x=x.replace(/^https:\/+/,'https://');
  return x;
}
function imageScore(u){
  let score=0;
  if(/alicdn|ae01|aliexpress/i.test(u)) score+=5;
  if(/\.jpe?g|\.png|\.webp/i.test(u)) score+=3;
  if(/(product|goods|item|sku|gallery|image)/i.test(u)) score+=2;
  if(/(logo|icon|avatar|sprite|placeholder|loading|shop-logo|favicon)/i.test(u)) score-=20;
  if(/\.(?:mp4|webm|gif)(?:[?#]|$)/i.test(u)) score-=20;
  return score;
}
function extractImages(html,base){
  const found=new Map();
  const add=(raw,source='unknown')=>{
    let u=normalizeImageUrl(raw);
    if(!u) return;
    const x=cleanUrl(u,base);
    if(!/^https?:\/\//i.test(x)) return;
    if(!/(alicdn|aliexpress|ae01)/i.test(x)) return;
    if(/\.(?:mp4|webm|gif)(?:[?#]|$)/i.test(x)) return;
    if(/(logo|icon|avatar|sprite|placeholder|loading|shop-logo|favicon)/i.test(x)) return;
    // Remove obvious tracking fragments but keep CDN resizing/query parameters otherwise.
    const key=x.replace(/[?#].*$/,'').replace(/_\.(?:webp|jpg|jpeg|png)$/i,m=>m.toLowerCase());
    const score=imageScore(x)+(source==='json'?2:source==='meta'?1:0);
    const prev=found.get(key);
    if(!prev || score>prev.score) found.set(key,{url:x,score});
  };
  const h=decode(html);

  // 1) OpenGraph / Twitter / image metadata.
  for(const m of h.matchAll(/<(?:meta|link)[^>]+>/gi)){
    const tag=m[0];
    const prop=(tag.match(/(?:property|name)=['"]([^'"]+)['"]/i)||[])[1]?.toLowerCase();
    if(['og:image','og:image:url','twitter:image','twitter:image:src'].includes(prop)){
      const c=(tag.match(/content=['"]([^'"]+)['"]/i)||[])[1]; if(c) add(c,'meta');
    }
  }

  // 2) JSON-LD, including nested image arrays.
  for(const m of h.matchAll(/<script[^>]+type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi)){
    try{
      const obj=JSON.parse(m[1].trim());
      const walk=(x)=>{
        if(!x||typeof x!=='object') return;
        if(typeof x.image==='string') add(x.image,'json');
        if(Array.isArray(x.image)) x.image.forEach(v=>typeof v==='string'?add(v,'json'):walk(v));
        if(typeof x.url==='string' && /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(x.url)) add(x.url,'json');
        Object.values(x).forEach(walk);
      };
      walk(obj);
    }catch{}
  }

  // 3) HTML image/source tags and every common lazy-load attribute.
  for(const m of h.matchAll(/<(?:img|source)[^>]+>/gi)){
    const tag=m[0];
    for(const attr of ['src','data-src','data-original','data-lazy-src','data-ks-lazyload','data-image-src','data-original-src','data-zoom-image','data-large-image']){
      const re=new RegExp(attr+"=['\"]([^'\"]+)['\"]","i");
      const v=(tag.match(re)||[])[1]; if(v) add(v,'tag');
    }
    const ss=(tag.match(/(?:srcset|data-srcset)=['"]([^'"]+)['"]/i)||[])[1];
    if(ss) ss.split(',').forEach(x=>add(x.trim().split(/\s+/)[0],'srcset'));
  }

  // 4) AliExpress embedded state: product galleries, SKU images and image lists.
  const keys=['imagePathList','imageUrlList','skuImages','images','imageList','galleryImages','mainImages','detailImages','productImages','imagePath','imageUrls'];
  for(const key of keys){
    const re=new RegExp("[\\\"']"+key+"[\\\"']\\s*:\\s*(?:\\[|\\\")([\\s\\S]{0,50000}?)","gi");
    for(const m of h.matchAll(re)){
      const chunk=m[0];
      for(const u of chunk.matchAll(/https?:\/\/[^"'<>\s]+/gi)) add(u[0],'json');
      for(const u of chunk.matchAll(/["']([^"']{20,1200})["']/g)){
        if(/(?:alicdn|ae01|aliexpress)/i.test(u[1])) add(u[1],'json');
      }
    }
  }

  // 5) Last-resort scan of the whole HTML for CDN image URLs, including escaped JSON URLs.
  const urlRe=/https?:\/\/[^"'<>\s]+/gi;
  for(const m of h.matchAll(urlRe)){
    const u=decode(m[0]);
    if(/(?:alicdn|ae01|aliexpress)/i.test(u) && /\.(?:jpe?g|png|webp)(?:[?#&]|$)/i.test(u)) add(u,'scan');
  }

  // Keep supplier images only, ranked by relevance, capped at 40.
  return [...found.values()]
    .sort((a,b)=>b.score-a.score)
    .map(x=>x.url)
    .slice(0,40);
}
function proxyImages(images){
  // Passe par notre endpoint image pour éviter les blocages de hotlink/referrer.
  return [...new Set(images)].filter(Boolean).map(u=>'/api/image?url='+encodeURIComponent(u));
}
function fallback(page,style,url){
 const images=[...new Set(page.images||[])].slice(0,40);
 const proxied=proxyImages(images);
 const product={
   name:page.title||'Produit sélectionné', price:0, comparePrice:0, kicker:'Produit sélectionné', badge:'Nouveau',
   description:'Découvrez ce produit dans une boutique dédiée, conçue pour mettre en valeur les photos et les informations essentielles de sa fiche fournisseur.',
   features:['Présentation claire','Galerie complète des photos fournisseur','Parcours d’achat simple'],
   reviews:[], images:proxied, image:proxied[0]||'', sourceImages:images, sourceUrl:url,
   category:'Produit', emoji:'✦'
 };
 return {
   brand:'ClicBoutique', announcement:'Une présentation premium pensée autour de votre produit', cta:'Acheter maintenant',
   about:'Une boutique mono-produit construite autour de la fiche fournisseur et de ses visuels.',
   philosophy:'Un produit. Une expérience. Une présentation premium.', theme:style,
   product, products:[product], sourceUrl:url, sourceImages:images, realSupplier:images.length>0,
   trustPoints:[
     {title:'Photos fournisseur',text:'Les visuels disponibles sur la fiche source sont conservés.'},
     {title:'Fiche dédiée',text:'Toute la boutique est construite autour de cet article.'},
     {title:'Expérience premium',text:'Galerie immersive et présentation claire.'}
   ]
 };
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
     'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36',
     'accept-language':'fr-FR,fr;q=0.9,en;q=0.8','accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
   }},15000);
   if(r.ok){
     const html=await r.text();
     const title=(html.match(/<meta[^>]+property=['"]og:title['"][^>]+content=['"]([^'"]+)/i)||html.match(/<title[^>]*>([^<]+)/i)||[])[1]||'';
     page.title=s(decode(title).replace(/\s+/g,' '),140);
     page.images=extractImages(html,productUrl);
   }
 }catch(err){ console.warn('Source fetch failed:',err?.message||err); }

 const originalImages=[...new Set(page.images)].slice(0,40);
 const promptImages=originalImages;
 const system=`Tu es le directeur artistique d'une boutique e-commerce mono-produit premium. Réponds UNIQUEMENT avec JSON valide, sans markdown.
RÈGLE ABSOLUE SUR LES IMAGES :
- "Images récupérées" contient les VRAIES images trouvées sur la page fournisseur.
- Tu dois les conserver et ne jamais les remplacer par des images inventées, génériques ou provenant d'une autre source.
- Tu ne dois jamais inventer d'URL d'image.
- Si plusieurs images sont disponibles, conserve toute la liste dans product.images, dans le même ordre.
- Le premier élément de product.images doit être l'image principale.
- Le serveur réinjectera ensuite les URLs originales afin qu'elles restent prioritaires.
Schéma: {"brand":"...","announcement":"...","cta":"Acheter maintenant","about":"...","philosophy":"...","product":{"name":"...","price":0,"comparePrice":0,"kicker":"...","badge":"...","description":"...","features":[],"reviews":[],"images":[],"sourceImages":[],"sourceUrl":"...","category":"Produit","emoji":"✦"},"trustPoints":[{"title":"...","text":"..."}],"sourceImages":[],"sourceUrl":"...","realSupplier":true}
Style: ${style}. Un seul produit. N'invente ni marque, certification, garantie, résultat médical ou caractéristique non fournie. Les avis non vérifiés doivent rester vides.`;
 try{
   const ar=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:2600,system,messages:[{role:'user',content:`URL source: ${productUrl}\nTitre source: ${page.title}\nImages réelles récupérées sur la page fournisseur (${promptImages.length}) : ${JSON.stringify(promptImages)}\nCrée la boutique premium à partir de ces informations. Ne supprime aucune image fournisseur.`}]} )},30000);
   const raw=await ar.text();
   if(!ar.ok) throw new Error(`Anthropic HTTP ${ar.status}`);
   let d;try{d=JSON.parse(raw)}catch{throw new Error('Réponse Anthropic invalide')}
   const text=(d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
   const a=text.indexOf('{'),b=text.lastIndexOf('}');
   if(a<0||b<=a)throw new Error('JSON IA invalide');
   let shop=JSON.parse(text.slice(a,b+1));
   const base=fallback(page,style,productUrl);
   shop=Object.assign(base,shop);
   shop.theme=style;
   shop.product=Object.assign(base.product,shop.product||{});
   shop.products=[shop.product];

   // IMPORTANT : les images réellement récupérées sur le fournisseur sont prioritaires.
   // La réponse de Claude ne peut pas les supprimer ou les remplacer.
   const aiImages=Array.isArray(shop.product.images)?shop.product.images:[];
   const all=[...originalImages,...aiImages]
     .map(normalizeImageUrl)
     .filter(Boolean)
     .filter((x,i,a)=>a.indexOf(x)===i)
     .slice(0,40);
   shop.product.images=proxyImages(all);
   shop.product.sourceImages=[...all];
   shop.product.image=shop.product.images[0]||'';
   shop.sourceImages=[...all];
   shop.product.sourceImages=[...all];
   shop.products=[shop.product];
   shop.sourceUrl=productUrl;
   shop.productUrl=productUrl;
   return res.status(200).json({shop,source:{imageCount:all.length,originalImageCount:originalImages.length,images:all}});
 }catch(err){
   console.error('ClicBoutique generate error:', err?.stack || err?.message || err);
   const shop=fallback(page,style,productUrl);
   shop.product.sourceImages=[...originalImages];
   shop.products=[shop.product];
   shop.sourceImages=[...originalImages];
   return res.status(200).json({shop,warning:'La rédaction IA n’a pas pu être terminée ; la boutique a été générée avec les informations récupérées.',source:{imageCount:originalImages.length,originalImageCount:originalImages.length,images:originalImages}});
 }
 }catch(err){
  console.error('ClicBoutique generate fatal:', err?.stack || err?.message || err);
  if(!res.headersSent) return res.status(500).json({error:'Erreur serveur pendant la génération.',detail:process.env.NODE_ENV==='development' ? String(err?.message||err) : undefined});
 }
};
