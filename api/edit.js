const MODEL=process.env.CLAUDE_MODEL||'claude-haiku-4-5-20251001';
const s=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const withTimeout=async(url,options={},ms=18000)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(t)}};
module.exports=async function(req,res){
 res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({error:'Méthode non autorisée'});
 if(!process.env.ANTHROPIC_API_KEY)return res.status(500).json({error:'ANTHROPIC_API_KEY est manquante dans Vercel.'});
 let body=req.body;try{if(typeof body==='string')body=JSON.parse(body)}catch{}
 const instruction=s(body?.instruction,800),shop=body?.shop;
 if(!instruction||!shop?.product)return res.status(400).json({error:'Demande de modification invalide.'});
 try{
  const r=await withTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:1500,system:'Réponds uniquement avec JSON valide. Modifie une boutique mono-produit sans inventer de faits.',messages:[{role:'user',content:`Boutique: ${JSON.stringify(shop)}\nDemande: ${instruction}\nRetourne toute la boutique en JSON.`}]} )});
  const raw=await r.text();if(!r.ok)throw Error(`Anthropic HTTP ${r.status}`);
  const d=JSON.parse(raw),text=(d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''),a=text.indexOf('{'),b=text.lastIndexOf('}');
  if(a<0||b<=a)throw Error('JSON IA invalide');const out=JSON.parse(text.slice(a,b+1));out.product=out.product||shop.product;out.product.images=shop.product.images;out.product.image=shop.product.image;out.theme=out.theme||shop.theme;return res.status(200).json({shop:out,reply:'Modification appliquée.'});
 }catch(e){return res.status(200).json({shop,reply:'La modification n’a pas pu être appliquée pour le moment.'});}
};