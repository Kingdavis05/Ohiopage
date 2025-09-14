// server.js
// Ohio Auto Parts – all-in-one (eBay-style UI + VIN modal + 1991–2026 years + cart/checkout + full results
// + AI image & cheapest + dropship queue + ENHANCED SEARCH (auto-image + AI fallback))

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// ---- tiny helper to safely embed HTML with backticks ----
function heredoc(fn) {
  return String(fn)
    .replace(/^[^{]*{\s*\/\*!?/, "")
    .replace(/\*\/\s*}\s*$/, "");
}

// ---- ENV ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_xxx";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_xxx";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY || ""; // optional live rates
const SHIP_FROM_NAME = process.env.SHIP_FROM_NAME || "Ohio Auto Parts";
const SHIP_FROM_STREET1 = process.env.SHIP_FROM_STREET1 || "123 Warehouse Rd";
const SHIP_FROM_CITY = process.env.SHIP_FROM_CITY || "Columbus";
const SHIP_FROM_STATE = process.env.SHIP_FROM_STATE || "OH";
const SHIP_FROM_ZIP = process.env.SHIP_FROM_ZIP || "43004";
const SHIP_FROM_COUNTRY = process.env.SHIP_FROM_COUNTRY || "US";
const SHIP_FROM_PHONE = process.env.SHIP_FROM_PHONE || "5555555555";
const SHIP_FROM_EMAIL = process.env.SHIP_FROM_EMAIL || "support@example.com";

// Optional adapters (set the keys in Render for real data)
const PARTSTECH_API_KEY = process.env.PARTSTECH_API_KEY || ""; // OEM/aftermarket catalog
const SERPAPI_KEY = process.env.SERPAPI_KEY || ""; // Google Shopping/Images via SerpAPI
const EBAY_APP_ID  = process.env.EBAY_APP_ID  || ""; // eBay Finding API

// Dropship processing: post orders to your fulfillment webhook
const DROPSHIP_WEBHOOK_URL = process.env.DROPSHIP_WEBHOOK_URL || ""; // if set, orders are POSTed here

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme-admin";

// ---- GLOBALS / POLYFILLS ----
try { if (!globalThis.fetch) globalThis.fetch = require("undici").fetch; } catch {}
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));
process.on("uncaughtException", e => console.error("[uncaughtException]", e));

const stripe = require("stripe")(STRIPE_SECRET_KEY);

// ---- DB (memory with optional Postgres) ----
let db = { useMemory: true };
let pgPool = null;

(async () => {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require("pg");
      pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pgPool.query("select 1");
      db.useMemory = false;
      await migrate();
      await ensureSeed();
      console.log("[DB] Postgres connected");
    } catch (e) {
      console.warn("[DB] Falling back to in-memory:", e.message);
      db = memoryDB(); await ensureSeed();
    }
  } else { db = memoryDB(); await ensureSeed(); }
})();

