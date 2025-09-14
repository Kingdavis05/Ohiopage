// server.cjs — Ohio Auto Parts Storefront with VIN + Search Bars
// Runs in CommonJS mode. Copy this file to your repo root.

const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;

// Optional: Google Custom Search credentials (set in Render → Environment)
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; 
const GOOGLE_CX = process.env.GOOGLE_CX;

// --- Sample catalog (can replace with LKQ feed or db.json later) ---
function defaultCatalog() {
  return [
    { id: "front-bumper",  name: "Front Bumper Cover", base_price: 189, year: 2020, make: "Toyota", model: "Camry", category: "body" },
    { id: "hood-panel",    name: "Hood Panel",         base_price: 249, year: 2021, make: "Ford",   model: "F-150", category: "body" },
    { id: "headlight",     name: "Headlight Assembly", base_price: 129, year: 2019, make: "Honda",  model: "Civic", category: "body" },
    { id: "alternator",    name: "Alternator",         base_price: 199, year: 2019, make: "Honda",  model: "Civic", category: "mechanical" },
    { id: "radiator",      name: "Radiator",           base_price: 149, year: 2021, make: "Ford",   model: "F-150", category: "mechanical" },
    { id: "battery",       name: "12V Car Battery",    base_price: 139, year: 2023, make: "Tesla",  model: "Model 3", category: "mechanical" }
  ];
}

// --- Helper: GET JSON from URL ---
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

// --- Google Image Search (optional) ---
async function fetchImageForPart(query) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return "";
  const q = encodeURIComponent(query);
  const url = `https://www.googleapis.com/customsearch/v1?q=${q}&searchType=image&num=1&key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}`;
  try {
    const data = await getJson(url);
    return data.items?.[0]?.link || "";
  } catch {
    return "";
  }
}

// --- HTML frontend ---
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
    <input id="part-search" placeholder="Search part name"/>
    <button onclick="renderCards()">Search</button>
  </div>
  <div id="cards" class="grid"></div>

<script>
let PRODUCTS = [];
const FLAT_MARKUP = 50;

// Load products
async function loadProducts(){
  const res = await fetch('/api/products');
  PRODUCTS = await res.json();
  buildDropdowns();
  renderCards();
}

function buildDropdowns(){
  const years = [...new Set(PRODUCTS.map(p=>p.year).filter(Boolean))];
  const makes = [...new Set(PRODUCTS.map(p=>p.make).filter(Boolean))];
  const models= [...new Set(PRODUCTS.map(p=>p.model).filter(Boolean))];
  document.getElementById('year').innerHTML='<option value="">Year</option>'+years.map(y=>'<option>'+y+'</option>').join('');
  document.getElementById('make').innerHTML='<option value="">Make</option>'+makes.map(m=>'<option>'+m+'</option>').join('');
  document.getElementById('model').innerHTML='<option value="">Model</option>'+models.map(m=>'<option>'+m+'</option>').join('');
}

function renderCards(){
  const y=document.getElementById('year').value;
  const m=document.getElementById('make').value;
  const mo=document.getElementById('model').value;
  const s=(document.getElementById('part-search').value||'').toLowerCase();
  const list = PRODUCTS.filter(p=>
    (!y||p.year==y)&&(!m||p.make==m)&&(!mo||p.model==mo)&&(!s||p.name.toLowerCase().includes(s))
  );
  const wrap=document.getElementById('cards');
  wrap.innerHTML='';
  list.forEach(p=>{
    const price=(Number(p.base_price||0)+FLAT_MARKUP).toFixed(2);
    const div=document.createElement('div');
    div.className='card';
    div.innerHTML='<img src="'+(p.image||'https://picsum.photos/seed/'+p.id+'/600/360')+'"/>'+
      '<div class="p"><div class="name">'+p.name+'</div>'+
      '<div>'+(p.year||"")+' '+(p.make||"")+' '+(p.model||"")+'</div>'+
      '<div class="price">$'+price+'</div></div>';
    wrap.appendChild(div);
  });
}

// VIN decode (NHTSA API)
async function searchVIN(){
  const vin=document.getElementById('vin').value.trim();
  if(vin.length!=17){ alert("VIN must be 17 characters"); return; }
  const res=await fetch('/api/vin/'+vin);
  const data=await res.json();
  if(data.make){ document.getElementById('make').value=data.make; }
  if(data.model){ document.getElementById('model').value=data.model; }
  if(data.year){ document.getElementById('year').value=data.year; }
  renderCards();
}

loadProducts();
</script>
</body>
</html>`;

// --- API server ---
const server = http.createServer(async (req,res)=>{
  if(req.url.startsWith("/api/products")){
    let list = defaultCatalog();
    // Optionally enrich with Google Images
    if(GOOGLE_API_KEY && GOOGLE_CX){
      for(const p of list){
        if(!p.image){
          p.image = await fetchImageForPart(`${p.year} ${p.make} ${p.model} ${p.name}`);
        }
      }
    }
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(list));
  }
  if(req.url.startsWith("/api/vin/")){
    const vin=req.url.split("/").pop();
    try {
      const data=await getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
      const getVal = (label)=> data.Results.find(r=>r.Variable===label)?.Value || "";
      const info={ make:getVal("Make"), model:getVal("Model"), year:getVal("Model Year") };
      res.writeHead(200,{"Content-Type":"application/json"});
      return res.end(JSON.stringify(info));
    } catch {
      res.writeHead(500,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({error:"VIN decode failed"}));
    }
  }
  // health
  if(req.url==="/health"){ res.writeHead(200,{"Content-Type":"text/plain"}); return res.end("ok"); }
  // storefront
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(HTML);
});

server.listen(PORT,()=>console.log("✅ Ohio Auto Parts running on port "+PORT));

