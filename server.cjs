// server.cjs — ONE FILE web service (CommonJS) ✅
// Works on Node 18/20/22 regardless of "type": "module"
// Start: node server.cjs

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

// Optional partner feeds (set these in Render → Environment)
// LKQ:
///  LKQ_API_URL, LKQ_API_TOKEN  (or LKQ_USERNAME + LKQ_PASSWORD), LKQ_API_KEY
// CarParts-like (authorized JSON feed YOU control; not scraping):
///  CARPARTS_API_URL, CARPARTS_API_TOKEN (or CARPARTS_USERNAME + CARPARTS_PASSWORD), CARPARTS_API_KEY

// ---------- HELPERS ----------
function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function httpGetJson(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;
      const opts = {
        method: "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        headers: { Accept: "application/json", ...headers },
      };
      const req = lib.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error("Invalid JSON: " + e.message)); }
          } else {
            reject(new Error("HTTP " + res.statusCode + ": " + data.slice(0, 300)));
          }
        });
      });
      req.on("error", reject);
      req.end();
    } catch (e) { reject(e); }
  });
}

function authHeaders(prefix) {
  const h = {};
  if (process.env[`${prefix}_API_TOKEN`]) {
    h.Authorization = "Bearer " + process.env[`${prefix}_API_TOKEN`];
  } else if (process.env[`${prefix}_USERNAME`] && process.env[`${prefix}_PASSWORD`]) {
    const b = Buffer.from(process.env[`${prefix}_USERNAME`] + ":" + process.env[`${prefix}_PASSWORD`]).toString("base64");
    h.Authorization = "Basic " + b;
  }
  if (process.env[`${prefix}_API_KEY`]) h["x-api-key"] = process.env[`${prefix}_API_KEY`];
  return h;
}

// ---------- NORMALIZERS ----------
function norm(core, extra = {}) {
  const veh = core.vehicle || {};
  const id = core.id ?? core.partId ?? core.partID ?? core.sku ?? core.partNumber ?? ("item-" + Math.random().toString(36).slice(2));
  const name = core.name ?? core.title ?? core.description ?? "Auto Part";
  const image = core.image ?? core.imageUrl ?? core.img ?? core.thumbnail ?? "";
  const base =
    core.base_price ?? core.price ?? core.cost ?? core.unitPrice ??
    (typeof core.pricing === "object" ? core.pricing?.price : 0);
  const year = core.year ?? veh.year ?? "";
  const make = core.make ?? veh.make ?? "";
  const model = core.model ?? veh.model ?? "";
  let category = core.category ?? extra.category ??
    (/bumper|fender|hood|grille|mirror|door|tail|headlight|taillight|quarter|panel/i.test(name) ? "body" : "mechanical");
  return { id, name, image, base_price: Number(base || 0), year, make, model, category };
}

function normalizeArrayLike(input, extra = {}) {
  if (Array.isArray(input)) return input.map((p) => norm(p, extra));
  if (Array.isArray(input?.parts)) return input.parts.map((p) => norm(p, extra));
  if (Array.isArray(input?.results)) return input.results.map((p) => norm(p, extra));
  if (Array.isArray(input?.data)) return input.data.map((p) => norm(p, extra));
  return [];
}

// ---------- FEEDS ----------
async function readLKQ() {
  const u = process.env.LKQ_API_URL;
  if (!u) return [];
  const data = await httpGetJson(u, authHeaders("LKQ"));
  return normalizeArrayLike(data);
}

async function readCarParts() {
  const u = process.env.CARPARTS_API_URL;
  if (!u) return [];
  const data = await httpGetJson(u, authHeaders("CARPARTS"));
  const items = normalizeArrayLike(data, { category: "body" });
  return items.map((p) => ({ ...p, category: "body" }));
}

// ---------- LOCAL + DEFAULT ----------
function readDB() {
  try {
    const p = path.join(__dirname, "db.json");
    if (fs.existsSync(p)) {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(json?.products) && json.products.length) return normalizeArrayLike(json.products);
    }
  } catch (e) { console.warn("db.json read failed:", e.message); }
  return [];
}

