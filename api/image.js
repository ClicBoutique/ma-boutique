module.exports = async function(req,res){
  if(req.method!=='GET') return res.status(405).end();
  const target=req.query?.url;
  if(!target) return res.status(400).send('Missing image URL');
  let u;
  try{ u=new URL(target); }catch{ return res.status(400).send('Invalid image URL'); }
  if(!/https?:/.test(u.protocol) || !/(alicdn|aliexpress|ae01)/i.test(u.hostname)){
    return res.status(403).send('Image host not allowed');
  }
  try{
    const r=await fetch(u.href,{headers:{
      'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'referer':'https://www.aliexpress.com/'
    }});
    if(!r.ok) return res.status(r.status).send('Image unavailable');
    const type=r.headers.get('content-type')||'image/jpeg';
    if(!type.startsWith('image/')) return res.status(415).send('Not an image');
    res.setHeader('Content-Type',type);
    res.setHeader('Cache-Control','public, max-age=86400, s-maxage=86400');
    const buf=Buffer.from(await r.arrayBuffer());
    return res.status(200).send(buf);
  }catch(e){ return res.status(502).send('Image proxy error'); }
};