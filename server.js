// Ohio Auto Parts — full single-file app with Stripe Checkout
// Frontend + backend + VIN search + filters + cart/checkout + admin ingest + sitemap
// Stripe: create Checkout Session (no SDK required), confirm and store paid orders.
// CommonJS; Node 20.x recommended

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const FLAT_MARKUP = Number(process.env.FLAT_MARKUP || 50);

// 🔐 Stripe keys (set these in Render → Environment)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || ""; // required
// success/cancel can default to your site; override if you like:
const CHECKOUT_SUCCESS_URL = process.env.CHECKOUT_SUCCESS_URL || ""; // optional
const CHECKOUT_CANCEL_URL  = process.env.CHECKOUT_CANCEL_URL  || ""; // optional

// Optional licensed feeds (must be authorized)
const LKQ_API_URL = process.env.LKQ_API_URL || "";
const CARPARTS_API_URL = process.env.CARPARTS_API_URL || "";

// Licensed image sources
const IMG_FEED_PRIMARY   = process.env.IMG_FEED_PRIMARY || "";
const IMG_FEED_SECONDARY = process.env.IMG_FEED_SECONDARY || "";
const IMG_MAP            = process.env.IMG_MAP || "";

const CACHE_TTL_MS = 15 * 60 * 1000;
let CATALOG_CACHE = { items: [], loadedAt: 0 };