function defaultCatalog() {
  return [
    // Body (rich set)
    { id: "front-bumper",   name: "Front Bumper Cover",   image: "https://picsum.photos/seed/bumper/800/480",       base_price: 189.00, year: 2020, make: "Toyota", model: "Camry",  category: "body" },
    { id: "rear-bumper",    name: "Rear Bumper Cover",    image: "https://picsum.photos/seed/rear-bumper/800/480",  base_price: 199.00, year: 2020, make: "Toyota", model: "Camry",  category: "body" },
    { id: "left-fender",    name: "Fender (Driver)",      image: "https://picsum.photos/seed/fender-left/800/480",  base_price: 129.00, year: 2019, make: "Honda",  model: "Civic",  category: "body" },
    { id: "right-fender",   name: "Fender (Passenger)",   image: "https://picsum.photos/seed/fender-right/800/480", base_price: 129.00, year: 2019, make: "Honda",  model: "Civic",  category: "body" },
    { id: "hood-panel",     name: "Hood Panel",           image: "https://picsum.photos/seed/hood/800/480",         base_price: 249.00, year: 2021, make: "Ford",   model: "F-150",  category: "body" },
    { id: "grille-assembly",name: "Grille Assembly",      image: "https://picsum.photos/seed/grille/800/480",       base_price: 159.00, year: 2018, make: "Nissan", model: "Altima", category: "body" },
    { id: "side-mirror-rh", name: "Side Mirror (RH)",     image: "https://picsum.photos/seed/mirror/800/480",       base_price:  89.00, year: 2017, make: "Chevy",  model: "Malibu", category: "body" },
    { id: "headlight",      name: "Headlight Assembly",   image: "https://picsum.photos/seed/headlight/800/480",    base_price: 129.00, year: 2014, make: "Audi",   model: "A4",     category: "body" },
    { id: "taillight",      name: "Tail Light Assembly",  image: "https://picsum.photos/seed/taillight/800/480",    base_price: 119.00, year: 2015, make: "BMW",    model: "328i",   category: "body" },
    { id: "door-shell",     name: "Front Door Shell",     image: "https://picsum.photos/seed/door/800/480",         base_price: 299.00, year: 2018, make: "Nissan", model: "Altima", category: "body" },
    { id: "quarter-panel",  name: "Quarter Panel (LH)",   image: "https://picsum.photos/seed/quarter/800/480",      base_price: 349.00, year: 2015, make: "BMW",    model: "328i",   category: "body" },
    { id: "splash-shield",  name: "Engine Splash Shield", image: "https://picsum.photos/seed/splash/800/480",       base_price:  64.00, year: 2020, make: "Toyota", model: "Camry",  category: "body" },
    { id: "wheel-liner",    name: "Wheel Arch Liner",     image: "https://picsum.photos/seed/liner/800/480",        base_price:  54.00, year: 2019, make: "Honda",  model: "Civic",  category: "body" },
    // Mechanical (a few)
    { id: "alternator",     name: "Alternator",           image: "https://picsum.photos/seed/alternator/800/480",   base_price: 199.99, year: 2019, make: "Honda",  model: "Civic",  category: "mechanical" },
    { id: "radiator",       name: "Radiator",             image: "https://picsum.photos/seed/radiator/800/480",     base_price: 149.99, year: 2021, make: "Ford",   model: "F-150",  category: "mechanical" },
    { id: "car-battery",    name: "12V Car Battery",      image: "https://picsum.photos/seed/battery/800/480",      base_price: 139.00, year: 2023, make: "Tesla",  model: "Model 3",category: "mechanical" }
  ];
}

function dedupeMerge(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const p of list) {
      const id = String(p.id || "");
      if (!id) continue;
      if (!seen.has(id)) seen.set(id, p);
      else {
        const old = seen.get(id);
        seen.set(id, {
          ...old, ...p,
          image: p.image || old.image,
          base_price: Number(p.base_price ?? old.base_price ?? 0),
          category: p.category || old.category || "mechanical",
        });
      }
    }
  }
  return Array.from(seen.values());
}

