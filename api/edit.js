// /api/edit — modifications de la boutique mono-produit.
const MODEL=process.env.CLAUDE_MODEL||'claude-haiku-4-5-20251001';
const withTimeout=async(url,options={},ms=20000)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(t)}};
const s=(v,m)=>typeof v==='string'?v.trim().slice(0,m):'';
function jsonFrom(t){const a=t.indexOf('{'),b=t.lastIndexOf('}');if(a<0||b<=a)throw Error('JSON invalide');return JSON.parse(t.slice(a,b+1))}
const SYSTEM=`Tu modifies une boutique MONO-PRODUIT. Il est interdit d'ajouter un deuxième produit.
Réponds JSON: {"reply":"phrase courte","ops":[...]}.
Ops autorisées:
{"op":"text","field":"brand|announcement|cta|about|philosophy|product.name|product.description|product.kicker|product.badge","value":"..."}
{"op":"price","value":number,"comparePrice":number}
{"op":"colors","accent":"#rrggbb","bg":"#rrggbb","fg":"#rrggbb"}
{"op":"image","url":"URL image existante ou URL fournie par l'utilisateur"}
Ne change rien d'autre. N'invente pas de nouvelles images si l'utilisateur ne donne pas une URL.`;
module.exports=async function(req,res){
 res.setHeader('Access-Control-Allow-Origin',process.env.ALLOWED_ORIGIN||'*');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'Méthode non autorisée'});
 if(!process.env.ANTHROPIC_API_KEY)return res.status(500).json({error:'ANTHROPIC_API_KEY manquante'});
 let b=req.body;try{if(typeof b==='string')b=JSON.parse(b)}catch{b={}};
 const instruction=s(b?.instruction,700),shop=b?.shop;
 if(!instruction||!shop?.product)return res.status(400).json({error:'Demande invalide'});
 try{
  const r=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:1200,system:SYSTEM,messages:[{role:'user',content:'Boutique actuelle:\\n'+JSON.stringify({brand:shop.brand,announcement:shop.announcement,cta:shop.cta,about:shop.about,philosophy:shop.philosophy,product:{name:shop.product.name,price:shop.product.price,description:shop.product.description,kicker:shop.product.kicker,badge:shop.product.badge}})+'\\nDemande: '+instruction}]})});
  if(!r.ok)throw Error('Claude HTTP '+r.status);const d=await r.json();const o=jsonFrom((d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''));
  return res.status(200).json({reply:s(o.reply,300)||'C’est fait.',ops:Array.isArray(o.ops)?o.ops.slice(0,10):[]});
 }catch(e){return res.status(502).json({error:'Modification impossible pour le moment'})}
}