// -------------------- Utils --------------------
function ok(res, type, body) {
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function err(res, code, msg) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}
function parseQuery(u) {
  const url = new URL(u, "http://x");
  return Object.fromEntries(url.searchParams.entries());
}
function getJson(u) {
  return new Promise((resolve, reject) => {
    const lib = u.startsWith("https") ? https : http;
    lib.get(u, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d || "null")); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}
function postJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });
}
function requestJson(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers
    };
    const rq = lib.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        const okCode = res.statusCode >= 200 && res.statusCode < 300;
        if (!okCode) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0,400)}`));
        try { resolve(JSON.parse(d || "null")); } catch (e) { resolve(d); }
      });
    });
    rq.on("error", reject);
    if (body) rq.write(typeof body === "string" ? body : JSON.stringify(body));
    rq.end();
  });
}
function formEncode(obj) {
  const esc = encodeURIComponent;
  const pairs = [];
  const push = (k, v) => pairs.push(`${esc(k)}=${esc(v)}`);
  // Stripe expects deep objects using bracket notation
  for (const [k,v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) push(`${k}[${k2}]`, v2);
    } else if (Array.isArray(v)) {
      v.forEach((val, i) => {
        if (val && typeof val === "object") {
          for (const [k2, v2] of Object.entries(val)) push(`${k}[${i}][${k2}]`, v2);
        } else {
          push(`${k}[${i}]`, val);
        }
      });
    } else {
      push(k, v);
    }
  }
  return pairs.join("&");
}
function headersAuth(prefix) {
  const h = { Accept: "application/json" };
  if (process.env[`${prefix}_API_TOKEN`]) h.Authorization = "Bearer " + process.env[`${prefix}_API_TOKEN`];
  if (process.env[`${prefix}_API_KEY`]) h["x-api-key"] = process.env[`${prefix}_API_KEY`];
  return h;
}

// -------------------- Catalog (seed + feeds) --------------------
function seedCatalog() {
  // (same catalog as previous message; trimmed here for brevity)
  return [
    // Toyota Camry
    { id:"toyota-camry-front-bumper", name:"Front Bumper Cover", base_price:189, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Body" },
    { id:"toyota-camry-hood", name:"Hood Panel", base_price:249, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Body" },
    { id:"toyota-camry-headlight", name:"Headlight Assembly", base_price:129, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Body" },
    { id:"toyota-camry-radiator", name:"Radiator", base_price:149, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Mechanical" },
    { id:"toyota-camry-brakepads", name:"Brake Pads (Front)", base_price:79, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Mechanical" },
    { id:"toyota-camry-battery", name:"Car Battery", base_price:139, year:2020, make:"Toyota", model:"Camry", type:"Sedan", category:"Mechanical" },
    // Ford F-150
    { id:"ford-f150-front-bumper", name:"Front Bumper Cover", base_price:229, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Body" },
    { id:"ford-f150-hood", name:"Hood Panel", base_price:279, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Body" },
    { id:"ford-f150-headlight", name:"Headlight Assembly", base_price:149, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Body" },
    { id:"ford-f150-radiator", name:"Radiator", base_price:169, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Mechanical" },
    { id:"ford-f150-alternator", name:"Alternator", base_price:229, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Mechanical" },
    { id:"ford-f150-starter", name:"Starter Motor", base_price:199, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Mechanical" },
    { id:"ford-f150-brakepads", name:"Brake Pads (Front)", base_price:99, year:2021, make:"Ford", model:"F-150", type:"Pickup", category:"Mechanical" },
    // Honda Civic
    { id:"honda-civic-front-bumper", name:"Front Bumper Cover", base_price:179, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Body" },
    { id:"honda-civic-fender", name:"Fender", base_price:129, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Body" },
    { id:"honda-civic-headlight", name:"Headlight Assembly", base_price:119, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Body" },
    { id:"honda-civic-alternator", name:"Alternator", base_price:189, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Mechanical" },
    { id:"honda-civic-brakepads", name:"Brake Pads (Front)", base_price:69, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Mechanical" },
    { id:"honda-civic-sparkplugs", name:"Spark Plugs (4-pack)", base_price:24, year:2019, make:"Honda", model:"Civic", type:"Sedan", category:"Mechanical" },
    // BMW 328i
    { id:"bmw-328i-front-bumper", name:"Front Bumper Cover", base_price:299, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Body" },
    { id:"bmw-328i-hood", name:"Hood Panel", base_price:399, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Body" },
    { id:"bmw-328i-headlight", name:"Headlight Assembly", base_price:249, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Body" },
    { id:"bmw-328i-alternator", name:"Alternator", base_price:349, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Mechanical" },
    { id:"bmw-328i-radiator", name:"Radiator", base_price:299, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Mechanical" },
    { id:"bmw-328i-battery", name:"Car Battery", base_price:249, year:2019, make:"BMW", model:"328i", type:"Sedan", category:"Mechanical" },
    // Audi A4
    { id:"audi-a4-front-bumper", name:"Front Bumper Cover", base_price:289, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Body" },
    { id:"audi-a4-hood", name:"Hood Panel", base_price:379, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Body" },
    { id:"audi-a4-headlight", name:"Headlight Assembly", base_price:229, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Body" },
    { id:"audi-a4-brakepads", name:"Brake Pads (Front)", base_price:119, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Mechanical" },
    { id:"audi-a4-radiator", name:"Radiator", base_price:269, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Mechanical" },
    { id:"audi-a4-battery", name:"Car Battery", base_price:229, year:2018, make:"Audi", model:"A4", type:"Sedan", category:"Mechanical" },
    // Mercedes C-Class
    { id:"mercedes-cclass-bumper", name:"Front Bumper Cover", base_price:319, year:2018, make:"Mercedes", model:"C-Class", type:"Sedan", category:"Body" },
    { id:"mercedes-cclass-headlight", name:"Headlight Assembly", base_price:259, year:2018, make:"Mercedes", model:"C-Class", type:"Sedan", category:"Body" },
    { id:"mercedes-cclass-radiator", name:"Radiator", base_price:289, year:2018, make:"Mercedes", model:"C-Class", type:"Sedan", category:"Mechanical" },
    { id:"mercedes-cclass-alternator", name:"Alternator", base_price:369, year:2018, make:"Mercedes", model:"C-Class", type:"Sedan", category:"Mechanical" },
    // Volkswagen Jetta
    { id:"vw-jetta-bumper", name:"Front Bumper Cover", base_price:199, year:2017, make:"Volkswagen", model:"Jetta", type:"Sedan", category:"Body" },
    { id:"vw-jetta-headlight", name:"Headlight Assembly", base_price:159, year:2017, make:"Volkswagen", model:"Jetta", type:"Sedan", category:"Body" },
    { id:"vw-jetta-brakepads", name:"Brake Pads (Front)", base_price:89, year:2017, make:"Volkswagen", model:"Jetta", type:"Sedan", category:"Mechanical" },
    { id:"vw-jetta-radiator", name:"Radiator", base_price:199, year:2017, make:"Volkswagen", model:"Jetta", type:"Sedan", category:"Mechanical" },
    // Peugeot 308
    { id:"peugeot-308-bumper", name:"Front Bumper Cover", base_price:189, year:2019, make:"Peugeot", model:"308", type:"Hatchback", category:"Body" },
    { id:"peugeot-308-headlight", name:"Headlight Assembly", base_price:139, year:2019, make:"Peugeot", model:"308", type:"Hatchback", category:"Body" },
    { id:"peugeot-308-brakepads", name:"Brake Pads (Front)", base_price:79, year:2019, make:"Peugeot", model:"308", type:"Hatchback", category:"Mechanical" },
    // Renault Clio
    { id:"renault-clio-bumper", name:"Front Bumper Cover", base_price:169, year:2019, make:"Renault", model:"Clio", type:"Hatchback", category:"Body" },
    { id:"renault-clio-headlight", name:"Headlight Assembly", base_price:129, year:2019, make:"Renault", model:"Clio", type:"Hatchback", category:"Body" },
    { id:"renault-clio-alternator", name:"Alternator", base_price:199, year:2019, make:"Renault", model:"Clio", type:"Hatchback", category:"Mechanical" },
    // Fiat 500
    { id:"fiat-500-bumper", name:"Front Bumper Cover", base_price:159, year:2018, make:"Fiat", model:"500", type:"Hatchback", category:"Body" },
    { id:"fiat-500-headlight", name:"Headlight Assembly", base_price:119, year:2018, make:"Fiat", model:"500", type:"Hatchback", category:"Body" },
    { id:"fiat-500-radiator", name:"Radiator", base_price:179, year:2018, make:"Fiat", model:"500", type:"Hatchback", category:"Mechanical" }
  ];
}
function norm(p) {
  const veh = p.vehicle || {};
  return {
    id: p.id || p.sku || p.partNumber || p.partId || crypto.randomUUID(),
    name: p.name || p.title || p.description || "Auto Part",
    base_price: Number(p.base_price ?? p.price ?? p.cost ?? 0),
    year: p.year ?? veh.year ?? "",
    make: p.make ?? veh.make ?? "",
    model: p.model ?? veh.model ?? "",
    type: p.type ?? veh.type ?? "",
    category: p.category ?? (/bumper|fender|hood|grille|mirror|door|tail|head|panel/i.test(p.name||"") ? "Body" : "Mechanical")
  };
}
function normalizeFeed(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.map(norm);
  if (Array.isArray(data.parts)) return data.parts.map(norm);
  if (Array.isArray(data.results)) return data.results.map(norm);
  if (Array.isArray(data.data)) return data.data.map(norm);
  return [];
}

// Licensed image resolver
async function resolveImage(part) {
  if (IMG_FEED_PRIMARY) {
    try {
      const u = `${IMG_FEED_PRIMARY}?id=${encodeURIComponent(part.id)}&make=${encodeURIComponent(part.make||"")}&model=${encodeURIComponent(part.model||"")}`;
      const data = await getJson(u);
      if (data?.image) return data.image;
    } catch {}
  }
  if (IMG_FEED_SECONDARY) {
    try {
      const u = `${IMG_FEED_SECONDARY}?id=${encodeURIComponent(part.id)}`;
      const data = await getJson(u);
      if (data?.image) return data.image;
    } catch {}
  }
  if (IMG_MAP) {
    try {
      const MAP = JSON.parse(IMG_MAP);
      if (MAP[part.make]) {
        return `${MAP[part.make]}${encodeURIComponent((part.model||"generic").toLowerCase())}/${encodeURIComponent(part.id)}.jpg`;
      }
    } catch {}
  }
  return "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='360'>
       <rect width='100%' height='100%' fill='#efefef'/>
       <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
        fill='#555' font-family='Arial' font-size='20'>Image unavailable</text>
     </svg>`
  );
}

