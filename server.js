// server.cjs — Ohio Auto Parts full version with VIN, filters, expanded catalog & licensed image resolver
// Works with Node 20.x on Render

const http = require("http");
const https = require("https");
const PORT = process.env.PORT || 3000;

// --- Expanded product catalog (demo) ---
function defaultCatalog() {
  return [
    { id:"toyota-camry-front-bumper", name:"Front Bumper Cover", base_price:189, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Body" },
    { id:"ford-f150-alternator", name:"Alternator", base_price:229, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Mechanical" },
    { id:"honda-civic-brakepads", name:"Brake Pads (Front)", base_price:69, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Mechanical" },
    { id:"bmw-328i-radiator", name:"Radiator", base_price:299, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Mechanical" },
    { id:"audi-a4-headlight", name:"Headlight Assembly", base_price:229, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Body" },
    { id:"mercedes-cclass-bumper", name:"Front Bumper Cover", base_price:319, year:2018, make:"Mercedes", model:"C-Class", type:"Sedan", category:"Body" },
    { id:"vw-jetta-brakepads", name:"Brake Pads (Front)", base_price:89, year:2017, make:"Volkswagen", model:"Jetta", type:"Sedan", category:"Mechanical" },
    { id:"peugeot-308-bumper", name:"Front Bumper Cover", base_price:189, year:2019, make:"Peugeot", model:"308", type:"Hatchback", category:"Body" },
    { id:"renault-clio-alternator", name:"Alternator", base_price:199, year:2019, make:"Renault", model:"Clio", type:"Hatchback", category:"Mechanical" },
    { id:"fiat-500-radiator", name:"Radiator", base_price:179, year:2018, make:"Fiat", model:"500", type:"Hatchback", category:"Mechanical" }
    // … keep rest of catalog entries from earlier version …
  ];
}

// --- Helper: fetch JSON ---
function getJson(u) {
  return new Promise((resolve, reject) => {
    https.get(u, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error("Invalid JSON")); }
      });
    }).on("error", reject);
  });
}

