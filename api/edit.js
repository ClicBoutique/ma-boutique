export default async function handler(req,res){
 if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
 const key=process.env.ANTHROPIC_API_KEY;if(!key)return res.status(500).json({error:"ANTHROPIC_API_KEY manquante"});
 const {instruction,shop}=req.body||{};if(!instruction||!shop)return res.status(400).json({error:"Données manquantes"});
 const prompt=`Modifie cette boutique selon la demande. Ne supprime jamais les images existantes, le productUrl ni les informations produit fiables. Demande: ${instruction}. Boutique: ${JSON.stringify(shop)}. Réponds uniquement en JSON avec la même structure.`;
 const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:3500,messages:[{role:"user",content:prompt}]})});
 if(!r.ok)return res.status(502).json({error:"Erreur Anthropic"});
 const j=await r.json();const raw=j.content?.map(x=>x.text||"").join("")||"{}";const clean=raw.replace(/^```json\s*/i,"").replace(/```$/,"").trim();const out=JSON.parse(clean);out.images=shop.images;out.productUrl=shop.productUrl;return res.json({shop:out});
}