async function loadCatalogFresh() {
  const seed = seedCatalog();
  let lkq = [], cp = [];
  try { if (LKQ_API_URL) lkq = normalizeFeed(await requestJson("GET", LKQ_API_URL, headersAuth("LKQ"))); } catch {}
  try { if (CARPARTS_API_URL) cp = normalizeFeed(await requestJson("GET", CARPARTS_API_URL, headersAuth("CARPARTS"))); } catch {}
  const all = [...cp, ...lkq, ...seed];
  const seen = new Map();
  for (const p of all) if (p.id && !seen.has(p.id)) seen.set(p.id, p);
  const items = Array.from(seen.values());
  for (const p of items) p.image = await resolveImage(p);
  CATALOG_CACHE = { items, loadedAt: Date.now() };
  return items;
}
async function getCatalogCached() {
  if (!CATALOG_CACHE.items.length || Date.now() - CATALOG_CACHE.loadedAt > CACHE_TTL_MS) {
    return await loadCatalogFresh();
  }
  return CATALOG_CACHE.items;
}

// -------------------- Frontend HTML (with Stripe flow) --------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Ohio Auto Parts – VIN fitment, fast checkout</title>
<meta name="description" content="VIN-based fitment search for body and mechanical car parts. Fast checkout." />
<meta property="og:title" content="Ohio Auto Parts" />
<meta property="og:type" content="website" />
<meta property="og:description" content="VIN-based fitment search for auto parts" />
<link rel="canonical" href="/" />
<style>
:root{--blue:#0f3d99;--accent:#0ea5e9;--bg:#f6f7fb;--card:#fff;--text:#111827}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif}
header{background:var(--blue);color:#fff;padding:18px 14px}
header .wrap{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
h1{margin:0;font-size:24px}
nav a{color:#fff;text-decoration:none;margin-left:14px;font-weight:700}
.container{max-width:1100px;margin:14px auto;padding:0 14px}
.filters{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.filters input,.filters select,.filters button{padding:10px 12px;border:1px solid #d1d5db;border-radius:12px;background:#fff}
.filters button{background:var(--accent);color:#fff;border:0;font-weight:800;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:16px}
@media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:600px){.grid{grid-template-columns:1fr}.filters{grid-template-columns:1fr}}
.card{background:var(--card);border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.06);overflow:hidden;display:flex;flex-direction:column}
.card img{width:100%;height:160px;object-fit:cover;background:#eee}
.card .p{padding:14px}
.name{font-weight:800;margin:0 0 6px}
.meta{font-size:12px;color:#6b7280}
.badge{display:inline-block;background:#eef2ff;border-radius:999px;padding:4px 8px;font-size:11px;color:#3730a3;margin-top:6px}
.price{color:var(--blue);font-weight:900;margin:10px 0 0}
.btn{cursor:pointer;appearance:none;border:0;background:var(--accent);color:#fff;padding:10px 12px;border-radius:12px;font-weight:800}
.btn.wide{width:100%}.page{display:none}.page.active{display:block}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #eef2f7}
.row:last-child{border-bottom:0}
.qty{width:64px;padding:8px;border:1px solid #d1d5db;border-radius:10px}
.right{display:flex;align-items:center;gap:10px}
.totals{display:flex;align-items:center;justify-content:space-between;margin-top:10px;font-weight:800}
.empty{color:#6b7280;text-align:center;padding:20px}
footer{margin:40px 0 20px;text-align:center;color:#6b7280;font-size:12px}
.pager{display:flex;gap:6px;justify-content:center;margin:12px 0}
.pager button{padding:8px 10px;border:1px solid #d1d5db;background:#fff;border-radius:10px;cursor:pointer}
.success{max-width:720px;margin:20px auto;padding:16px;background:#ecfdf5;border:1px solid #10b98133;border-radius:14px;color:#065f46}
</style>
</head>
<body>
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
    <div class="filters">
      <input id="vin" placeholder="VIN (17 chars)"/>
      <button id="vinBtn">Decode VIN</button>
      <select id="year"><option value="">Year (1995–2026)</option></select>
      <select id="make"><option value="">Make</option></select>
      <select id="model"><option value="">Model</option></select>
      <select id="type"><option value="">Type</option></select>
      <select id="category"><option value="">Category</option><option>Body</option><option>Mechanical</option></select>
      <input id="q" placeholder="Search part name"/>
      <button id="searchBtn">Search</button>
    </div>

    <div id="cards" class="grid"></div>
    <div class="pager"><button id="prev">Prev</button><div id="pageInfo"></div><button id="next">Next</button></div>
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
      <button id="pay-btn" class="btn wide" style="margin-top:12px">Pay with Card (Stripe)</button>
    </div>
  </div>
</main>

<main id="page-success" class="page">
  <div class="container">
    <div class="success" id="success-box">✅ Payment confirmed! Finalizing your order…</div>
  </div>
</main>

<footer>© <span id="yr"></span> Ohio Auto Parts</footer>

<script>
const API = location.origin;
const FLAT_MARKUP = ${FLAT_MARKUP};

// Years
const yearSel=document.getElementById('year');
for(let y=2026;y>=1995;y--){ yearSel.innerHTML+='<option>'+y+'</option>'; }

const $ = (q)=>document.querySelector(q);
const cart = {
  key: "oap_cart",
  get(){ try{ return JSON.parse(localStorage.getItem(this.key)||"[]"); }catch(e){ return [] } },
  set(items){ localStorage.setItem(this.key, JSON.stringify(items)); },
  add(item){ const items=this.get(); const i=items.findIndex(p=>p.id===item.id);
    if(i>-1){ items[i].qty+=1 } else { items.push({...item, qty:1}) }
    this.set(items); alert("Added to cart"); },
  reset(){ localStorage.removeItem(this.key); },
  subtotal(){ return this.get().reduce((s,p)=>s+p.price*p.qty,0) }
};

let PRODUCTS = [];
let VINVAL = null;
let page = 1, perPage = 9;

async function fetchProducts() {
  const params = new URLSearchParams();
  const y=$('#year').value, m=$('#make').value, mo=$('#model').value, t=$('#type').value, c=$('#category').value, q=$('#q').value;
  if(y) params.set('year', y); if(m) params.set('make', m); if(mo) params.set('model', mo); if(t) params.set('type', t);
  if(c) params.set('category', c); if(q) params.set('q', q); params.set('page', page); params.set('per', perPage);
  let url = API + '/api/products?' + params.toString();
  if (VINVAL) url = API + '/api/products/'+VINVAL+'?'+params.toString();
  const res = await fetch(url); const data = await res.json();
  PRODUCTS = data.items || data; 
  document.getElementById('pageInfo').textContent = 'Page ' + (data.page || page) + (data.pages ? ' / ' + data.pages : '');
  renderProducts();
}
function renderProducts(){
  const wrap = document.getElementById('cards'); wrap.innerHTML = '';
  if(!PRODUCTS.length){ wrap.innerHTML = '<div class="empty">No parts found. Adjust filters.</div>'; return; }
  PRODUCTS.forEach(p=>{
    const price = Number((p.base_price||0) + FLAT_MARKUP).toFixed(2);
    const el = document.createElement('div'); el.className='card';
    el.innerHTML = '<img alt="'+(p.name||'Part')+'" src="'+(p.image||'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22600%22 height=%22360%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23efefef%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23555%22 font-family=%22Arial%22 font-size=%2220%22%3EImage%20unavailable%3C/text%3E%3C/svg%3E')+'">'+
      '<div class="p"><div class="name">'+p.name+'</div>'+
      '<div class="meta">'+[p.year,p.make,p.model,p.type].filter(Boolean).join(' ')+' <span class="badge">'+(p.category||'')+'</span></div>'+
      '<div class="price">$'+price+'</div>'+
      '<button class="btn wide">Add to Cart</button></div>';
    el.querySelector('button').onclick = ()=> cart.add({id:p.id,name:p.name,price:Number(price)});
    wrap.appendChild(el);
  });
}
function renderCart(){
  const box = document.getElementById('cart-list');
  const items = cart.get();
  box.innerHTML = '';
  if(!items.length){ box.innerHTML='<div class="empty">Your cart is empty.</div>'; updateTotals(); return }
  items.forEach(it=>{
    const row = document.createElement('div'); row.className='row';
    row.innerHTML = '<div><div class="name">'+it.name+'</div><div class="meta">$'+Number(it.price).toFixed(2)+' each</div></div>'+
      '<div class="right"><span>Qty: '+it.qty+'</span><button class="btn">Remove</button></div>';
    row.querySelector('.btn').onclick=()=>{ cart.set(cart.get().filter(p=>p.id!==it.id)); renderCart(); };
    box.appendChild(row);
  });
  updateTotals();
}
function updateTotals(){
  const sub = cart.subtotal();
  const $sub = document.getElementById('cart-subtotal'); if($sub) $sub.textContent = "$" + sub.toFixed(2);
  const $tot = document.getElementById('checkout-total'); if($tot) $tot.textContent = "$" + sub.toFixed(2);
}
function parseHashQuery(){ // for #/success?session_id=cs_...
  const idx = location.hash.indexOf('?'); if(idx<0) return {};
  const q = location.hash.slice(idx+1);
  return Object.fromEntries(new URLSearchParams(q).entries());
}
function route(){
  ['page-home','page-cart','page-checkout','page-success'].forEach(id=>document.getElementById(id).classList.remove('active'));
  if(location.hash.startsWith('#/cart')){ document.getElementById('page-cart').classList.add('active'); renderCart(); }
  else if(location.hash.startsWith('#/checkout')){ document.getElementById('page-checkout').classList.add('active'); updateTotals(); }
  else if(location.hash.startsWith('#/success')){
    document.getElementById('page-success').classList.add('active');
    const qp = parseHashQuery();
    if(qp.session_id){ // confirm & store order
      fetch('/api/orders/confirm?session_id='+encodeURIComponent(qp.session_id), {method:'POST'}).then(r=>r.json()).then(d=>{
        const box = document.getElementById('success-box');
        if(d.id){ box.textContent = '✅ Order #' + d.id + ' confirmed. A receipt will be emailed.'; cart.reset(); }
        else { box.textContent = 'Payment confirmed. (Order store failed)'; }
      }).catch(()=>{});
    }
  }
  else { document.getElementById('page-home').classList.add('active'); }
}
window.addEventListener('hashchange', route);
document.getElementById('yr').textContent = new Date().getFullYear();

document.getElementById('vinBtn').onclick = async ()=>{
  const vin = document.getElementById('vin').value.trim();
  if(vin.length!==17){ alert('VIN must be 17 characters'); return; }
  const r = await fetch('/api/vin/'+vin); const d = await r.json();
  VINVAL = vin;
  if(d.year) document.getElementById('year').value = d.year;
  if(d.make) document.getElementById('make').innerHTML = '<option>'+d.make+'</option>';
  if(d.model) document.getElementById('model').innerHTML = '<option>'+d.model+'</option>';
  if(d.type)  document.getElementById('type').innerHTML  = '<option>'+d.type+'</option>';
  page=1; await fetchProducts();
};
document.getElementById('searchBtn').onclick = ()=>{ page=1; fetchProducts(); };
document.getElementById('prev').onclick = ()=>{ if(page>1){ page--; fetchProducts(); } };
document.getElementById('next').onclick = ()=>{ page++; fetchProducts(); };

const payBtn = document.getElementById('pay-btn');
if(payBtn){ payBtn.addEventListener('click', async ()=>{
  const items = cart.get();
  if(!items.length){ alert('Your cart is empty'); return; }
  const buyer = {
    name: document.getElementById('c-name').value,
    email: document.getElementById('c-email').value,
    address: document.getElementById('c-address').value,
    city: document.getElementById('c-city').value,
    zip: document.getElementById('c-zip').value
  };
  const r = await fetch('/api/checkout', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items, buyer })});
  const data = await r.json();
  if(data.url){ location.href = data.url; } else { alert('Checkout error'); }
}); }

route(); fetchProducts();
</script>
</body>
</html>`;

// -------------------- VIN + Filters + Products --------------------
async function decodeVIN(vin) {
  const data = await getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`);
  const getVal = (label)=> data.Results.find(r=>r.Variable===label)?.Value || "";
  return { make:getVal("Make"), model:getVal("Model"), year:getVal("Model Year"), type:getVal("Body Class") };
}
function applyFilters(list, q) {
  let a = list.slice();
  const filt = (v, f) => !f || String(v||"").toLowerCase() === String(f).toLowerCase();
  if (q.year) a = a.filter(p=>filt(p.year, q.year));
  if (q.make) a = a.filter(p=>filt(p.make, q.make));
  if (q.model) a = a.filter(p=>filt(p.model, q.model));
  if (q.type) a = a.filter(p=>filt(p.type, q.type));
  if (q.category) a = a.filter(p=>filt(p.category, q.category));
  if (q.q) a = a.filter(p => (p.name||"").toLowerCase().includes(String(q.q).toLowerCase()));
  return a;
}
function paginate(list, page=1, per=9) {
  page = Math.max(1, parseInt(page||"1",10)); per = Math.max(1, Math.min(48, parseInt(per||"9",10)));
  const total = list.length; const pages = Math.max(1, Math.ceil(total / per));
  const start = (page-1)*per; const items = list.slice(start, start+per);
  return { items, total, page, pages, per };
}
async function handleProducts(req, res, vin=null) {
  const q = parseQuery(req.url);
  let items = await getCatalogCached();
  if (vin) {
    try {
      const info = await decodeVIN(vin);
      items = items.filter(p =>
        (!info.year||p.year==info.year) &&
        (!info.make||p.make==info.make) &&
        (!info.model||p.model==info.model) &&
        (!info.type||p.type==info.type)
      );
    } catch {}
  }
  items = applyFilters(items, q);
  const pg = paginate(items, q.page, q.per);
  ok(res, "application/json; charset=utf-8", JSON.stringify(pg));
}

// -------------------- Orders (file store) --------------------
async function handleOrderCreate(req, res) {
  const body = await postJson(req);
  const id = crypto.randomBytes(4).toString("hex");
  const order = { id, createdAt: new Date().toISOString(), ...body };
  const p = path.join(__dirname, "orders.json");
  let all = [];
  try { if (fs.existsSync(p)) all = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  all.push(order);
  fs.writeFileSync(p, JSON.stringify(all, null, 2));
  ok(res, "application/json; charset=utf-8", JSON.stringify({ id }));
}

// -------------------- Stripe Checkout --------------------
// Create Checkout Session
async function handleCheckout(req, res) {
  if (!STRIPE_SECRET_KEY) return err(res, 500, "Stripe not configured");
  const { items = [], buyer = {} } = await postJson(req);
  if (!Array.isArray(items) || !items.length) return err(res, 400, "No items");

  // Build line items (use price_data inline)
  const line_items = items.map(it => ({
    price_data: {
      currency: "usd",
      product_data: { name: it.name || "Auto Part" },
      unit_amount: Math.round(Number(it.price) * 100) // cents
    },
    quantity: Number(it.qty || 1)
  }));

  const origin = (req.headers["x-forwarded-proto"] || "https") + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
  const success = CHECKOUT_SUCCESS_URL || `${origin}/#/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancel  = CHECKOUT_CANCEL_URL  || `${origin}/#/checkout`;

  // Form-encoded POST to Stripe
  const payload = formEncode({
    mode: "payment",
    success_url: success,
    cancel_url: cancel,
    "automatic_tax[enabled]": "false",
    "shipping_address_collection[allowed_countries][0]": "US",
    customer_email: buyer.email || "",
    "payment_intent_data[metadata][customer_name]": buyer.name || "",
    "payment_intent_data[metadata][customer_address]": buyer.address || "",
    "payment_intent_data[metadata][customer_city]": buyer.city || "",
    "payment_intent_data[metadata][customer_zip]": buyer.zip || ""
  });

  // Add line_items array to payload (form-encoded)
  let body = payload;
  line_items.forEach((li, i) => {
    body += `&line_items[${i}][quantity]=${encodeURIComponent(li.quantity)}`;
    body += `&line_items[${i}][price_data][currency]=usd`;
    body += `&line_items[${i}][price_data][unit_amount]=${encodeURIComponent(li.price_data.unit_amount)}`;
    body += `&line_items[${i}][price_data][product_data][name]=${encodeURIComponent(li.price_data.product_data.name)}`;
  });

  try {
    const session = await requestJson(
      "POST",
      "https://api.stripe.com/v1/checkout/sessions",
      {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    );
    if (session && session.url) return ok(res, "application/json; charset=utf-8", JSON.stringify({ url: session.url }));
    return err(res, 500, "Stripe session failed");
  } catch (e) {
    console.error("Stripe session error:", e.message);
    return err(res, 500, "Stripe error");
  }
}

// Confirm paid session and store order
async function handleOrderConfirm(req, res) {
  if (!STRIPE_SECRET_KEY) return err(res, 500, "Stripe not configured");
  const { session_id } = parseQuery(req.url);
  if (!session_id) return err(res, 400, "Missing session_id");
  try {
    const session = await requestJson(
      "GET",
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`,
      { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` }
    );
    if (!session || session.payment_status !== "paid") return err(res, 402, "Payment not confirmed");
    // Build a minimal order from session
    const order = {
      id: crypto.randomBytes(4).toString("hex"),
      stripe_session_id: session.id,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: session.customer_details?.email || session.customer_email || "",
      createdAt: new Date().toISOString()
    };
    const p = path.join(__dirname, "orders.json");
    let all = [];
    try { if (fs.existsSync(p)) all = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    all.push(order);
    fs.writeFileSync(p, JSON.stringify(all, null, 2));
    ok(res, "application/json; charset=utf-8", JSON.stringify({ id: order.id }));
  } catch (e) {
    console.error("Order confirm error:", e);
    return err(res, 500, "Confirm failed");
  }
}

// -------------------- Admin ingest + SEO --------------------
async function handleIngest(req, res) {
  const auth = req.headers["authorization"] || "";
  if (!ADMIN_TOKEN || auth !== `Bearer ${ADMIN_TOKEN}`) return err(res, 401, "Unauthorized");
  await loadCatalogFresh();
  ok(res, "application/json; charset=utf-8", JSON.stringify({ ok:true, count: CATALOG_CACHE.items.length }));
}
function robots() { return "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n"; }
function sitemap() {
  const urls = ["/","/cart","/checkout","/success"].map(u=>`<url><loc>${u}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

// -------------------- Server --------------------
const server = http.createServer(async (req, res) => {
  try {
    // Products
    if (req.method === "GET" && req.url.startsWith("/api/products/")) {
      const vin = req.url.split("/api/products/")[1].split("?")[0];
      return await handleProducts(req, res, vin);
    }
    if (req.method === "GET" && req.url.startsWith("/api/products")) {
      return await handleProducts(req, res);
    }
    // VIN
    if (req.method === "GET" && req.url.startsWith("/api/vin/")) {
      const vin = req.url.split("/").pop();
      try { return ok(res, "application/json; charset=utf-8", JSON.stringify(await decodeVIN(vin))); }
      catch { return err(res, 500, "VIN decode failed"); }
    }
    // Orders (demo write)
    if (req.method === "POST" && req.url === "/api/orders") return await handleOrderCreate(req, res);
    // Stripe
    if (req.method === "POST" && req.url === "/api/checkout") return await handleCheckout(req, res);
    if (req.method === "POST" && req.url.startsWith("/api/orders/confirm")) return await handleOrderConfirm(req, res);
    // Admin
    if (req.method === "POST" && req.url === "/admin/ingest") return await handleIngest(req, res);
    // Health + SEO
    if (req.method === "GET" && req.url === "/health") return ok(res, "text/plain; charset=utf-8", "ok");
    if (req.method === "GET" && req.url === "/robots.txt") return ok(res, "text/plain; charset=utf-8", robots());
    if (req.method === "GET" && req.url === "/sitemap.xml") return ok(res, "application/xml; charset=utf-8", sitemap());

    // App
    return ok(res, "text/html; charset=utf-8", HTML);
  } catch (e) {
    console.error("Server error:", e);
    return err(res, 500, "Server error");
  }
});

server.listen(PORT, () => {
  console.log(`✅ Ohio Auto Parts running on ${PORT}`);
});