function memoryDB() {
  const state = { products: [], orders: [] };
  return {
    useMemory: true,
    async migrate(){},
    async seedProducts(items){ state.products = items; },
    async listProducts(filter){
      const q = (filter.q||"").toLowerCase();
      let all = state.products.filter(p =>
        (!filter.make  || p.make  === filter.make) &&
        (!filter.model || p.model === filter.model) &&
        (!filter.year  || p.year  === filter.year) &&
        (!filter.oemFlag || (filter.oemFlag === "oem" ? p.oem : !p.oem)) &&
        (!filter.q || (p.name.toLowerCase().includes(q) || p.part_type.toLowerCase().includes(q)))
      );
      if (filter.min) all = all.filter(p => p.price_cents >= filter.min);
      if (filter.max) all = all.filter(p => p.price_cents <= filter.max);
      return all;
    },
    async getProduct(id){ return state.products.find(p => p.id === id); },
    async updateProductImage(id, url){ const p = state.products.find(x=>x.id===id); if (p) p.image_url = url; return p; },
    async saveOrder(order){ state.orders.push(order); return order; },
    async listOrders(){ return state.orders; }
  };
}
async function migrate() {
  if (db.useMemory) return;
  await pgPool.query(`
    create table if not exists products(
      id text primary key,
      name text not null,
      make text not null,
      model text not null,
      year integer not null,
      part_type text not null,
      price_cents integer not null,
      stock integer not null default 0,
      image_url text,
      weight_lb real default 2.0,
      dim_l_in real default 10.0,
      dim_w_in real default 8.0,
      dim_h_in real default 4.0,
      oem boolean default true
    );
    create table if not exists orders(
      id text primary key,
      stripe_pi text,
      amount_cents integer,
      currency text,
      email text,
      name text,
      address jsonb,
      items jsonb,
      shipping jsonb,
      status text,
      created_at timestamptz default now()
    );
  `);
}
async function dbGetProduct(id) {
  if (db.useMemory) return db.getProduct(id);
  const { rows } = await pgPool.query("select * from products where id=$1",[id]);
  return rows[0] || null;
}
async function dbListProducts(filter) {
  if (db.useMemory) return db.listProducts(filter);
  const q = (filter.q||"").toLowerCase();
  let where = [], vals = [];
  if (filter.make)  { vals.push(filter.make);  where.push(`make=$${vals.length}`); }
  if (filter.model) { vals.push(filter.model); where.push(`model=$${vals.length}`); }
  if (filter.year)  { vals.push(filter.year);  where.push(`year=$${vals.length}`); }
  if (filter.oemFlag) where.push(filter.oemFlag === "oem" ? "oem=true" : "oem=false");
  if (filter.min) { vals.push(filter.min); where.push(`price_cents >= $${vals.length}`); }
  if (filter.max) { vals.push(filter.max); where.push(`price_cents <= $${vals.length}`); }
  if (q) { vals.push(`%${q}%`); where.push(`(lower(name) like $${vals.length} or lower(part_type) like $${vals.length})`); }
  const sql = `select * from products ${where.length?'where '+where.join(' and '):''} order by stock desc, name`;
  const { rows } = await pgPool.query(sql, vals);
  return rows;
}
async function dbUpdateProductImage(id, url){
  if (db.useMemory) return db.updateProductImage(id, url);
  await pgPool.query("update products set image_url=$2 where id=$1",[id,url]);
  return dbGetProduct(id);
}
async function dbSaveOrder(o) {
  if (db.useMemory) return db.saveOrder(o);
  const sql = `insert into orders(id,stripe_pi,amount_cents,currency,email,name,address,items,shipping,status)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  await pgPool.query(sql,[o.id,o.stripe_pi,o.amount_cents,o.currency,o.email,o.name,o.address,o.items,o.shipping,o.status]);
  return o;
}

// ---- Seed data ----
const YEARS_FULL = Array.from({length:(2026-1991+1)}, (_,i)=>1991+i);
function sampleProducts() {
  const pick = a => a[Math.floor(Math.random()*a.length)];
  const MAKES = ["Ford","Chevrolet","GMC","Ram","Dodge","Chrysler","Jeep","Cadillac","Buick","Lincoln","Tesla",
    "BMW","Mercedes-Benz","Audi","Volkswagen","Porsche","Opel","Mini","Smart","Volvo","Peugeot","Renault","Citroën","Fiat","Alfa Romeo","Lancia","SEAT","Škoda","Dacia",
    "Land Rover","Jaguar","Aston Martin","Bentley","Rolls-Royce","Lotus","McLaren","Cupra","Iveco"];
  const MODELS = {
    Ford:["F-150","Mustang","Explorer","Ranger","Transit","Bronco"],
    Chevrolet:["Silverado","Colorado","Tahoe","Suburban","Camaro","Equinox"],
    GMC:["Sierra","Yukon","Acadia","Terrain","Canyon"],
    Ram:["1500","2500","ProMaster"],
    Dodge:["Charger","Challenger","Durango"],
    Chrysler:["300","Pacifica","Voyager"],
    Jeep:["Wrangler","Grand Cherokee","Compass","Gladiator"],
    Cadillac:["Escalade","XT5","CT5","Lyriq"],
    Buick:["Enclave","Envision"],
    Lincoln:["Aviator","Navigator"],
    Tesla:["Model 3","Model Y","Model S","Model X","Cybertruck"],
    BMW:["3 Series","5 Series","X3","X5","i4"],
    "Mercedes-Benz":["C-Class","E-Class","GLC","GLE","EQE"],
    Audi:["A4","A6","Q5","Q7","Q8"],
    Volkswagen:["Golf","Jetta","Passat","Tiguan","Atlas","ID.4"],
    Porsche:["911","Cayenne","Macan","Taycan"],
    Volvo:["XC40","XC60","XC90","S60","EX30"],
    Peugeot:["208","308","3008","5008"],
    Renault:["Clio","Megane","Captur","Scenic"],
    Citroën:["C3","C4","C5 Aircross"],
    Fiat:["500","Panda","Tipo","Ducato"],
    "Alfa Romeo":["Giulia","Stelvio","Tonale"],
    Lancia:["Ypsilon"],
    SEAT:["Ibiza","Leon","Ateca"],
    "Škoda":["Fabia","Octavia","Kodiaq","Enyaq"],
    Dacia:["Sandero","Logan","Duster","Jogger"],
    "Land Rover":["Defender","Discovery","Range Rover","Evoque"],
    Jaguar:["XF","F-PACE","I-PACE"],
    "Aston Martin":["Vantage","DB12","DBX"],
    Bentley:["Bentayga","Continental GT"],
    "Rolls-Royce":["Ghost","Phantom","Cullinan"],
    Lotus:["Emira","Eletre"],
    McLaren:["Artura","750S","GT"],
    Cupra:["Leon","Formentor","Born"],
    Iveco:["Daily","Eurocargo"]
  };
  const PARTS = [
    ["Brake Pads", 6, 8,6,4],["Brake Rotors", 28, 14,14,4],["Alternator", 14, 10,8,8],
    ["Starter", 12, 10,8,8],["Battery", 38, 12,7,9],["Oil Filter", 2, 4,4,4],["Air Filter", 3, 12,8,2],
    ["Cabin Filter", 2, 10,8,2],["Spark Plugs", 1, 6,4,2],["Ignition Coils", 3, 8,6,4],
    ["Radiator", 24, 32,6,24],["Water Pump", 8, 8,8,6],["Thermostat", 1, 4,4,3],
    ["Shock Absorber", 10, 24,4,4],["Control Arm", 9, 18,6,4],["Wheel Bearing", 7, 6,6,4],
    ["O2 Sensor", 1, 6,4,2],["Catalytic Converter", 20, 24,10,8],
    ["AC Compressor", 16, 12,10,10],["Headlight Assembly", 9, 18,12,10],["Taillight", 6, 16,8,8],
    ["Mirror", 5, 14,10,6],["Bumper", 30, 65,12,12],["Grille", 12, 36,10,6]
  ];
  const imgs = [
    "https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?q=80&w=800&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1517747614396-d21a78b850e8?q=80&w=800&auto=format&fit=crop"
  ];
  const out = [];
  for (let i=0;i<520;i++){
    const make = pick(MAKES);
    const model = pick(MODELS[make]);
    const [part, weight_lb, L, W, H] = pick(PARTS);
    const year = pick(YEARS_FULL);
    const price = (Math.floor(Math.random()*220)+35)*100;
    out.push({
      id: crypto.randomUUID(),
      name: year + " " + make + " " + model + " – " + part,
      make, model, year, part_type: part,
      price_cents: price,
      stock: Math.floor(Math.random()*24),
      image_url: Math.random()<0.6 ? pick(imgs) : null,
      weight_lb, dim_l_in: L, dim_w_in: W, dim_h_in: H,
      oem: Math.random() < 0.55
    });
  }
  return out;
}
async function ensureSeed() {
  const items = sampleProducts();
  if (db.useMemory) { await db.seedProducts(items); return; }
  const { rows } = await pgPool.query("select count(*)::int as c from products");
  if (rows[0].c < 150) {
    const q = `insert into products(id,name,make,model,year,part_type,price_cents,stock,image_url,weight_lb,dim_l_in,dim_w_in,dim_h_in,oem)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               on conflict (id) do nothing`;
    for (const p of items) {
      await pgPool.query(q,[p.id,p.name,p.make,p.model,p.year,p.part_type,p.price_cents,p.stock,p.image_url,p.weight_lb,p.dim_l_in,p.dim_w_in,p.dim_h_in,p.oem]);
    }
  }
}

// ---- App / Webhooks ----
const app = express();

// Stripe webhook must read the raw body:
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  let event = req.body;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    }
  } catch (err) { return res.status(400).send("Webhook Error: " + err.message); }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    const order = {
      id: crypto.randomUUID(),
      stripe_pi: pi.id,
      amount_cents: pi.amount_received || pi.amount,
      currency: pi.currency,
      email: (pi.charges?.data?.[0]?.billing_details?.email) || null,
      name: (pi.charges?.data?.[0]?.billing_details?.name) || null,
      address: (pi.charges?.data?.[0]?.billing_details?.address) || null,
      items: pi.metadata?.items ? JSON.parse(pi.metadata.items) : [],
      shipping: pi.metadata?.shipping ? JSON.parse(pi.metadata.shipping) : null,
      status: "paid"
    };
    await dbSaveOrder(order);
    await queueDropship(order);
  }
  res.json({ received: true });
});

app.use(bodyParser.json());

app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/config", (_req, res) => res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY }));

// ---- Catalog APIs ----
const MAKES = ["Ford","Chevrolet","GMC","Ram","Dodge","Chrysler","Jeep","Cadillac","Buick","Lincoln","Tesla",
  "BMW","Mercedes-Benz","Audi","Volkswagen","Porsche","Opel","Mini","Smart","Volvo","Peugeot","Renault","Citroën","Fiat","Alfa Romeo","Lancia","SEAT","Škoda","Dacia",
  "Land Rover","Jaguar","Aston Martin","Bentley","Rolls-Royce","Lotus","McLaren","Cupra","Iveco"].sort();
const MODELS = {
  Ford:["F-150","Mustang","Explorer","Ranger","Transit","Bronco"],
  Chevrolet:["Silverado","Colorado","Tahoe","Suburban","Camaro","Equinox"],
  GMC:["Sierra","Yukon","Acadia","Terrain","Canyon"],
  Ram:["1500","2500","ProMaster"],
  Dodge:["Charger","Challenger","Durango"],
  Chrysler:["300","Pacifica","Voyager"],
  Jeep:["Wrangler","Grand Cherokee","Compass","Gladiator"],
  Cadillac:["Escalade","XT5","CT5","Lyriq"],
  Buick:["Enclave","Envision"],
  Lincoln:["Aviator","Navigator"],
  Tesla:["Model 3","Model Y","Model S","Model X","Cybertruck"],
  BMW:["3 Series","5 Series","X3","X5","i4"],
  "Mercedes-Benz":["C-Class","E-Class","GLC","GLE","EQE"],
  Audi:["A4","A6","Q5","Q7","Q8"],
  Volkswagen:["Golf","Jetta","Passat","Tiguan","Atlas","ID.4"],
  Porsche:["911","Cayenne","Macan","Taycan"],
  Volvo:["XC40","XC60","XC90","S60","EX30"],
  Peugeot:["208","308","3008","5008"],
  Renault:["Clio","Megane","Captur","Scenic"],
  Citroën:["C3","C4","C5 Aircross"],
  Fiat:["500","Panda","Tipo","Ducato"],
  "Alfa Romeo":["Giulia","Stelvio","Tonale"],
  Lancia:["Ypsilon"],
  SEAT:["Ibiza","Leon","Ateca"],
  "Škoda":["Fabia","Octavia","Kodiaq","Enyaq"],
  Dacia:["Sandero","Logan","Duster","Jogger"],
  "Land Rover":["Defender","Discovery","Range Rover","Evoque"],
  Jaguar:["XF","F-PACE","I-PACE"],
  "Aston Martin":["Vantage","DB12","DBX"],
  Bentley:["Bentayga","Continental GT"],
  "Rolls-Royce":["Ghost","Phantom","Cullinan"],
  Lotus:["Emira","Eletre"],
  McLaren:["Artura","750S","GT"],
  Cupra:["Leon","Formentor","Born"],
  Iveco:["Daily","Eurocargo"]
};
function PARTS(){
  return ["Alternator","Battery","Starter","Spark Plugs","Ignition Coils","ECU","MAF Sensor","MAP Sensor","O2 Sensor",
    "Oil Filter","Air Filter","Cabin Filter","Fuel Filter","Fuel Pump","Radiator","Water Pump","Thermostat","Timing Belt/Chain",
    "Serpentine Belt","Turbocharger","Supercharger","Catalytic Converter","Exhaust Muffler","Brake Pads","Brake Rotors","Calipers",
    "ABS Sensor","Master Cylinder","Suspension Strut","Shock Absorber","Control Arm","Ball Joint","Tie Rod","Wheel Bearing","Axle/CV Joint",
    "AC Compressor","Condenser","Heater Core","Power Steering Pump","Rack and Pinion","Clutch Kit","Flywheel","Transmission Filter/Fluid",
    "Headlight Assembly","Taillight","Mirror","Bumper","Fender","Hood","Grille","Door Handle","Window Regulator","Wiper Blades","Floor Mats","Roof Rack","Infotainment Screen"];
}
app.get("/api/makes", (_req, res) => res.json(MAKES));
app.get("/api/models", (req, res) => res.json(MODELS[req.query.make] || []));
app.get("/api/years", (_req, res) => res.json([].concat(YEARS_FULL).reverse()));
app.get("/api/parts", (_req,res)=>res.json(PARTS()));

// Base products (still available for internal use)
app.get("/api/products", async (req, res) => {
  const { make, model, year, q, oem, min_price, max_price, page, page_size } = req.query;
  const filter = {
    make, model,
    year: year ? parseInt(year,10) : undefined,
    q: (q||"").toLowerCase(),
    oemFlag: oem,
    min: min_price ? parseInt(min_price,10) : undefined,
    max: max_price ? parseInt(max_price,10) : undefined
  };
  const list = await (db.useMemory ? db.listProducts(filter) : dbListProducts(filter));
  const ps = Math.min(parseInt(page_size||"60",10), 200);
  const pg = Math.max(1, parseInt(page||"1",10));
  const start = (pg-1)*ps, end = start + ps;
  res.json({ total: list.length, page: pg, page_size: ps, items: list.slice(start,end) });
});

// ---- VIN ----
async function decodeVIN_NHTSA(vin){
  try{
    const u = new URL("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValues/" + encodeURIComponent(vin) + "?format=json");
    const r = await fetch(u); if(!r.ok) return null; const j = await r.json();
    const row = j && j.Results && j.Results[0] ? j.Results[0] : {};
    const make = row.Make || null;
    const model = row.Model || null;
    const year = row.ModelYear ? parseInt(row.ModelYear,10) : null;
    return { make, model, year };
  }catch{ return null; }
}
app.get("/api/vin/decode", async (req, res) => {
  const vin = (req.query.vin||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  if (vin.length !== 17) return res.json({ ok:false, error:"VIN must be 17 characters." });
  const meta = await decodeVIN_NHTSA(vin);
  if (!meta) return res.json({ ok:false, error:"VIN decode failed." });
  res.json({ ok:true, vin, ...meta });
});

// Optional: PartsTech OEM/aftermarket matches
async function searchPartsTech({ make, model, year, partQuery }){
  if (!PARTSTECH_API_KEY) return null;
  try {
    const url = "https://api.partstech.com/catalog/search";
    const body = { make, model, year, q: partQuery, limit: 10 };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization": "Bearer " + PARTSTECH_API_KEY },
      body: JSON.stringify(body)
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data.items||[]).map(it => ({
      sku: it.sku || it.partNumber || it.id,
      brand: it.brand || it.manufacturer,
      name: it.title || it.name,
      oem: !!it.oem,
      price: parseFloat(it.price || it.listPrice || 0),
      link: it.link || it.url || null,
      image: it.image || it.imageUrl || null
    }));
  } catch { return null; }
}
app.post("/api/vin/parts", async (req, res) => {
  try{
    let vin = (req.body && req.body.vin || "").toUpperCase();
    const part = (req.body && req.body.part) || "";
    const decoded = await decodeVIN_NHTSA(vin);
    if (!decoded) return res.status(400).json({ error: "VIN decode failed" });
    const make = decoded.make, model = decoded.model, year = decoded.year;

    let items = await searchPartsTech({ make, model, year, partQuery: part });
    if (!items || !items.length) {
      const local = await (db.useMemory ? db.listProducts({ make, model, year, q: (part||"").toLowerCase() })
                                        : dbListProducts({ make, model, year, q: (part||"").toLowerCase() }));
      items = local.map(p => ({
        sku: p.id, brand: p.oem ? "OEM" : "Aftermarket", name: p.name, oem: !!p.oem,
        price: p.price_cents/100, link: null, image: p.image_url
      }));
    }
    res.json({ make, model, year, items });
  } catch(e){ res.status(400).json({ error: e.message }); }
});

// ---- AI image search helpers ----
async function fetchImageFromSerpAPI(query){
  if (!SERPAPI_KEY) return null;
  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine","google_images");
    url.searchParams.set("q", query);
    url.searchParams.set("gl","us");
    url.searchParams.set("api_key", SERPAPI_KEY);
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const json = await resp.json();
    const imgs = json.images_results || [];
    for (let i=0;i<imgs.length;i++) {
      const it = imgs[i];
      const link = it.original || it.thumbnail || it.source || it.link;
      if (link && /^https?:\/\//.test(link)) return link;
    }
    return null;
  } catch { return null; }
}
async function fetchImageFromEbay(query){
  if (!EBAY_APP_ID) return null;
  try{
    const url = new URL("https://svcs.ebay.com/services/search/FindingService/v1");
    url.searchParams.set("OPERATION-NAME","findItemsByKeywords");
    url.searchParams.set("SERVICE-VERSION","1.0.0");
    url.searchParams.set("SECURITY-APPNAME", EBAY_APP_ID);
    url.searchParams.set("RESPONSE-DATA-FORMAT","JSON");
    url.searchParams.set("keywords", query);
    url.searchParams.set("paginationInput.entriesPerPage","10");
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const json = await resp.json();
    const arr = json.findItemsByKeywordsResponse && json.findItemsByKeywordsResponse[0] &&
                json.findItemsByKeywordsResponse[0].searchResult &&
                json.findItemsByKeywordsResponse[0].searchResult[0] &&
                json.findItemsByKeywordsResponse[0].searchResult[0].item || [];
    for (let i=0;i<arr.length;i++) {
      const it = arr[i];
      const img = (it.pictureURLSuperSize && it.pictureURLSuperSize[0]) || (it.galleryURL && it.galleryURL[0]);
      if (img) return img;
    }
    return null;
  }catch{ return null; }
}
app.post("/api/ai/image", async (req, res) => {
  try {
    const body = req.body || {};
    const product_id = body.product_id;
    const make = body.make, model = body.model, year = body.year, part = body.part;
    let p = product_id ? await dbGetProduct(product_id) : null;
    const q = p ? (p.year + " " + p.make + " " + p.model + " " + p.part_type) :
                  [year, make, model, part].filter(Boolean).join(" ");
    let url = await fetchImageFromSerpAPI(q);
    if (!url) url = await fetchImageFromEbay(q);
    if (!url) url = "https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop";
    if (p) { p = await dbUpdateProductImage(p.id, url); }
    res.json({ ok:true, image_url: url, product: p || null });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message });
  }
});

// ---- AI cheapest + 75% markup ----
async function cheapestSerp(query){
  if (!SERPAPI_KEY) return null;
  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine","google_shopping");
    url.searchParams.set("q", query);
    url.searchParams.set("gl","us");
    url.searchParams.set("api_key", SERPAPI_KEY);
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const json = await resp.json();
    const items = json.shopping_results || [];
    let best = null;
    for (let i=0;i<items.length;i++) {
      const it = items[i];
      const price = parseFloat(String(it.price||"").replace(/[^0-9.]/g,""));
      if (Number.isFinite(price)) { if(!best || price < best.price) best = { price, title: it.title, link: it.link, source: "Google Shopping" }; }
    }
    return best;
  } catch { return null; }
}
async function cheapestEbay(query){
  if (!EBAY_APP_ID) return null;
  try{
    const url = new URL("https://svcs.ebay.com/services/search/FindingService/v1");
    url.searchParams.set("OPERATION-NAME","findItemsByKeywords");
    url.searchParams.set("SERVICE-VERSION","1.0.0");
    url.searchParams.set("SECURITY-APPNAME", EBAY_APP_ID);
    url.searchParams.set("RESPONSE-DATA-FORMAT","JSON");
    url.searchParams.set("keywords", query);
    url.searchParams.set("paginationInput.entriesPerPage","10");
    const resp = await fetch(url.toString());
    if (!resp.ok) return null;
    const json = await resp.json();
    const arr = json.findItemsByKeywordsResponse && json.findItemsByKeywordsResponse[0] &&
                json.findItemsByKeywordsResponse[0].searchResult &&
                json.findItemsByKeywordsResponse[0].searchResult[0] &&
                json.findItemsByKeywordsResponse[0].searchResult[0].item || [];
    let best=null;
    for (let i=0;i<arr.length;i++) {
      const it = arr[i];
      const p = parseFloat(it.sellingStatus && it.sellingStatus[0] && it.sellingStatus[0].currentPrice && it.sellingStatus[0].currentPrice[0] && it.sellingStatus[0].currentPrice[0].__value__ || "NaN");
      const title = it.title && it.title[0];
      const link = it.viewItemURL && it.viewItemURL[0];
      if (Number.isFinite(p)) { if(!best || p < best.price) best = { price:p, title, link, source:"eBay" }; }
    }
    return best;
  }catch{ return null; }
}
function markup75(price){ return Math.round(price * 1.75 * 100); } // to cents
app.post("/api/market/cheapest", async (req, res) => {
  try {
    const body = req.body || {};
    const make = body.make, model = body.model, year = body.year, part = body.part;
    const q = [year, make, model, part, "OEM OR Aftermarket"].filter(Boolean).join(" ");
    let best = await cheapestSerp(q);
    if (!best) best = await cheapestEbay(q);
    if (!best) {
      const base = /rotor|radiator|bumper|compressor|converter/i.test(part||"") ? 180
                : /alternator|shock|control|bearing|headlight/i.test(part||"") ? 120
                : /filter|plug|sensor/i.test(part||"") ? 28 : 75;
      best = { price: base, title: (String(year||"")+" "+String(make||"")+" "+String(model||"")+" "+String(part||"")).trim(), link: null, source: "Heuristic" };
    }
    const product = {
      id: "ai-"+crypto.randomUUID(),
      name: (String(year||"")+" "+String(make||"")+" "+String(model||"")+" – "+String(part||"")+" (AI-sourced)").replace(/\s+/g," ").trim(),
      make, model, year: year?parseInt(year,10):undefined,
      part_type: part, price_cents: markup75(best.price), stock: 5,
      image_url: null, source_price: best.price, source_link: best.link, source_from: best.source
    };
    res.json({ product });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ================== ENHANCED SEARCH (auto-image + AI fallback) ==================
function fallbackImage() {
  return "https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop";
}
async function ensureImageForProduct(p) {
  try {
    if (p.image_url) return p.image_url;
    const q = [p.year, p.make, p.model, p.part_type].filter(Boolean).join(" ");
    let url = await fetchImageFromSerpAPI(q);
    if (!url) url = await fetchImageFromEbay(q);
    if (!url) url = fallbackImage();
    await dbUpdateProductImage(p.id, url);
    p.image_url = url;
    return url;
  } catch {
    p.image_url = p.image_url || fallbackImage();
    return p.image_url;
  }
}
app.get("/api/search/enhanced", async (req, res) => {
  try {
    const { make, model, year, q, oem, min_price, max_price, page, page_size } = req.query;
    const filter = {
      make, model,
      year: year ? parseInt(year,10) : undefined,
      q: (q||"").toLowerCase(),
      oemFlag: oem,
      min: min_price ? parseInt(min_price,10) : undefined,
      max: max_price ? parseInt(max_price,10) : undefined
    };

    const list = await (db.useMemory ? db.listProducts(filter) : dbListProducts(filter));
    const total = list.length;

    const ps = Math.min(parseInt(page_size||"60",10), 200);
    const pg = Math.max(1, parseInt(page||"1",10));
    const start = (pg-1)*ps, end = start + ps;
    let items = list.slice(start, end);

    // Ensure images for a handful of items on this page
    const NEEDS = items.filter(p => !p.image_url).slice(0, 12);
    for (const p of NEEDS) { await ensureImageForProduct(p); }

    if (total === 0) {
      const partHint = (q||"").trim() || "auto part";
      const queryForMarket = [year, make, model, partHint, "OEM OR Aftermarket"].filter(Boolean).join(" ");
      let best = await cheapestSerp(queryForMarket);
      if (!best) best = await cheapestEbay(queryForMarket);

      let sourcePrice = best && best.price ? best.price : (
        /rotor|radiator|bumper|compressor|converter/i.test(partHint) ? 180 :
        /alternator|shock|control|bearing|headlight/i.test(partHint) ? 120 :
        /filter|plug|sensor/i.test(partHint) ? 28 : 75
      );

      const aiProduct = {
        id: "ai-" + crypto.randomUUID(),
        name: `${year||""} ${make||""} ${model||""} – ${partHint} (AI-sourced)`.replace(/\s+/g," ").trim(),
        make, model, year: year?parseInt(year,10):undefined,
        part_type: partHint,
        price_cents: Math.round(sourcePrice * 1.75 * 100),
        stock: 5,
        oem: false,
        image_url: null,
        source_price: sourcePrice,
        source_link: best ? best.link : null,
        source_from: best ? best.source : "Heuristic",
        ai_sourced: true
      };
      const imgQ = [year, make, model, partHint].filter(Boolean).join(" ");
      aiProduct.image_url = await fetchImageFromSerpAPI(imgQ) || await fetchImageFromEbay(imgQ) || fallbackImage();

      return res.json({ total: 1, page: 1, page_size: 1, items: [aiProduct] });
    }

    res.json({ total, page: pg, page_size: ps, items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// ===============================================================================

// ---- Shipping rates (EasyPost or heuristic) ----
function ozFromLb(lb){ return Math.max(1, Math.round(lb * 16)); }
async function easypostRates({ to, parcel }){
  const url = "https://api.easypost.com/v2/shipments";
  const payload = { shipment: {
    to_address: {
      name: to.name||"Customer", street1: to.line1, street2: to.line2||"",
      city: to.city, state: to.state, zip: to.postal_code, country: to.country||"US",
      phone: to.phone||"0000000000", email: to.email||"cust@example.com", residential: !!to.residential
    },
    from_address: {
      name: SHIP_FROM_NAME, street1: SHIP_FROM_STREET1, city: SHIP_FROM_CITY, state: SHIP_FROM_STATE,
      zip: SHIP_FROM_ZIP, country: SHIP_FROM_COUNTRY, phone: SHIP_FROM_PHONE, email: SHIP_FROM_EMAIL
    },
    parcel: { length: Math.max(1, Math.round(parcel.l)), width: Math.max(1, Math.round(parcel.w)), height: Math.max(1, Math.round(parcel.h)), weight: Math.max(1, ozFromLb(parcel.weight_lb)) }
  }};
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization": "Basic " + Buffer.from(EASYPOST_API_KEY + ":").toString("base64") },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error("EasyPost " + resp.status + " " + (await resp.text()));
  const json = await resp.json();
  return (json.rates||[])
    .filter(r => ["UPS","FedEx","DHLExpress","USPS","DHL eCommerce"].includes(r.carrier))
    .map(r => ({ carrier: String(r.carrier).replace("DHLExpress","DHL"), service: r.service, days: r.delivery_days||null, amount_cents: Math.round(parseFloat(r.rate)*100) }))
    .sort((a,b)=>a.amount_cents-b.amount_cents)
    .slice(0,6);
}
function heuristicRates({ domestic, billable, zoneMult, residentialFee, remoteFee, insurance }){
  function baseGround(bw){ return 8 + 0.55*bw; }
  function base2Day(bw){ return 15 + 0.95*bw; }
  function baseOvernight(bw){ return 24 + 1.45*bw; }
  function baseIntlExpress(bw){ return 32 + 1.65*bw; }
  function toCents(n){ return Math.max(1, Math.round(n*100)); }
  const fuel = 0.12;
  const quote = (carrier,service,days,base)=>{
    let amt = base * zoneMult; amt += residentialFee + remoteFee + insurance; amt *= 1+fuel;
    return { carrier, service, days, amount_cents: toCents(amt) };
  };
  if (domestic) return [
    quote("UPS","Ground",3, baseGround(billable)),
    quote("FedEx","Ground",3, baseGround(billable)*0.98),
    quote("UPS","2nd Day Air",2, base2Day(billable)),
    quote("FedEx","2Day",2, base2Day(billable)*0.99),
    quote("FedEx","Standard Overnight",1, baseOvernight(billable))
  ].sort((a,b)=>a.amount_cents-b.amount_cents);
  return [
    quote("DHL","Express Worldwide",4, baseIntlExpress(billable)),
    quote("UPS","Worldwide Saver",5, baseIntlExpress(billable)*1.05),
    quote("FedEx","International Priority",4, baseIntlExpress(billable)*1.03)
  ].sort((a,b)=>a.amount_cents-b.amount_cents);
}
app.post("/api/shipping/rates", async (req, res) => {
  try {
    const body = req.body || {};
    const address = body.address || {};
    const cart = body.cart || [];
    const subtotal_cents = body.subtotal_cents || 0;
    const to = {
      name: address.name||"", email: address.email||"",
      line1: address.line1||"", line2: address.line2||"", city: address.city||"", state: address.state||"",
      postal_code: address.postal_code||"", country: (address.country||"US").toUpperCase(), residential: !!address.residential
    };
    // Aggregate to one parcel
    let totalWeightLb = 0, dimL=0, dimW=0, dimH=0;
    for (let i=0;i<cart.length;i++) {
      const item = cart[i];
      const p = await dbGetProduct(item.id); if (!p) continue;
      const qty = Math.max(1, parseInt(item.qty||1,10));
      totalWeightLb += (p.weight_lb||2)*qty;
      dimL = Math.max(dimL, p.dim_l_in||10);
      dimW = Math.max(dimW, p.dim_w_in||8);
      dimH += (p.dim_h_in||4)*qty;
    }
    if (totalWeightLb<=0) totalWeightLb=2;
    const billable = Math.max(totalWeightLb, (dimL*dimW*dimH)/139);
    const domestic = to.country==="US";

    let quotes = [];
    if (EASYPOST_API_KEY && to.postal_code && to.city && to.state && to.line1) {
      try { quotes = await easypostRates({ to, parcel:{ l:dimL,w:dimW,h:dimH, weight_lb: totalWeightLb } }); } catch(e){ console.warn("EasyPost error:", e.message); }
    }
    if (!quotes.length) {
      let zoneMult = domestic ? ({ "0":1.00,"1":0.95,"2":0.98,"3":1.05,"4":1.10,"5":1.15,"6":1.20,"7":1.25,"8":1.28,"9":1.32 })[(to.postal_code||"")[0]||"5"] ?? 1.15 : 1.65;
      const remoteFee = (!domestic && /AU|NZ|ZA|BR|AR|CL|AE|SA|IN|ID|PH|CN|JP|KR/.test(to.country)) ? 8.0 : 0.0;
      const residentialFee = to.residential ? 4.0 : 0.0;
      const insurance = Math.max(1.0, Math.min(50.0, 0.01 * (subtotal_cents/100)));
      quotes = heuristicRates({ domestic, billable, zoneMult, residentialFee, remoteFee, insurance });
    }
    res.json({ quotes });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Payments + dropship ----
app.post("/create-payment-intent", async (req, res) => {
  try {
    const body = req.body || {};
    const cart = body.cart || [];
    const currency = body.currency || "usd";
    const email = body.email;
    const shipping = body.shipping || null;

    let subtotal = 0; const compactItems = [];
    for (let i=0;i<cart.length;i++) {
      const item = cart[i];
      const p = String(item.id).startsWith("ai-") ? null : await dbGetProduct(item.id);
      const qty = Math.max(1, parseInt(item.qty||1,10));
      const unit = p ? p.price_cents : parseInt(item.price_cents, 10);
      if (!Number.isFinite(unit)) continue;
      subtotal += unit * qty;
      compactItems.push({ id:item.id, name:item.name, qty, unit_price_cents: unit });
    }
    if (subtotal <= 0) subtotal = 4900;
    const shipping_cents = shipping && shipping.amount_cents ? parseInt(shipping.amount_cents,10) : 0;
    const amount = subtotal + Math.max(0, shipping_cents);

    const paymentIntent = await stripe.paymentIntents.create({
      amount, currency, receipt_email: email || undefined,
      automatic_payment_methods: { enabled: true },
      metadata: { site:"Ohio Auto Parts", items: JSON.stringify(compactItems.slice(0, 30)), shipping: JSON.stringify(shipping||{}) }
    });
    res.json({ clientSecret: paymentIntent.client_secret, amount, subtotal, shipping_cents });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

async function queueDropship(order){
  try {
    if (DROPSHIP_WEBHOOK_URL) {
      const r = await fetch(DROPSHIP_WEBHOOK_URL, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ event:"order.paid", order }) });
      if (!r.ok) throw new Error("Dropship webhook " + r.status);
      console.log("[dropship] forwarded to webhook");
    } else {
      console.log("[dropship] webhook not set; order queued in logs only");
    }
  } catch (e) {
    console.error("[dropship] failed:", e.message);
  }
}

// ---- Frontend (eBay-style) via heredoc (safe with backticks inside) ----
// NOTE: doSearch() now uses '/api/search/enhanced' (the new route)
app.get("/", (_req, res) => {
  const html = heredoc(function () {/*!
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ohio Auto Parts</title>
<link rel="preconnect" href="https://js.stripe.com"/>
<style>
:root{--bg:#0a0a0a;--card:#101010;--panel:#0f0f0f;--line:rgba(255,255,255,.08);--text:#f3f3f3;--muted:#bfbfbf;--gold:#d4af37;--accent:#ffd76b}
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(180deg,#000,#0a0a0a 40%,#0e0e0e);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
a{color:#9ecbff}
header{position:sticky;top:0;z-index:30;background:#000c;border-bottom:1px solid var(--line);backdrop-filter: blur(8px)}
.topbar{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:180px 1fr 220px;gap:12px;align-items:center;padding:12px 16px}
.logo{display:flex;gap:10px;align-items:center}
.logo .mark{width:38px;height:38px;border-radius:10px;background:radial-gradient(60% 60% at 30% 30%,var(--gold),transparent 60%),linear-gradient(135deg,#141414,#1b1b1b);box-shadow:0 0 24px rgba(212,175,55,.35), inset 0 0 12px rgba(255,255,255,.08)}
.logo b{font-size:1.15rem}
.searchbar{display:flex;gap:8px}
.searchbar input{flex:1;padding:12px;border-radius:12px;border:1px solid var(--line);background:#0f0f0f;color:var(--text)}
.searchbar button{padding:12px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--gold));color:#111;font-weight:800;cursor:pointer}
.useractions{display:flex;gap:8px;justify-content:flex-end}
.useractions .btn{padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#0f0f0f;color:#eee;cursor:pointer}
.wrap{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:280px 1fr 320px;gap:14px;padding:14px 16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px}
.hdr{font-weight:800;margin-bottom:8px;color:#fff}
label{display:block;margin:8px 0 6px;color:#f4e9c5}
select,input{width:100%;padding:10px;border-radius:10px;border:1px solid var(--line);background:#0f0f0f;color:#fff}
.filter-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.results{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:0}
.result-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:10px 12px}
.list{display:flex;flex-direction:column}
.item{display:grid;grid-template-columns:120px 1fr 140px;gap:12px;padding:12px;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:none}
.thumb{width:120px;height:90px;background:#0a0a0a;border:1px solid var(--line);border-radius:8px;object-fit:cover}
.title{font-weight:800}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:linear-gradient(180deg,var(--accent),var(--gold));color:#111;border:1px solid rgba(212,175,55,.55);font-size:.8rem;margin-left:6px}
.meta{color:var(--muted);font-size:.9rem;margin-top:4px}
.price{color:var(--accent);font-weight:900;font-size:1.1rem;text-align:right}
.item button{padding:10px 12px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--gold));color:#111;font-weight:800;cursor:pointer;width:100%;margin-top:8px}
.side{position:sticky;top:76px;height:fit-content}
.cart-item{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;margin-bottom:8px}
.line{height:1px;background:var(--line);margin:10px 0}
.rate{display:flex;gap:8px;align-items:center;border:1px solid var(--line);padding:8px;border-radius:10px;background:#0f0f0f}
.loadmore{display:block;width:100%;padding:12px;border:none;border-radius:0 0 14px 14px;background:#0f0f0f;color:#fff;border-top:1px solid var(--line);cursor:pointer}
.modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);z-index:50}
.modal .sheet{width:min(520px,92vw);background:#101010;border:1px solid var(--line);border-radius:14px;padding:14px}
.closex{float:right;border:none;background:#0f0f0f;color:#fff;border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
.helper{color:var(--muted);font-size:.9rem}
</style>
</head>
<body>
<header>
  <div class="topbar">
    <div class="logo"><div class="mark"></div><b>Ohio Auto Parts</b></div>
    <div class="searchbar">
      <input id="searchBox" placeholder="Search parts, e.g., Alternator for 2018 BMW X5"/>
      <button id="goSearch">Search</button>
    </div>
    <div class="useractions">
      <button class="btn" id="vinBtn">Decode VIN</button>
      <button class="btn" id="seedBtn" title="reload sample inventory">Seed</button>
    </div>
  </div>
</header>

<div class="wrap">
  <aside class="panel">
    <div class="hdr">Filters</div>
    <label>Make</label><select id="makeSel"><option value="">Any</option></select>
    <label>Model</label><select id="modelSel" disabled><option value="">Any</option></select>
    <label>Year (1991–2026)</label><select id="yearSel"><option value="">Any</option></select>
    <label>Type</label>
    <div class="filter-row">
      <label style="display:flex;gap:8px;align-items:center"><input type="radio" name="oem" value="" checked style="width:auto"> All</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="radio" name="oem" value="oem" style="width:auto"> OEM</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="radio" name="oem" value="aftermarket" style="width:auto"> Aftermarket</label>
    </div>
    <label>Price</label>
    <div class="filter-row">
      <input id="minPrice" type="number" placeholder="Min $"/>
      <input id="maxPrice" type="number" placeholder="Max $"/>
    </div>
    <label>Popular Parts</label>
    <div id="partsCloud" class="filter-row" style="grid-template-columns:1fr 1fr"></div>
    <button id="applyFilters" style="margin-top:10px;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--gold));color:#111;font-weight:800;cursor:pointer;width:100%">Apply</button>
    <div class="line"></div>
    <div class="helper">Tip: Use the VIN tool to auto-fill Make/Model/Year.</div>
  </aside>

  <section class="results">
    <div class="result-head">
      <div id="resultCount" class="helper">0 results</div>
      <div class="helper">Showing best match</div>
    </div>
    <div id="list" class="list"></div>
    <button id="loadMore" class="loadmore">Load more</button>
  </section>

  <aside class="panel side">
    <div class="hdr">Cart</div>
    <div id="cart" class="cart"></div>
    <div class="line"></div>
    <div class="helper">Subtotal: <b id="subtotal">$0.00</b></div>
    <div class="line"></div>
    <div class="hdr">Shipping</div>
    <input id="name" placeholder="Full name"/>
    <input id="email" placeholder="Email" style="margin-top:6px"/>
    <input id="addr1" placeholder="Address line 1" style="margin-top:6px"/>
    <input id="addr2" placeholder="Address line 2" style="margin-top:6px"/>
    <div class="filter-row"><input id="city" placeholder="City"/><input id="state" placeholder="State/Prov"/></div>
    <div class="filter-row"><input id="zip" placeholder="ZIP/Postal"/><select id="country"><option value="US" selected>US</option><option>CA</option><option>GB</option><option>DE</option><option>FR</option><option>IT</option><option>ES</option><option>NL</option><option>SE</option><option>NO</option><option>DK</option><option>IE</option><option>AU</option><option>NZ</option><option>JP</option><option>KR</option></select></div>
    <label style="display:flex;gap:8px;align-items:center"><input id="residential" type="checkbox" checked style="width:auto"> Residential</label>
    <button id="getRates" style="margin-top:8px;padding:10px;border:none;border-radius:10px;background:#0f0f0f;color:#fff;border:1px solid var(--line);cursor:pointer;width:100%">Get Rates</button>
    <div id="rates" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div>
    <div class="helper">Shipping: <b id="shiptotal">$0.00</b></div>
    <div class="helper">Order Total: <b id="grandtotal">$0.00</b></div>
    <div class="line"></div>
    <div id="payment-request-button" style="margin:6px 0"></div>
    <div id="payment-element"></div>
    <button id="pay" style="margin-top:10px;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--gold));color:#111;font-weight:900;cursor:pointer;width:100%">Pay Now</button>
    <div id="message" class="helper" style="margin-top:6px"></div>
  </aside>
</div>

<div id="vinModal" class="modal">
  <div class="sheet">
    <button class="closex" id="closeVin">Close</button>
    <h3>Decode VIN</h3>
    <input id="vinInput" maxlength="17" placeholder="Enter 17-character VIN"/>
    <button id="vinGo" style="margin-top:8px;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--gold));color:#111;font-weight:800;cursor:pointer">Decode</button>
    <div id="vinMeta" class="helper" style="margin-top:8px"></div>
  </div>
</div>

<script src="https://js.stripe.com/v3"></script>
<script>
const fmt = (c)=>'$'+(c/100).toFixed(2);
let page=1, pageSize=60, total=0;
let selectedRate=null; let subtotalCents=0; const cart=[];
let stripe, elements, paymentElement, paymentRequest, prButton, clientSecret;

const makeSel=document.getElementById('makeSel');
const modelSel=document.getElementById('modelSel');
const yearSel=document.getElementById('yearSel');
const partsCloud=document.getElementById('partsCloud');
const listEl=document.getElementById('list');
const resultCount=document.getElementById('resultCount');

async function init(){
  const makes = await (await fetch('/api/makes')).json();
  makeSel.innerHTML = '<option value="">Any</option>'+makes.map(m=>'<option>'+m+'</option>').join('');
  makeSel.onchange = async ()=>{
    const m = makeSel.value;
    const models = await (await fetch('/api/models?make='+encodeURIComponent(m))).json();
    modelSel.disabled = !m; modelSel.innerHTML = '<option value="">Any</option>'+models.map(x=>'<option>'+x+'</option>').join('');
  };
  const years = await (await fetch('/api/years')).json();
  yearSel.innerHTML = '<option value="">Any</option>'+years.map(y=>'<option>'+y+'</option>').join('');
  const parts = await (await fetch('/api/parts')).json();
  partsCloud.innerHTML = parts.slice(0,12).map(p=>'<button class="btnPart" style="padding:8px;border:1px solid var(--line);border-radius:999px;background:#0f0f0f;color:#eee;cursor:pointer">'+p+'</button>').join('');
  partsCloud.querySelectorAll('.btnPart').forEach(b=>b.onclick=()=>{ document.getElementById('searchBox').value=b.textContent; doSearch(true); });

  document.getElementById('goSearch').onclick=()=>doSearch(true);
  document.getElementById('applyFilters').onclick=()=>doSearch(true);
  document.getElementById('loadMore').onclick=()=>doSearch(false);

  const vinModal = document.getElementById('vinModal');
  document.getElementById('vinBtn').onclick=()=>{ vinModal.style.display='flex'; document.getElementById('vinInput').focus(); };
  document.getElementById('closeVin').onclick=()=>{ vinModal.style.display='none'; };
  document.getElementById('vinGo').onclick=decodeVIN;

  document.getElementById('seedBtn').onclick=async ()=>{ await fetch('/admin/seed',{method:'POST',headers:{Authorization:'Bearer '+encodeURIComponent('changeme-admin')}}); doSearch(true); };

  renderCart(); await initStripe();
  doSearch(true);
}
async function decodeVIN(){
  const vin = document.getElementById('vinInput').value.trim();
  const vinMeta = document.getElementById('vinMeta');
  if (!vin || vin.length!==17){ vinMeta.textContent='VIN must be 17 chars.'; return; }
  const r = await fetch('/api/vin/decode?vin='+encodeURIComponent(vin)); const d = await r.json();
  if (!d.ok){ vinMeta.textContent = d.error || 'Decode failed.'; return; }
  vinMeta.textContent = 'Detected: ' + (d.year||'—') + ' ' + (d.make||'') + ' ' + (d.model||'');
  if (d.make){ makeSel.value = d.make; const models = await (await fetch('/api/models?make='+encodeURIComponent(d.make))).json(); modelSel.disabled=false; modelSel.innerHTML='<option value="">Any</option>'+models.map(x=>'<option>'+x+'</option>').join(''); }
  if (d.model){ modelSel.value = d.model; }
  if (d.year){ yearSel.value = d.year; }
  document.getElementById('vinModal').style.display='none';
  doSearch(true);
}
function selectedOem(){ const el=document.querySelector('input[name="oem"]:checked'); return el?el.value:""; }

// >>>>>>>>>>>>> CHANGE: use the enhanced search endpoint <<<<<<<<<<<<<
async function doSearch(reset){
  if (reset){ page=1; listEl.innerHTML=''; total=0; }
  const params = new URLSearchParams();
  const q = document.getElementById('searchBox').value.trim();
  if (q) params.set('q', q);
  if (makeSel.value) params.set('make', makeSel.value);
  if (modelSel.value) params.set('model', modelSel.value);
  if (yearSel.value) params.set('year', yearSel.value);
  const o = selectedOem(); if (o) params.set('oem', o);
  const min = parseInt(document.getElementById('minPrice').value||''); if(min) params.set('min_price', min*100);
  const max = parseInt(document.getElementById('maxPrice').value||''); if(max) params.set('max_price', max*100);
  params.set('page', page); params.set('page_size', pageSize);
  // Enhanced search provides auto-image + AI fallback
  const res = await fetch('/api/search/enhanced?'+params.toString());
  const js = await res.json();
  total = js.total; resultCount.textContent = total + ' results';
  renderItems(js.items);
  const more = page * pageSize < total; document.getElementById('loadMore').style.display = more ? 'block' : 'none';
  if (more) page += 1;
}

function renderItems(items){
  if (!items.length && !listEl.children.length){ listEl.innerHTML='<div class="helper" style="padding:12px">No items found.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (let i=0;i<items.length;i++){
    const p = items[i];
    const el = document.createElement('div'); el.className='item';
    el.innerHTML = ''
      + '<img class="thumb" src="'+(p.image_url || '')+'" alt="">'
      + '<div>'
      +   '<div class="title">'+p.name+' '+(p.stock>0?'<span class="badge">In stock</span>':'<span class="badge" style="opacity:.6">Backorder</span>')+'</div>'
      +   '<div class="meta">'+(p.part_type||'Part')+' • '+(p.oem?'OEM':'Aftermarket')+(p.ai_sourced?' • AI-sourced':'')+'</div>'
      +   '<div class="meta">Make/Model/Year: '+(p.make||'—')+' / '+(p.model||'—')+' / '+(p.year||'—')+'</div>'
      +   (p.image_url ? '' : '<button class="btnFind" style="padding:8px;border:1px solid var(--line);border-radius:8px;background:#0f0f0f;color:#fff;cursor:pointer;margin-top:6px">Find Photo (AI)</button>')
      + '</div>'
      + '<div>'
      +   '<div class="price">'+fmt(p.price_cents)+'</div>'
      +   '<button class="btnAdd" '+(p.stock>0?'':'disabled')+' style="margin-top:6px">'+(p.stock>0?'Add to cart':'Out of stock')+'</button>'
      + '</div>';
    const btn = el.querySelector('.btnAdd');
    if (btn) btn.onclick = function(){ addToCart(p.id, p.name, p.price_cents); };
    const findBtn = el.querySelector('.btnFind');
    if (findBtn) findBtn.onclick = async function(){
      findBtn.textContent='Searching…'; findBtn.disabled=true;
      const AiRes = await fetch('/api/ai/image',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ product_id: p.id }) });
      const data = await AiRes.json();
      if (data.ok && data.image_url){ el.querySelector('.thumb').src=data.image_url; findBtn.remove(); }
      else { findBtn.textContent='Try again'; findBtn.disabled=false; }
    };
    frag.appendChild(el);
  }
  listEl.appendChild(frag);
}

// Cart
function addToCart(id,name,price_cents){
  const f = cart.find(i=>i.id===id);
  if (f) f.qty+=1; else cart.push({ id,name,price_cents,qty:1 });
  renderCart();
}
function renderCart(){
  const box=document.getElementById('cart'); box.innerHTML='';
  if(!cart.length){ box.innerHTML='<div class="helper">Your cart is empty.</div>'; }
  for (let i=0;i<cart.length;i++){
    const item = cart[i];
    const row=document.createElement('div'); row.className='cart-item';
    row.innerHTML=''
      + '<div>'+item.name+'</div>'
      + '<div style="display:flex;gap:6px;align-items:center">'
      +   '<button class="q-" style="padding:6px;border:1px solid var(--line);background:#0f0f0f;color:#fff;border-radius:6px;cursor:pointer">-</button>'
      +   '<b>'+item.qty+'</b>'
      +   '<button class="q+" style="padding:6px;border:1px solid var(--line);background:#0f0f0f;color:#fff;border-radius:6px;cursor:pointer">+</button>'
      + '</div>'
      + '<div>'+fmt(item.price_cents*item.qty)+'</div>';
    row.querySelector('.q-').onclick=function(){ item.qty=Math.max(0,item.qty-1); if(!item.qty) cart.splice(cart.indexOf(item),1); renderCart(); };
    row.querySelector('.q+').onclick=function(){ item.qty+=1; renderCart(); };
    box.appendChild(row);
  }
  subtotalCents = cart.reduce((s,i)=>s+i.price_cents*i.qty,0);
  document.getElementById('subtotal').textContent = fmt(subtotalCents);
  updateTotals();
  selectedRate=null; document.getElementById('rates').innerHTML=''; document.getElementById('shiptotal').textContent=fmt(0);
  updateStripe(subtotalCents, 0);
}

function updateTotals(){
  const ship = selectedRate && selectedRate.amount_cents || 0;
  document.getElementById('grandtotal').textContent = fmt(subtotalCents + ship);
}

// Shipping
document.getElementById('getRates').onclick = async function(){
  if(!cart.length){ alert('Add items to cart first.'); return; }
  const address = {
    name: document.getElementById('name').value,
    email: document.getElementById('email').value,
    line1: document.getElementById('addr1').value,
    line2: document.getElementById('addr2').value,
    city: document.getElementById('city').value,
    state: document.getElementById('state').value,
    postal_code: document.getElementById('zip').value,
    country: document.getElementById('country').value,
    residential: document.getElementById('residential').checked
  };
  const r = await fetch('/api/shipping/rates',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ address, cart, subtotal_cents: subtotalCents }) });
  const js = await r.json();
  const quotes = js.quotes || [];
  const list = document.getElementById('rates');
  if(!quotes.length){ list.innerHTML='<div class="helper">No shipping options found.</div>'; return; }
  list.innerHTML = quotes.map(function(q,i){
    return '<label class="rate">'
      + '<input type="radio" name="rate" value="'+i+'">'
      + '<div style="flex:1">'+q.carrier+' – '+q.service+' '+(q.days?'<span class="helper">(~'+q.days+'d)</span>':'')+'</div>'
      + '<div style="font-weight:800;color:#ffd76b">'+fmt(q.amount_cents)+'</div>'
      + '</label>';
  }).join('');
  var rbs = list.querySelectorAll('input[name="rate"]');
  for (var i=0;i<rbs.length;i++){
    (function(idx){
      rbs[idx].addEventListener('change', function(){
        selectedRate = quotes[idx];
        document.getElementById('shiptotal').textContent = fmt(selectedRate.amount_cents);
        updateTotals(); updateStripe(subtotalCents, selectedRate.amount_cents);
      });
    })(i);
  }
};

// Stripe
const messageEl=document.getElementById('message'); function setMsg(m){ messageEl.textContent=m||''; }
async function initStripe(){
  const js = await (await fetch('/config')).json();
  stripe = Stripe(js.publishableKey);
  await updateStripe(0,0);
}
async function createPI(subtotal, shipping){
  const email = document.getElementById('email').value || undefined;
  const shippingMeta = selectedRate ? { carrier:selectedRate.carrier, service:selectedRate.service, days:selectedRate.days, amount_cents:selectedRate.amount_cents } : null;
  const payloadCart = cart.map(function(i){ return { id:i.id, name:i.name, qty:i.qty, price_cents:i.price_cents }; });
  const res = await fetch('/create-payment-intent',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ currency:'usd', cart: payloadCart, email: email, shipping: shippingMeta })
  });
  const js = await res.json(); if(js.error) throw new Error(js.error); return js;
}
async function updateStripe(subtotal, shipping){
  setMsg('');
  const js = await createPI(subtotal, shipping);
  const cs = js.clientSecret, amount = js.amount;
  clientSecret = cs;
  elements = stripe.elements({ clientSecret: cs });

  if (paymentElement) paymentElement.unmount();
  paymentElement = elements.create('payment'); paymentElement.mount('#payment-element');

  if (!paymentRequest) {
    paymentRequest = stripe.paymentRequest({
      country:'US', currency:'usd',
      total: { label:'Ohio Auto Parts', amount: amount || (subtotal + (shipping||0)) },
      requestPayerName:true, requestPayerEmail:true
    });
    prButton = elements.create('paymentRequestButton', { paymentRequest: paymentRequest });
    const can = await paymentRequest.canMakePayment();
    if (can) prButton.mount('#payment-request-button'); else document.getElementById('payment-request-button').style.display='none';
    paymentRequest.on('paymentmethod', async function(ev){
      const r = await stripe.confirmCardPayment(clientSecret, { payment_method: ev.paymentMethod.id }, { handleActions: true });
      if (r.error) { ev.complete('fail'); setMsg(r.error.message||'Payment failed.'); return; }
      ev.complete('success'); setMsg('Payment successful!');
    });
  } else {
    paymentRequest.update({ total: { label:'Ohio Auto Parts', amount: amount || (subtotal + (shipping||0)) } });
  }

  document.getElementById('grandtotal').textContent = fmt(amount || (subtotal + (shipping||0)));
}
document.getElementById('pay').onclick = async function(){
  try{
    setMsg('Processing…');
    const r = await stripe.confirmPayment({ elements: elements, confirmParams:{ return_url: window.location.href }, redirect: 'if_required' });
    if (r.error) setMsg(r.error.message||'Payment failed.'); else setMsg('Payment successful!');
  }catch(e){ setMsg(e.message); }
};

init();
</script>
</body></html>
*/});
  res.type("html").send(html);
});

// Admin seed endpoint
app.post("/admin/seed", async (req, res) => {
  const token = (req.headers.authorization||"").split("Bearer ")[1];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  await ensureSeed(); res.json({ ok:true });
});

// ---- Listen ----
const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, HOST, function(){
  console.log("Ohio Auto Parts listening on http://" + HOST + ":" + PORT);
});
