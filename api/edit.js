// ClicBoutique — POST /api/edit { instruction, shop }
const MODEL=process.env.CLAUDE_MODEL||'claude-haiku-4-5-20251001';const TIMEOUT=20000;
const s=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';const withTimeout=async(url,options={},ms=TIMEOUT)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(t)}};
function jsonFrom(t){const a=t.indexOf('{'),b=t.lastIndexOf('}');if(a<0||b<=a)throw Error('JSON invalide');return JSON.parse(t.slice(a,b+1))}
const SYSTEM=`Tu es l'assistant de retouche d'une boutique mono-produit. Réponds UNIQUEMENT avec JSON valide: {"reply":"1-2 phrases en français","ops":[...]}. Une boutique possède UN SEUL produit.
Ops autorisées:
- {"op":"theme","value":"mini|color|lux"}
- {"op":"colors","accent":"#rrggbb","bg":"#rrggbb","fg":"#rrggbb"} ou {"op":"colors","reset":true}
- {"op":"text","field":"brand|announcement|cta|about|philosophy|product.name|product.description|product.kicker|product.badge|product.reviews","value":"..."}
- {"op":"product_update","fields":{"name":"...","price":29.9,"comparePrice":0,"description":"...","features":[...],"badge":"..."}}
- {"op":"image","query":"2-5 mots en anglais pour une photo produit"}
Règles: fais uniquement ce qui est demandé; ne crée jamais un second produit; n'invente pas de certification, résultat médical, marque ou caractéristique factuelle; maximum 10 ops.`;
module.exports=async function(req,res){
 res.setHeader('Access-Control-Allow-Origin',process.env.ALLOWED_ORIGIN||'*');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'Méthode non autorisée'});if(!process.env.ANTHROPIC_API_KEY)return res.status(500).json({error:'ANTHROPIC_API_KEY manquante'});
 let body=req.body;try{if(typeof body==='string')body=JSON.parse(body)}catch{body={}};const instruction=s(body?.instruction,600),shop=body?.shop;if(!instruction||!shop?.product)return res.status(400).json({error:'Demande invalide'});
 try{const state={brand:s(shop.brand,50),announcement:s(shop.announcement,100),cta:s(shop.cta,40),about:s(shop.about,300),philosophy:s(shop.philosophy,180),theme:s(shop.theme,10),product:{name:s(shop.product.name,120),price:Number(shop.product.price)||0,comparePrice:Number(shop.product.comparePrice)||0,kicker:s(shop.product.kicker,50),badge:s(shop.product.badge,20),description:s(shop.product.description,500),features:Array.isArray(shop.product.features)?shop.product.features.slice(0,5):[],reviews:s(shop.product.reviews,80)}};
 const r=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:1500,system:SYSTEM,messages:[{role:'user',content:'Boutique actuelle:\n'+JSON.stringify(state)+'\n\nDemande:\n'+instruction}]})});if(!r.ok)throw Error('Claude HTTP '+r.status);const d=await r.json();const out=jsonFrom((d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''));return res.status(200).json({reply:s(out.reply,400)||'Modification appliquée.',ops:Array.isArray(out.ops)?out.ops.slice(0,10):[]});
 }catch(e){console.error(e);return res.status(502).json({error:'Modification impossible pour le moment'});}
};
