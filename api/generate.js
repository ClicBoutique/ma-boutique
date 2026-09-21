export default async function handler(req,res){
 if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
 const key=process.env.ANTHROPIC_API_KEY;
 if(!key) return res.status(500).json({error:"ANTHROPIC_API_KEY manquante dans Vercel"});
 const {productUrl,style}=req.body||{};
 if(!productUrl) return res.status(400).json({error:"URL AliExpress manquante"});
 let html="";
 try{
  const r=await fetch(productUrl,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36","Accept-Language":"fr-FR,fr;q=0.9,en;q=0.8"}});
  html=await r.text();
 }catch{}
 const images=[];
 const add=(u)=>{if(!u)return;try{u=u.replace(/\\u002F/g,"/").replace(/\\\//g,"/");if(u.startsWith("//"))u="https:"+u; if(/^https?:\\/\\//.test(u)&&!/logo|icon|avatar|sprite/i.test(u)&&!images.includes(u))images.push(u)}catch{}};
 for(const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/gi)) add(m[1]);
 for(const m of html.matchAll(/https?:\\/\\/[^"'\\s<>]+(?:alicdn|aliexpress-media)[^"'\\s<>]+/gi)) add(m[0]);
 const prompt=`Tu es un directeur artistique e-commerce. À partir des données AliExpress ci-dessous, crée une boutique mono-produit ultra professionnelle. Style: ${style}. Ne fabrique pas de caractéristiques médicales ou de promesses fausses. Les avis doivent être présentés comme exemples si aucune donnée réelle n'est fournie. Réponds UNIQUEMENT en JSON avec title,description,price,badge,features:[{title,text}],reviews:[{name,text}],images,productUrl. Utilise les images fournies telles quelles. URL: ${productUrl}. Images récupérées: ${JSON.stringify(images.slice(0,30))}`;
 const rr=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:3500,messages:[{role:"user",content:prompt}]})});
 if(!rr.ok)return res.status(502).json({error:"Erreur Anthropic"});
 const j=await rr.json();const raw=j.content?.map(x=>x.text||"").join("")||"{}";const clean=raw.replace(/^```json\s*/i,"").replace(/```$/,"").trim();let shop=JSON.parse(clean);
 shop.images=[...(shop.images||[]),...images].filter((x,i,a)=>x&&a.indexOf(x)===i).slice(0,30);
 shop.productUrl=productUrl;
 return res.json({shop});
 }catch(e){return res.status(500).json({error:"Impossible de générer la boutique",detail:String(e.message||e)})}
}