// ---------- HTML (front page, cart, checkout) ----------
const HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Ohio Auto Parts</title>
<style>
:root{--blue:#0f3d99;--accent:#0ea5e9;--bg:#f6f7fb;--card:#fff;--text:#111827}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif}
header{background:var(--blue);color:#fff;padding:24px 16px}
header .wrap{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
header h1{margin:0;font-size:28px}
header nav a{color:#fff;text-decoration:none;margin-left:16px;font-weight:600}
.container{max-width:1100px;margin:18px auto;padding:0 16px}
.filters{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.filters select,.filters input{padding:10px 12px;border:1px solid #d1d5db;border-radius:12px;background:#fff}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:16px}
@media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:600px){.grid{grid-template-columns:1fr}.filters{grid-template-columns:1fr}}
.card{background:var(--card);border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.06);overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;height:160px;object-fit:cover}
.card .p{padding:14px}
.name{font-weight:700;margin:0 0 6px}
.meta{font-size:12px;color:#6b7280}
.badge{display:inline-block;background:#eef2ff;border-radius:999px;padding:4px 8px;font-size:11px;color:#3730a3;margin-top:6px}
.price{color:var(--blue);font-weight:800;margin:10px 0 0}
.btn{cursor:pointer;appearance:none;border:0;background:var(--accent);color:#fff;padding:10px 12px;border-radius:12px;font-weight:700}
.btn.wide{width:100%}.page{display:none}.page.active{display:block}
.section{background:#fff;border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.06);padding:16px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #eef2f7}
.row:last-child{border-bottom:0}
.qty{width:64px;padding:8px;border:1px solid #d1d5db;border-radius:10px}
.right{display:flex;align-items:center;gap:10px}
.totals{display:flex;align-items:center;justify-content:space-between;margin-top:10px;font-weight:800}
.empty{color:#6b7280;text-align:center;padding:20px}
footer{margin:40px 0 20px;text-align:center;color:#6b7280;font-size:12px}
</style>
</head><body>
<header><div class="wrap">
  <h1>Ohio Auto Parts</h1>
  <nav>
    <a href="#/">Home</a>
    <a href="#/cart">Cart</a>
    <a href="#/checkout">Checkout</a>
  </nav>
</div></header>

<main id="page-home" class="page active">
  <div class="container">
    <div class="section" style="margin-bottom:14px">
      <div class="filters">
        <select id="filter-category"><option value="">Category</option></select>
        <select id="filter-year"><option value="">Year</option></select>
        <select id="filter-make"><option value="">Make</option></select>
        <select id="filter-model"><option value="">Model</option></select>
        <input id="filter-search" placeholder="Search part name…"/>
      </div>
    </div>
    <div id="cards" class="grid"></div>
  </div>
</main>

<main id="page-cart" class="page">
  <div class="container">
    <h2 style="margin:8px 0 14px">Your Cart</h2>
    <div id="cart-list" class="section"></div>
    <div class="totals container" style="max-width:600px">
      <div>Subtotal</div><div id="cart-subtotal" style="color:var(--blue)">$0.00</div>
    </div>
    <div class="container" style="max-width:600px;margin-top:12px">
      <a class="btn wide" href="#/checkout">Proceed to Checkout</a>
    </div>
  </div>
</main>

<main id="page-checkout" class="page">
  <div class="container" style="max-width:720px">
    <h2 style="margin:8px 0 14px">Checkout</h2>
    <div class="section">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <input id="c-name" placeholder="Full Name"/>
        <input id="c-email" placeholder="Email"/>
        <input id="c-address" placeholder="Street Address" style="grid-column:1/-1"/>
        <input id="c-city" placeholder="City"/>
        <input id="c-zip" placeholder="ZIP"/>
      </div>
      <div class="totals" style="margin-top:16px">
        <div>Total</div><div id="checkout-total" style="color:var(--blue)">$0.00</div>
      </div>
      <button id="pay-btn" class="btn wide" style="margin-top:12px">Pay Now (demo)</button>
    </div>
  </div>
</main>

<footer>© <span id="yr"></span> Ohio Auto Parts</footer>

<script>
const API_URL = (window.location.origin || "").replace(/\\/$/, "");
const PRODUCTS_ENDPOINT = API_URL + "/api/products";
const FLAT_MARKUP = 50;

let PRODUCTS = [];
const $ = (q)=>document.querySelector(q);
const $el = (tag, attrs={}, children=[])=>{
  const n=document.createElement(tag);
  Object.entries(attrs).forEach(([k,v])=>{ if(k==="class") n.className=v; else if(k==="html") n.innerHTML=v; else n.setAttribute(k,v) });
  children.forEach(c=>n.appendChild(c)); return n
};

const cart = {
  key: "oap_cart",
  get(){ try{ return JSON.parse(localStorage.getItem(this.key)||"[]"); }catch(e){ return [] } },
  set(items){ localStorage.setItem(this.key, JSON.stringify(items)); },
  add(item){ const items=this.get(); const i=items.findIndex(p=>p.id===item.id);
    if(i>-1){ items[i].qty+=1 } else { items.push({...item, qty:1}) }
    this.set(items); alert("Added to cart"); },
  update(id, qty){ const items=this.get().map(p=>p.id===id?{...p, qty:Math.max(1, qty)}:p); this.set(items); },
  remove(id){ const items=this.get().filter(p=>p.id!==id); this.set(items); },
  subtotal(){ return this.get().reduce((s,p)=>s+p.price*p.qty,0) }
};

async function loadProducts(){
  try{
    const res = await fetch(PRODUCTS_ENDPOINT, {headers:{"Accept":"application/json"}});
    if(!res.ok) throw new Error("API error " + res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.products||[]);
    PRODUCTS = list.map((p)=>({
      id: p.id ?? crypto.randomUUID(),
      name: p.name ?? p.title ?? "Auto Part",
      image: p.image || "https://picsum.photos/seed/"+Math.floor(Math.random()*1000)+"/600/360",
      base: Number(p.base_price ?? p.price ?? 0),
      year: p.year ?? "",
      make: p.make ?? "",
      model: p.model ?? "",
      category: p.category ?? (/bumper|fender|hood|grille|mirror|tail|head|door|panel/i.test((p.name||"")) ? "body" : "mechanical")
    })).map((p)=>({ ...p, price: (p.base||0) + FLAT_MARKUP }));
  }catch(err){
    console.warn("Falling back to sample data:", err.message);
    PRODUCTS = [
      {id:"front-bumper",name:"Front Bumper Cover",image:"https://picsum.photos/seed/bumper/600/360",year:2020,make:"Toyota",model:"Camry",category:"body",price:239.00},
      {id:"alternator",name:"Alternator",image:"https://picsum.photos/seed/alternator/600/360",year:2019,make:"Honda",model:"Civic",category:"mechanical",price:249.99}
    ];
  }
  buildFilters(); renderCards();
}

const fCat = $('#filter-category'), fYear = $('#filter-year'), fMake = $('#filter-make'), fModel = $('#filter-model'), fSearch = $('#filter-search');

function buildFilters(){
  const cats=[...new Set(PRODUCTS.map(p=>p.category).filter(Boolean))];
  const years=[...new Set(PRODUCTS.map(p=>p.year).filter(Boolean))];
  const makes=[...new Set(PRODUCTS.map(p=>p.make).filter(Boolean))];
  const models=[...new Set(PRODUCTS.map(p=>p.model).filter(Boolean))];
  function fill(sel, arr){ sel.innerHTML = '<option value=\"\">'+sel.options[0].text+'</option>' + arr.map(v=>`<option value=\"${String(v)}\">${String(v)}</option>`).join(''); }
  fill(fCat, cats); fill(fYear, years); fill(fMake, makes); fill(fModel, models);
}
[fCat,fYear,fMake,fModel,fSearch].forEach(el=>el&&el.addEventListener('input', renderCards));

function filterProducts(){
  const c=fCat.value, y=fYear.value, m=fMake.value, mo=fModel.value, s=(fSearch.value||'').toLowerCase();
  return PRODUCTS.filter(p =>
    (!c || p.category===c) && (!y || String(p.year)===y) &&
    (!m || p.make===m) && (!mo || p.model===mo) &&
    (!s || p.name.toLowerCase().includes(s))
  );
}

function renderCards(){
  const list = filterProducts();
  const wrap = document.getElementById('cards'); wrap.innerHTML = '';
  if(!list.length){ wrap.appendChild($el('div',{class:'empty',html:'No parts found. Adjust your filters.'})); return }
  list.forEach(p=>{
    const card = $el('div',{class:'card'},[
      $el('img',{src:p.image,alt:p.name}),
      $el('div',{class:'p'},[
        $el('h3',{class:'name',html:p.name}),
        $el('div',{class:'meta',html:`${p.year||''} ${p.make||''} ${p.model||''}`}),
        $el('div',{class:'badge',html:(p.category||'')}),
        $el('div',{class:'price',html:`$${Number(p.price||0).toFixed(2)}`}),
        $el('button',{class:'btn wide',html:'Add to Cart'})
      ])
    ]);
    card.querySelector('button').onclick=()=>cart.add({id:p.id,name:p.name,price:Number(p.price||0)});
    wrap.appendChild(card);
  });
}

function renderCart(){
  const box = document.getElementById('cart-list');
  const items = cart.get();
  box.innerHTML = '';
  if(!items.length){ box.appendChild($el('div',{class:'empty',html:'Your cart is empty.'})); updateTotals(); return }
  items.forEach(it=>{
    const row = $el('div',{class:'row'},[
      $el('div',{},[$el('div',{class:'name',html:it.name}), $el('div',{class:'meta',html:`$${it.price.toFixed(2)} each`})]),
      $el('div',{class:'right'},[
        $el('input',{class:'qty',type:'number',min:'1',value:String(it.qty)}),
        $el('button',{class:'btn',html:'Remove'})
      ])
    ]);
    row.querySelector('.qty').oninput=(e)=>{ cart.update(it.id, parseInt(e.target.value||'1',10)); updateTotals(); };
    row.querySelector('button').onclick=()=>{ cart.remove(it.id); renderCart(); };
    box.appendChild(row);
  });
  updateTotals();
}

function updateTotals(){
  const sub = cart.subtotal();
  const $sub = document.getElementById('cart-subtotal'); if($sub) $sub.textContent = "$" + sub.toFixed(2);
  const $tot = document.getElementById('checkout-total'); if($tot) $tot.textContent = "$" + sub.toFixed(2);
}

const payBtn = document.getElementById('pay-btn');
if(payBtn){ payBtn.addEventListener('click', ()=>{
  alert('✅ Order placed (demo).'); localStorage.removeItem(cart.key);
  window.location.hash = '#/'; renderRoute();
}); }

function renderRoute(){
  const hash = (location.hash||'#/').toLowerCase();
  ['home','cart','checkout'].forEach(p=>document.getElementById('page-'+p).classList.remove('active'));
  if(hash.startsWith('#/cart')){ document.getElementById('page-cart').classList.add('active'); renderCart(); }
  else if(hash.startsWith('#/checkout')){ document.getElementById('page-checkout').classList.add('active'); updateTotals(); }
  else { document.getElementById('page-home').classList.add('active'); }
}
window.addEventListener('hashchange', renderRoute);
document.getElementById('yr').textContent = new Date().getFullYear();
loadProducts().then(()=>renderRoute());
</script>
</body></html>`;

// ---------- API HANDLER ----------
async function getProducts() {
  try {
    const [lkq, cp] = await Promise.allSettled([readLKQ(), readCarParts()]);
    const local = readDB();
    const list = dedupeMerge(
      cp.status === "fulfilled" ? cp.value : [],
      lkq.status === "fulfilled" ? lkq.value : [],
      local.length ? local : defaultCatalog()
    );
    return list;
  } catch (e) {
    console.error("Products API error:", e.message);
    return defaultCatalog();
  }
}

const server = http.createServer(async (req, res) => {
  // 1) API routes
  if (req.method === "GET" && req.url.startsWith("/api/products")) {
    const items = await getProducts();
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(items));
  }
  if (req.method === "POST" && req.url.startsWith("/api/orders")) {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => send(res, 201, "application/json; charset=utf-8", JSON.stringify({ ok: true })));
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, "text/plain; charset=utf-8", "ok");
  }

  // 2) Everything else = storefront HTML
  return send(res, 200, "text/html; charset=utf-8", HTML);
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`✅ Ohio Auto Parts running on ${PORT}`);
});