// --- Licensed image resolver ---
async function resolveImage(part) {
  // 1) Primary JSON feed
  if (process.env.IMG_FEED_PRIMARY) {
    try {
      const u = `${process.env.IMG_FEED_PRIMARY}?id=${encodeURIComponent(part.id)}&make=${encodeURIComponent(part.make||"")}&model=${encodeURIComponent(part.model||"")}`;
      const data = await getJson(u);
      if (data?.image) return data.image;
    } catch {}
  }
  // 2) Secondary JSON feed
  if (process.env.IMG_FEED_SECONDARY) {
    try {
      const u = `${process.env.IMG_FEED_SECONDARY}?id=${encodeURIComponent(part.id)}`;
      const data = await getJson(u);
      if (data?.image) return data.image;
    } catch {}
  }
  // 3) Static CDN map
  if (process.env.IMG_MAP) {
    try {
      const MAP = JSON.parse(process.env.IMG_MAP);
      if (MAP[part.make]) {
        return `${MAP[part.make]}${encodeURIComponent((part.model||"generic").toLowerCase())}/${encodeURIComponent(part.id)}.jpg`;
      }
    } catch {}
  }
  // 4) Neutral fallback
  return "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='360'>
       <rect width='100%' height='100%' fill='#efefef'/>
       <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
        fill='#555' font-family='Arial' font-size='20'>Image unavailable</text>
     </svg>`
  );
}

// --- HTML storefront ---
const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Ohio Auto Parts</title>
  <style>
    body { font-family: sans-serif; margin: 0; background: #f6f7fb; }
    header { background: #0f3d99; color: #fff; padding: 16px; }
    .filters { display: flex; gap: 8px; padding: 16px; flex-wrap: wrap; }
    .filters input, .filters select { padding: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(250px,1fr)); gap: 16px; padding: 16px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 6px rgba(0,0,0,.1); overflow: hidden; }
    .card img { width: 100%; height: 160px; object-fit: cover; }
    .card .p { padding: 12px; }
    .name { font-weight: bold; margin: 0 0 6px; }
    .price { color: #0f3d99; font-weight: bold; }
  </style>
</head>
<body>
  <header><h1>Ohio Auto Parts</h1></header>
  <div class="filters">
    <input id="vin" placeholder="Enter VIN (17 chars)"/>
    <button onclick="searchVIN()">Decode VIN</button>
    <select id="year"><option value="">Year</option></select>
    <select id="make"><option value="">Make</option></select>
    <select id="model"><option value="">Model</option></select>
    <select id="type"><option value="">Type</option></select>
    <select id="category"><option value="">Category</option><option>Body</option><option>Mechanical</option></select>
    <input id="part-search" placeholder="Search part name"/>
    <button onclick="renderCards()">Search</button>
  </div>
  <div id="cards" class="grid"></div>

<script>
let PRODUCTS = [];
let VIN_INFO = null;
const FLAT_MARKUP = 50;

// Fill years
const yearSel=document.getElementById('year');
for(let y=2026;y>=1995;y--){ yearSel.innerHTML+='<option>'+y+'</option>'; }

async function loadProducts(){
  let url='/api/products';
  if(VIN_INFO && VIN_INFO.vin){ url+='/'+VIN_INFO.vin; }
  const res=await fetch(url);
  PRODUCTS=await res.json();
  renderCards();
}

function renderCards(){
  const y=document.getElementById('year').value;
  const m=document.getElementById('make').value;
  const mo=document.getElementById('model').value;
  const t=document.getElementById('type').value;
  const c=document.getElementById('category').value;
  const s=(document.getElementById('part-search').value||'').toLowerCase();
  const wrap=document.getElementById('cards');
  wrap.innerHTML='';
  const list=PRODUCTS.filter(p=>
    (!y||p.year==y)&&(!m||p.make==m)&&(!mo||p.model==mo)&&(!t||p.type==t)&&(!c||p.category==c)&&(!s||p.name.toLowerCase().includes(s))
  );
  list.forEach(p=>{
    const price=(Number(p.base_price||0)+FLAT_MARKUP).toFixed(2);
    const div=document.createElement('div');
    div.className='card';
    div.innerHTML='<img src="'+p.image+'"/>'+
      '<div class="p"><div class="name">'+p.name+'</div>'+
      '<div>'+(p.year||"")+' '+(p.make||"")+' '+(p.model||"")+' '+(p.type||"")+' | '+p.category+'</div>'+
      '<div class="price">$'+price+'</div></div>';
    wrap.appendChild(div);
  });
}

async function searchVIN(){
  const vin=document.getElementById('vin').value.trim();
  if(vin.length!=17){ alert("VIN must be 17 characters"); return; }
  const res=await fetch('/api/vin/'+vin);
  const d=await res.json();
  VIN_INFO = { ...d, vin };
  if(d.year) document.getElementById('year').value=d.year;
  if(d.make){ document.getElementById('make').innerHTML='<option>'+d.make+'</option>'; }
  if(d.model){ document.getElementById('model').innerHTML='<option>'+d.model+'</option>'; }
  if(d.type){ document.getElementById('type').innerHTML='<option>'+d.type+'</option>'; }
  loadProducts();
}

loadProducts();
</script>
</body>
</html>`;

// --- Server ---
const server = http.createServer(async (req,res)=>{
  if(req.url.startsWith("/api/products")){
    let parts = defaultCatalog();
    const vin = req.url.split("/api/products/")[1];
    if(vin){
      try {
        const data=await getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
        const getVal=(label)=>data.Results.find(r=>r.Variable===label)?.Value||"";
        const info={ make:getVal("Make"), model:getVal("Model"), year:getVal("Model Year"), type:getVal("Body Class") };
        parts = parts.filter(p=>
          (!info.year||p.year==info.year)&&(!info.make||p.make==info.make)&&(!info.model||p.model==info.model)&&(!info.type||p.type==info.type)
        );
      } catch {}
    }
    // Attach images
    const enriched=[];
    for(const p of parts){ enriched.push({...p, image: await resolveImage(p)}); }
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(enriched));
  }
  if(req.url.startsWith("/api/vin/")){
    const vin=req.url.split("/").pop();
    try {
      const data=await getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
      const getVal=(label)=>data.Results.find(r=>r.Variable===label)?.Value||"";
      const info={ make:getVal("Make"), model:getVal("Model"), year:getVal("Model Year"), type:getVal("Body Class") };
      res.writeHead(200,{"Content-Type":"application/json"});
      return res.end(JSON.stringify(info));
    } catch {
      res.writeHead(500,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({error:"VIN decode failed"}));
    }
  }
  if(req.url==="/health"){ res.writeHead(200,{"Content-Type":"text/plain"}); return res.end("ok"); }
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(HTML);
});

server.listen(PORT,()=>console.log("✅ Ohio Auto Parts running on port "+PORT));
