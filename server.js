// Ohio Auto Parts – eBay-style single file app
// - eBay-like UI: top search, left filters, right results (list cards), sort + load more
// - VIN modal: decode → auto-fills Make/Model/Year
// - Years: 1991–2026 (always shown)
// - Click → Add to Cart, live totals, Stripe + Apple/Google Pay
// - Lists ALL results (progressive "Load more")
// - AI Image fetch: auto-searches web and attaches picture to product
// - AI "cheapest + 75% markup" kept (for your AI offers card)
// - AI Dropship: on Stripe webhook, selects cheapest supplier and POSTs POs to your dropship webhook

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY || "sk_test_xxx");

// ====== ENV ======
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_xxx";
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || "";

const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY || ""; // optional live rates
const SHIP_FROM_NAME   = process.env.SHIP_FROM_NAME || "Ohio Auto Parts";
const SHIP_FROM_STREET1= process.env.SHIP_FROM_STREET1 || "123 Warehouse Rd";
const SHIP_FROM_CITY   = process.env.SHIP_FROM_CITY || "Columbus";
const SHIP_FROM_STATE  = process.env.SHIP_FROM_STATE || "OH";
const SHIP_FROM_ZIP    = process.env.SHIP_FROM_ZIP || "43004";
const SHIP_FROM_COUNTRY= process.env.SHIP_FROM_COUNTRY || "US";
const SHIP_FROM_PHONE  = process.env.SHIP_FROM_PHONE || "5555555555";
const SHIP_FROM_EMAIL  = process.env.SHIP_FROM_EMAIL || "support@example.com";

const PARTSTECH_API_KEY= process.env.PARTSTECH_API_KEY || ""; // optional OEM catalog
const SERPAPI_KEY      = process.env.SERPAPI_KEY || "";       // optional AI image + price sourcing
const EBAY_APP_ID      = process.env.EBAY_APP_ID  || "";       // optional AI price fallback

// AI Dropship webhook (generic)
const DROPSHIP_WEBHOOK_URL = process.env.DROPSHIP_WEBHOOK_URL || ""; // e.g., your ERP/3PL endpoint
const DROPSHIP_API_KEY     = process.env.DROPSHIP_API_KEY || "";     // optional auth for that endpoint

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme-admin";
const PORT = process.env.PORT || 3000;

// ====== DB (in-memory with optional Postgres) ======
let db = { useMemory: true };
let pgPool = null;

(async () => {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require("pg");
      pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pgPool.query("select 1;");
      db.useMemory = false;
      await migrate();
      await ensureSeed();
      console.log("[DB] Connected to Postgres");
    } catch (e) {
      console.warn("[DB] Postgres unavailable, falling back to memory:", e.message);
      db = memoryDB();
      await ensureSeed();
    }
  } else {
    db = memoryDB();
    await ensureSeed();
  }
})();

function memoryDB() {
  const state = { products: [], orders: [] };
  return {
    useMemory: true,
    async migrate(){},
    async seedProducts(items){ state.products = items; },
    async listProducts(filter){
      const all = state.products.filter(p =>
        (!filter.make  || p.make  === filter.make) &&
        (!filter.model || p.model === filter.model) &&
        (!filter.year  || p.year  === filter.year) &&
        (!filter.oemFlag || (filter.oemFlag === "oem" ? p.oem : !p.oem)) &&
        (!filter.q || (p.name.toLowerCase().includes(filter.q) || p.part_type.toLowerCase().includes(filter.q)))
      );
      // sort
      if (filter.sort === "price_asc") all.sort((a,b)=>a.price_cents-b.price_cents);
      if (filter.sort === "price_desc") all.sort((a,b)=>b.price_cents-a.price_cents);
      if (filter.sort === "year_desc") all.sort((a,b)=>b.year-a.year);
      if (filter.sort === "year_asc") all.sort((a,b)=>a.year-b.year);
      return all;
    },
    async getProduct(id){ return state.products.find(p=>p.id===id); },
    async updateProductImage(id, url){ const p=state.products.find(x=>x.id===id); if(p) p.image_url=url; return p; },
    async saveOrder(order){ state.orders.push(order); return order; },
    async listOrders(){ return state.orders; }
  };
}
async function migrate(){
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
async function dbGetProduct(id){
  if (db.useMemory) return db.getProduct(id);
  const { rows } = await pgPool.query("select * from products where id=$1",[id]); return rows[0]||null;
}
async function dbListProducts(filter){
  if (db.useMemory) return db.listProducts(filter);
  const q = (filter.q||"").toLowerCase();
  let where=[], vals=[], order="order by name";
  if (filter.make)  { vals.push(filter.make);  where.push(`make=$${vals.length}`); }
  if (filter.model) { vals.push(filter.model); where.push(`model=$${vals.length}`); }
  if (filter.year)  { vals.push(filter.year);  where.push(`year=$${vals.length}`); }
  if (filter.oemFlag) where.push(filter.oemFlag==="oem"?"oem=true":"oem=false");
  if (q){ vals.push(`%${q}%`); where.push(`(lower(name) like $${vals.length} or lower(part_type) like $${vals.length})`); }
  if (filter.sort==="price_asc") order="order by price_cents asc";
  if (filter.sort==="price_desc") order="order by price_cents desc";
  if (filter.sort==="year_desc") order="order by year desc";
  if (filter.sort==="year_asc") order="order by year asc";
  const sql=`select * from products ${where.length?'where '+where.join(' and '):''} ${order}`;
  const { rows } = await pgPool.query(sql, vals); return rows;
}
async function dbUpdateProductImage(id,url){
  if (db.useMemory) return db.updateProductImage(id,url);
  await pgPool.query("update products set image_url=$2 where id=$1",[id,url]); return dbGetProduct(id);
}
async function dbSaveOrder(o){
  if (db.useMemory) return db.saveOrder(o);
  await pgPool.query(`insert into orders(id,stripe_pi,amount_cents,currency,email,name,address,items,shipping,status)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [o.id,o.stripe_pi,o.amount_cents,o.currency,o.email,o.name,o.address,o.items,o.shipping,o.status]);
  return o;
}

// ===== Seed catalog (1991–2026) =====
const YEARS_FULL = Array.from({length:(2026-1991+1)},(_,i)=>1991+i);
function sampleProducts(){
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  const MAKES=["Ford","Chevrolet","GMC","Ram","Dodge","Chrysler","Jeep","Cadillac","Buick","Lincoln","Tesla",
               "BMW","Mercedes-Benz","Audi","Volkswagen","Porsche","Opel","Mini","Smart","Volvo","Peugeot","Renault",
               "Citroën","Fiat","Alfa Romeo","Lancia","SEAT","Škoda","Dacia","Land Rover","Jaguar","Aston Martin",
               "Bentley","Rolls-Royce","Lotus","McLaren","Cupra","Iveco"];
  const MODELS={
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
  const PARTS=[["Brake Pads",6,8,6,4],["Brake Rotors",28,14,14,4],["Alternator",14,10,8,8],["Starter",12,10,8,8],
               ["Battery",38,12,7,9],["Oil Filter",2,4,4,4],["Air Filter",3,12,8,2],["Cabin Filter",2,10,8,2],
               ["Spark Plugs",1,6,4,2],["Ignition Coils",3,8,6,4],["Radiator",24,32,6,24],["Water Pump",8,8,8,6],
               ["Thermostat",1,4,4,3],["Shock Absorber",10,24,4,4],["Control Arm",9,18,6,4],["Wheel Bearing",7,6,6,4],
               ["O2 Sensor",1,6,4,2],["Catalytic Converter",20,24,10,8],["AC Compressor",16,12,10,10],
               ["Headlight Assembly",9,18,12,10],["Taillight",6,16,8,8],["Mirror",5,14,10,6],["Bumper",30,65,12,12],["Grille",12,36,10,6]];
  const imgs=["https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop",
              "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?q=80&w=800&auto=format&fit=crop",
              "https://images.unsplash.com/photo-1517747614396-d21a78b850e8?q=80&w=800&auto=format&fit=crop"];
  const out=[];
  for(let i=0;i<500;i++){
    const make=pick(MAKES); const model=pick(MODELS[make]); const [part,weight,L,W,H]=pick(PARTS);
    const year=pick(YEARS_FULL); const price=(Math.floor(Math.random()*220)+35)*100;
    out.push({ id:crypto.randomUUID(), name:`${year} ${make} ${model} – ${part}`, make, model, year,
      part_type:part, price_cents:price, stock:Math.floor(Math.random()*24),
      image_url: (Math.random()<0.55)?pick(imgs):null,
      weight_lb:weight, dim_l_in:L, dim_w_in:W, dim_h_in:H, oem: Math.random()<0.55
    });
  }
  return out;
}
async function ensureSeed(){
  const items=sampleProducts();
  if (db.useMemory){ await db.seedProducts(items); return; }
  const { rows } = await pgPool.query("select count(*)::int as c from products");
  if (rows[0].c<150){
    const q=`insert into products(id,name,make,model,year,part_type,price_cents,stock,image_url,weight_lb,dim_l_in,dim_w_in,dim_h_in,oem)
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (id) do nothing`;
    for(const p of items){ await pgPool.query(q,[p.id,p.name,p.make,p.model,p.year,p.part_type,p.price_cents,p.stock,p.image_url,p.weight_lb,p.dim_l_in,p.dim_w_in,p.dim_h_in,p.oem]); }
  }
}

// ===== App / Webhooks =====
const app = express();
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  let event = req.body;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    }
  } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

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

    // AI Dropship (non-blocking, best-effort)
    processDropshipOrder(order).catch(e=>console.error("dropship error:", e));
  }
  res.json({ received: true });
});
app.use(bodyParser.json());

// ===== Catalog APIs =====
const MAKES=["Ford","Chevrolet","GMC","Ram","Dodge","Chrysler","Jeep","Cadillac","Buick","Lincoln","Tesla",
             "BMW","Mercedes-Benz","Audi","Volkswagen","Porsche","Opel","Mini","Smart","Volvo","Peugeot","Renault",
             "Citroën","Fiat","Alfa Romeo","Lancia","SEAT","Škoda","Dacia","Land Rover","Jaguar","Aston Martin",
             "Bentley","Rolls-Royce","Lotus","McLaren","Cupra","Iveco"].sort();
const MODELS={ Ford:["F-150","Mustang","Explorer","Ranger","Transit","Bronco"], Chevrolet:["Silverado","Colorado","Tahoe","Suburban","Camaro","Equinox"], GMC:["Sierra","Yukon","Acadia","Terrain","Canyon"], Ram:["1500","2500","ProMaster"], Dodge:["Charger","Challenger","Durango"], Chrysler:["300","Pacifica","Voyager"], Jeep:["Wrangler","Grand Cherokee","Compass","Gladiator"], Cadillac:["Escalade","XT5","CT5","Lyriq"], Buick:["Enclave","Envision"], Lincoln:["Aviator","Navigator"], Tesla:["Model 3","Model Y","Model S","Model X","Cybertruck"], BMW:["3 Series","5 Series","X3","X5","i4"], "Mercedes-Benz":["C-Class","E-Class","GLC","GLE","EQE"], Audi:["A4","A6","Q5","Q7","Q8"], Volkswagen:["Golf","Jetta","Passat","Tiguan","Atlas","ID.4"], Porsche:["911","Cayenne","Macan","Taycan"], Volvo:["XC40","XC60","XC90","S60","EX30"], Peugeot:["208","308","3008","5008"], Renault:["Clio","Megane","Captur","Scenic"], Citroën:["C3","C4","C5 Aircross"], Fiat:["500","Panda","Tipo","Ducato"], "Alfa Romeo":["Giulia","Stelvio","Tonale"], Lancia:["Ypsilon"], SEAT:["Ibiza","Leon","Ateca"], "Škoda":["Fabia","Octavia","Kodiaq","Enyaq"], Dacia:["Sandero","Logan","Duster","Jogger"], "Land Rover":["Defender","Discovery","Range Rover","Evoque"], Jaguar:["XF","F-PACE","I-PACE"], "Aston Martin":["Vantage","DB12","DBX"], Bentley:["Bentayga","Continental GT"], "Rolls-Royce":["Ghost","Phantom","Cullinan"], Lotus:["Emira","Eletre"], McLaren:["Artura","750S","GT"], Cupra:["Leon","Formentor","Born"], Iveco:["Daily","Eurocargo"] };

app.get("/config", (_req,res)=>res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY }));
app.get("/api/makes", (_req,res)=>res.json(MAKES));
app.get("/api/models", (req,res)=>res.json(MODELS[req.query.make]||[]));
app.get("/api/years", (_req,res)=>res.json([...YEARS_FULL].reverse())); // 2026..1991
function PARTS(){ return ["Alternator","Battery","Starter","Spark Plugs","Ignition Coils","ECU","MAF Sensor","MAP Sensor","O2 Sensor","Oil Filter","Air Filter","Cabin Filter","Fuel Filter","Fuel Pump","Radiator","Water Pump","Thermostat","Timing Belt/Chain","Serpentine Belt","Catalytic Converter","Exhaust Muffler","Brake Pads","Brake Rotors","Calipers","ABS Sensor","Master Cylinder","Suspension Strut","Shock Absorber","Control Arm","Ball Joint","Tie Rod","Wheel Bearing","Axle/CV Joint","AC Compressor","Condenser","Heater Core","Power Steering Pump","Rack and Pinion","Clutch Kit","Flywheel","Transmission Filter/Fluid","Headlight Assembly","Taillight","Mirror","Bumper","Fender","Hood","Grille","Door Handle","Window Regulator","Wiper Blades","Floor Mats","Roof Rack","Infotainment Screen"]; }
app.get("/api/parts", (_req,res)=>res.json(PARTS()));

// Product search (ALL with pagination)
app.get("/api/products", async (req,res)=>{
  const { make, model, year, q, oem, sort="relevance", page="1", page_size="60" } = req.query;
  const filter = { make, model, year:year?parseInt(year,10):undefined, q:(q||"").toLowerCase(), oemFlag:oem, sort };
  const list = await (db.useMemory ? db.listProducts(filter) : dbListProducts(filter));
  const ps = Math.min(parseInt(page_size,10), 120);
  const pg = Math.max(1, parseInt(page,10));
  res.json({ total: list.length, page: pg, page_size: ps, items: list.slice((pg-1)*ps, (pg-1)*ps + ps) });
});

// ===== VIN (modal decode) =====
async function decodeVIN_NHTSA(vin){
  try {
    const u = new URL(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValues/${encodeURIComponent(vin)}?format=json`);
    const r = await fetch(u); if(!r.ok) return null; const j = await r.json();
    const row = j?.Results?.[0] || {};
    const make = row?.Make || null;
    const model = row?.Model || null;
    const year = row?.ModelYear ? parseInt(row.ModelYear,10) : null;
    return { make, model, year };
  } catch { return null; }
}
app.get("/api/vin/decode", async (req,res)=>{
  const vin = (req.query.vin||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  if (vin.length!==17) return res.json({ ok:false, error:"VIN must be 17 characters." });
  const meta = await decodeVIN_NHTSA(vin);
  if (!meta) return res.json({ ok:false, error:"VIN decode failed." });
  res.json({ ok:true, vin, ...meta });
});

// ===== AI Image fetch & attach =====
async function aiFindImageURL({ make, model, year, part, name }){
  // Try SerpAPI Google Images first
  if (SERPAPI_KEY){
    try{
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine","google_images");
      url.searchParams.set("q",[year, make, model, part || name].filter(Boolean).join(" "));
      url.searchParams.set("hl","en");
      url.searchParams.set("api_key", SERPAPI_KEY);
      const r = await fetch(url); if (r.ok){
        const j = await r.json();
        const hit = j.images_results?.find(x=>/^https:\/\//.test(x.original) || /^https:\/\//.test(x.thumbnail));
        if (hit) return (hit.original || hit.thumbnail);
      }
    }catch{}
    // fallback to Shopping results
    try{
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine","google_shopping");
      url.searchParams.set("q",[year, make, model, part || name].filter(Boolean).join(" "));
      url.searchParams.set("gl","us");
      url.searchParams.set("api_key", SERPAPI_KEY);
      const r = await fetch(url); if (r.ok){
        const j = await r.json();
        const hit = (j.shopping_results||[]).find(x=>x.thumbnail || x.thumbnail_url);
        if (hit) return hit.thumbnail || hit.thumbnail_url;
      }
    }catch{}
  }
  // Fallback generic
  return "https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop";
}
app.post("/api/image/ai", async (req,res)=>{
  try{
    const { productId } = req.body||{};
    const p = await dbGetProduct(productId);
    if (!p) return res.status(404).json({ error: "Not found" });
    const url = await aiFindImageURL({ make:p.make, model:p.model, year:p.year, part:p.part_type, name:p.name });
    await dbUpdateProductImage(p.id, url);
    res.json({ ok:true, image_url:url });
  }catch(e){ res.status(400).json({ error: e.message }); }
});

// ===== AI Cheapest + 75% markup (for AI-sourced listing card) =====
async function fetchCheapestFromSerpAPI(query){
  if (!SERPAPI_KEY) return null;
  try{
    const u=new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine","google_shopping"); u.searchParams.set("q",query); u.searchParams.set("gl","us");
    u.searchParams.set("api_key",SERPAPI_KEY); const r=await fetch(u); if(!r.ok) return null;
    const j=await r.json(); const items=j.shopping_results||[]; let best=null;
    for (const it of items){ const price=parseFloat(String(it.price||"").replace(/[^0-9.]/g,"")); if(Number.isFinite(price)){ if(!best||price<best.price) best={price, title:it.title, link:it.link, source:"Google Shopping"}; } }
    return best;
  }catch{ return null; }
}
async function fetchCheapestFromEbay(query){
  if (!EBAY_APP_ID) return null;
  try{
    const u=new URL("https://svcs.ebay.com/services/search/FindingService/v1");
    u.searchParams.set("OPERATION-NAME","findItemsByKeywords");
    u.searchParams.set("SERVICE-VERSION","1.0.0");
    u.searchParams.set("SECURITY-APPNAME", EBAY_APP_ID);
    u.searchParams.set("RESPONSE-DATA-FORMAT","JSON");
    u.searchParams.set("keywords", query);
    u.searchParams.set("paginationInput.entriesPerPage","10");
    const r=await fetch(u); if(!r.ok) return null; const j=await r.json();
    const arr=j.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || []; let best=null;
    for(const it of arr){ const p=parseFloat(it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__||"NaN"); if(Number.isFinite(p)){ if(!best||p<best.price) best={price:p, title:it.title?.[0], link:it.viewItemURL?.[0], source:"eBay"}; } }
    return best;
  }catch{ return null; }
}
const markup75 = price => Math.round(price * 1.75 * 100);
app.post("/api/market/cheapest", async (req,res)=>{
  try{
    const { make, model, year, part } = req.body||{};
    const q=[year,make,model,part,"OEM OR Aftermarket"].filter(Boolean).join(" ");
    let best = await fetchCheapestFromSerpAPI(q) || await fetchCheapestFromEbay(q);
    if (!best){
      const base = /rotor|radiator|bumper|compressor|converter/i.test(part||"") ? 180
                : /alternator|shock|control|bearing|headlight/i.test(part||"") ? 120
                : /filter|plug|sensor/i.test(part||"") ? 28 : 75;
      best = { price: base, title:`${year||""} ${make||""} ${model||""} ${part||""}`.trim(), link:null, source:"Heuristic" };
    }
    const product = {
      id: "ai-"+crypto.randomUUID(),
      name: `${year||""} ${make||""} ${model||""} – ${part||""} (AI-sourced)`.replace(/\s+/g," ").trim(),
      make, model, year: year?parseInt(year,10):undefined, part_type:part,
      price_cents: markup75(best.price), stock: 5, image_url: null,
      source_price: best.price, source_link: best.link, source_from: best.source
    };
    res.json({ product });
  }catch(e){ res.status(400).json({ error: e.message }); }
});

// ===== Payments =====
app.post("/create-payment-intent", async (req,res)=>{
  try{
    const { cart = [], currency="usd", email, shipping=null } = req.body||{};
    let subtotal=0; const compact=[];
    for(const item of cart){
      const isAI = String(item.id).startsWith("ai-");
      const p = isAI ? null : await dbGetProduct(item.id);
      const qty=Math.max(1, parseInt(item.qty||1,10));
      const unit = p ? p.price_cents : parseInt(item.price_cents,10);
      if(!Number.isFinite(unit)) continue;
      subtotal += unit*qty;
      compact.push({ id:item.id, name:item.name, qty, unit_price_cents: unit });
    }
    if (subtotal<=0) subtotal=4900;
    const shipping_cents = shipping?.amount_cents ? parseInt(shipping.amount_cents,10) : 0;
    const amount = subtotal + Math.max(0, shipping_cents);

    const pi = await stripe.paymentIntents.create({
      amount, currency, receipt_email: email || undefined,
      automatic_payment_methods: { enabled:true },
      metadata: { items: JSON.stringify(compact.slice(0,20)), shipping: JSON.stringify(shipping||{}) }
    });
    res.json({ clientSecret: pi.client_secret, amount, subtotal, shipping_cents });
  }catch(e){ res.status(400).json({ error: e.message }); }
});

// ===== Shipping (EasyPost live -> fallback heuristic) =====
function ozFromLb(lb){ return Math.max(1, Math.round(lb * 16)); }
async function easypostRates({ to, parcel }){
  const url="https://api.easypost.com/v2/shipments";
  const payload={ shipment:{
    to_address:{ name:to.name||"Customer", street1:to.line1, street2:to.line2||"", city:to.city, state:to.state, zip:to.postal_code, country:to.country||"US", phone:to.phone||"0000000000", email:to.email||"customer@example.com", residential:!!to.residential },
    from_address:{ name:SHIP_FROM_NAME, street1:SHIP_FROM_STREET1, city:SHIP_FROM_CITY, state:SHIP_FROM_STATE, zip:SHIP_FROM_ZIP, country:SHIP_FROM_COUNTRY, phone:SHIP_FROM_PHONE, email:SHIP_FROM_EMAIL },
    parcel:{ length:Math.max(1,Math.round(parcel.l)), width:Math.max(1,Math.round(parcel.w)), height:Math.max(1,Math.round(parcel.h)), weight:Math.max(1, ozFromLb(parcel.weight_lb)) }
  }};
  const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json", "Authorization":"Basic "+Buffer.from(EASYPOST_API_KEY+":").toString("base64") }, body:JSON.stringify(payload) });
  if(!r.ok){ const t=await r.text(); throw new Error(`EasyPost ${r.status}: ${t}`); }
  const j=await r.json();
  return (j.rates||[]).filter(r=>["UPS","FedEx","DHLExpress","USPS","DHL eCommerce"].includes(r.carrier))
    .map(r=>({ carrier: r.carrier.replace("DHLExpress","DHL"), service:r.service, days:r.delivery_days||null, amount_cents: Math.round(parseFloat(r.rate)*100) }))
    .sort((a,b)=>a.amount_cents-b.amount_cents).slice(0,6);
}
function heuristicRates({ domestic, billable, zoneMult, residentialFee, remoteFee, insurance }){
  function toCents(n){ return Math.max(1, Math.round(n*100)); }
  function baseG(bw){return 8+0.55*bw;} function base2(bw){return 15+0.95*bw;} function baseN(bw){return 24+1.45*bw;} function baseI(bw){return 32+1.65*bw;}
  const fuel=0.12, q=(c,s,d,b)=>{ let a=b*zoneMult + residentialFee+remoteFee+insurance; a*=1+fuel; return {carrier:c,service:s,days:d,amount_cents:toCents(a)}; };
  if (domestic) return [q("UPS","Ground",3,baseG(billable)), q("UPS","2nd Day Air",2,base2(billable)), q("FedEx","Ground",3,baseG(billable)*0.98), q("FedEx","2Day",2,base2(billable)*0.99), q("FedEx","Standard Overnight",1,baseN(billable))].sort((a,b)=>a.amount_cents-b.amount_cents);
  return [q("DHL","Express Worldwide",4,baseI(billable)), q("UPS","Worldwide Saver",5,baseI(billable)*1.05), q("FedEx","International Priority",4,baseI(billable)*1.03)].sort((a,b)=>a.amount_cents-b.amount_cents);
}
app.post("/api/shipping/rates", async (req,res)=>{
  try{
    const { address={}, cart=[], subtotal_cents=0 } = req.body||{};
    const to={ name:address.name||"", line1:address.line1||"", line2:address.line2||"", city:address.city||"", state:address.state||"", postal_code:address.postal_code||"", country:(address.country||"US").toUpperCase(), email: address.email||"", residential: !!address.residential };
    let totalWeightLb=0, dimL=0, dimW=0, dimH=0;
    for(const item of cart){ const p=await dbGetProduct(item.id); if(!p) continue; const qty=Math.max(1,parseInt(item.qty||1,10)); totalWeightLb+=(p.weight_lb||2)*qty; dimL=Math.max(dimL,p.dim_l_in||10); dimW=Math.max(dimW,p.dim_w_in||8); dimH+=(p.dim_h_in||4)*qty; }
    if (totalWeightLb<=0) totalWeightLb=2;
    const billable=Math.max(totalWeightLb, (dimL*dimW*dimH)/139);
    let quotes=[];
    if (EASYPOST_API_KEY && to.postal_code && to.city && to.state && to.line1){
      try{ quotes=await easypostRates({ to, parcel:{ l:dimL, w:dimW, h:dimH, weight_lb: totalWeightLb } }); }catch(e){ console.warn("EasyPost failed, fallback:", e.message); }
    }
    if (!quotes.length){
      const domestic = to.country==="US";
      let zoneMult = domestic ? ({ "0":1.0,"1":0.95,"2":0.98,"3":1.05,"4":1.10,"5":1.15,"6":1.20,"7":1.25,"8":1.28,"9":1.32 }[(to.postal_code||"")[0]||"5"] ?? 1.15) : 1.65;
      const remoteFee = (!domestic && /AU|NZ|ZA|BR|AR|CL|AE|SA|IN|ID|PH|CN|JP|KR/.test(to.country)) ? 8.0 : 0.0;
      const residentialFee = to.residential ? 4.0 : 0.0;
      const insurance = Math.max(1.0, Math.min(50.0, 0.01 * (subtotal_cents/100)));
      quotes=heuristicRates({ domestic, billable, zoneMult, residentialFee, remoteFee, insurance });
    }
    res.json({ quotes, computed:{ billable_lb: Math.round(billable*10)/10, dims:[dimL,dimW,dimH], weight_lb: totalWeightLb } });
  }catch(e){ res.status(400).json({ error:e.message }); }
});

// ===== AI Dropship (build PO + POST to your 3PL/ERP) =====
async function aiFindSupplierLink({ make, model, year, part, name }){
  const q=[year,make,model,part||name,"OEM OR Aftermarket"].filter(Boolean).join(" ");
  return (await fetchCheapestFromSerpAPI(q)) || (await fetchCheapestFromEbay(q)) || null;
}
async function processDropshipOrder(order){
  if (!DROPSHIP_WEBHOOK_URL) { console.log("[dropship] Skipped (no DROPSHIP_WEBHOOK_URL)"); return; }
  // Build Purchase Orders (one vendor per item)
  const POs=[];
  for (const it of order.items||[]){
    // Try to leverage existing AI-sourced info (if id starts with ai- we don't know supplier link, but we can re-search)
    const p = await dbGetProduct(it.id);
    let meta = null;
    if (p){
      meta = await aiFindSupplierLink({ make:p.make, model:p.model, year:p.year, part:p.part_type, name:p.name });
    } else {
      // fallback using name
      meta = await aiFindSupplierLink({ make:null, model:null, year:null, part:null, name:it.name });
    }
    POs.push({
      line_item: { sku: p?.id || it.id, name: it.name, qty: it.qty, unit_price_cents: it.unit_price_cents || it.unit_price || 0 },
      supplier: { name: meta?.source || "Unknown", url: meta?.link || null },
      suggested_cost: meta?.price || null,
      ship_to: order.address || null
    });
  }
  // POST to your dropship endpoint
  const payload = { order_id: order.id, stripe_pi: order.stripe_pi, amount_cents: order.amount_cents, currency: order.currency, customer: { name: order.name, email: order.email, address: order.address }, purchase_orders: POs };
  await fetch(DROPSHIP_WEBHOOK_URL, {
    method:"POST",
    headers: { "Content-Type":"application/json", ...(DROPSHIP_API_KEY?{ "Authorization":`Bearer ${DROPSHIP_API_KEY}` }:{}) },
    body: JSON.stringify(payload)
  }).then(r=>r.text()).then(t=>console.log("[dropship] webhook response:", t)).catch(e=>console.error("[dropship] webhook error:", e.message));
}

// ===== Frontend (eBay-style) =====
app.get("/", (_req,res)=>{
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ohio Auto Parts</title>
<link rel="preconnect" href="https://js.stripe.com"/>
<style>
:root{ --ebay-blue:#0064d2; --border:#e5e7eb; --bg:#ffffff; --muted:#6b7280; --text:#111827; --chip:#f3f4f6; }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
a{color:var(--ebay-blue);text-decoration:none}
header{border-bottom:1px solid var(--border);background:#fff;position:sticky;top:0;z-index:50}
.container{max-width:1200px;margin:0 auto;padding:12px 16px}
.top{display:grid;grid-template-columns:180px 1fr 160px;gap:12px;align-items:center}
.brand{font-weight:800;font-size:20px}
.search{display:flex;gap:8px}
.search input{flex:1;padding:12px;border:1px solid var(--border);border-radius:8px}
.search button{padding:12px 14px;background:var(--ebay-blue);color:#fff;border:0;border-radius:8px;font-weight:700;cursor:pointer}
.main{display:grid;grid-template-columns:280px 1fr;gap:18px;padding:16px}
.card{background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px}
.filters .row{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
select,input[type="number"]{padding:10px;border:1px solid var(--border);border-radius:8px;width:100%}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips button{background:var(--chip);border:1px solid var(--border);padding:8px 10px;border-radius:999px;cursor:pointer}
.results-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.sort{padding:10px;border:1px solid var(--border);border-radius:8px}
.item{display:grid;grid-template-columns:140px 1fr auto;gap:12px;padding:12px;border-bottom:1px solid var(--border)}
.item img{width:140px;height:140px;object-fit:cover;border:1px solid var(--border);border-radius:8px;background:#fafafa}
.badges{display:flex;gap:8px;flex-wrap:wrap}
.badge{display:inline-block;background:#e6f2ff;color:#0b4aa8;border:1px solid #cde3ff;padding:3px 8px;border-radius:999px;font-size:12px}
.price{font-weight:800;font-size:18px}
.btn{padding:10px 12px;background:var(--ebay-blue);color:#fff;border:0;border-radius:8px;cursor:pointer;font-weight:700}
.muted{color:var(--muted)}
.loadmore{display:block;width:100%;margin-top:12px}
.right-col{display:grid;gap:18px}
.cart-item{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)}
.totals{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:8px}
#toast{position:fixed;right:16px;bottom:16px;background:#111827;color:#fff;padding:10px 12px;border-radius:8px;opacity:0;transform:translateY(8px);transition:all .25s}
#toast.show{opacity:1;transform:translateY(0)}
/* VIN Modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:60}
.modal .box{background:#fff;border-radius:12px;padding:16px;max-width:420px;width:90%}
.modal input{width:100%;padding:12px;border:1px solid var(--border);border-radius:8px}
.modal .actions{display:flex;gap:8px;margin-top:10px;justify-content:flex-end}
</style>
</head>
<body>
<header>
  <div class="container top">
    <div class="brand">Ohio Auto Parts</div>
    <div class="search">
      <input id="searchText" placeholder="Search parts (e.g., Alternator, Radiator)"/>
      <button id="goSearch">Search</button>
    </div>
    <div style="text-align:right">
      <button id="openVin" class="btn" style="background:#10b981">VIN Lookup</button>
    </div>
  </div>
</header>

<div class="container main">
  <aside class="card filters">
    <div class="row">
      <label>Make</label>
      <select id="make"></select>
    </div>
    <div class="row">
      <label>Model</label>
      <select id="model"><option value="">All</option></select>
    </div>
    <div class="row">
      <label>Year</label>
      <select id="year"></select>
    </div>
    <div class="row">
      <label>Type</label>
      <select id="oem"><option value="">All</option><option value="oem">OEM</option><option value="aftermarket">Aftermarket</option></select>
    </div>
    <div class="row">
      <label>Sort</label>
      <select id="sort">
        <option value="relevance">Relevance</option>
        <option value="price_asc">Price: Low to High</option>
        <option value="price_desc">Price: High to Low</option>
        <option value="year_desc">Year: New to Old</option>
        <option value="year_asc">Year: Old to New</option>
      </select>
    </div>
    <div class="row">
      <label>Popular parts</label>
      <div id="cloud" class="chips"></div>
    </div>
    <button id="doFilter" class="btn" style="width:100%">Apply Filters</button>
  </aside>

  <section>
    <div class="card">
      <div class="results-head">
        <div><span id="total" class="muted">0 results</span></div>
        <div><select id="pageSize" class="sort">
          <option value="30">30 / page</option>
          <option value="60" selected>60 / page</option>
          <option value="120">120 / page</option>
        </select></div>
      </div>
      <div id="results"></div>
      <button id="loadMore" class="btn loadmore">Load more</button>
    </div>
  </section>

  <aside class="right-col">
    <div class="card">
      <h3 style="margin:0 0 8px">Cart</h3>
      <div id="cart"></div>
      <div class="totals"><div class="muted">Subtotal:</div><div id="subtotal">$0.00</div></div>
      <div class="totals"><div class="muted">Shipping:</div><div id="shiptotal">$0.00</div></div>
      <div class="totals"><div style="font-weight:800">Total:</div><div id="grandtotal" style="font-weight:800">$0.00</div></div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 8px">Shipping & Checkout</h3>
      <input id="name" placeholder="Full name" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px"/>
      <input id="email" placeholder="Email" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:8px"/>
      <input id="addr1" placeholder="Address line 1" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:8px"/>
      <input id="addr2" placeholder="Address line 2 (optional)" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;margin-top:8px"/>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin-top:8px">
        <input id="city" placeholder="City" style="padding:10px;border:1px solid var(--border);border-radius:8px"/>
        <input id="state" placeholder="State" style="padding:10px;border:1px solid var(--border);border-radius:8px"/>
        <input id="zip" placeholder="ZIP" style="padding:10px;border:1px solid var(--border);border-radius:8px"/>
        <select id="country" style="padding:10px;border:1px solid var(--border);border-radius:8px"><option value="US" selected>US</option><option>CA</option><option>GB</option><option>DE</option><option>FR</option><option>IT</option><option>ES</option><option>NL</option><option>SE</option><option>NO</option><option>DK</option><option>IE</option><option>AU</option><option>NZ</option><option>JP</option><option>KR</option></select>
      </div>
      <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input id="residential" type="checkbox" checked/> Residential</label>
      <button id="getRates" class="btn" style="width:100%;margin-top:8px">Get Rates</button>
      <div id="rates" style="display:flex;flex-direction:column;gap:8px;margin-top:8px"></div>
      <div id="payment-request-button" style="margin-top:8px"></div>
      <div id="payment-element" style="margin-top:8px"></div>
      <button id="pay" class="btn" style="width:100%;margin-top:8px">Pay Now</button>
      <div id="message" class="muted" style="margin-top:6px;min-height:1.2em"></div>
    </div>
  </aside>
</div>

<!-- VIN Modal -->
<div id="vinModal" class="modal"><div class="box">
  <h3 style="margin:0 0 8px">Decode VIN</h3>
  <input id="vin" maxlength="17" placeholder="Enter 17-character VIN"/>
  <div id="vinStatus" class="muted" style="margin-top:6px"></div>
  <div class="actions">
    <button id="closeVin" class="btn" style="background:#6b7280">Close</button>
    <button id="decodeVin" class="btn">Decode</button>
  </div>
</div></div>

<div id="toast"></div>

<script src="https://js.stripe.com/v3"></script>
<script>
const fmt = (c)=>'$'+(c/100).toFixed(2);
const toast = (t)=>{ const el=document.getElementById('toast'); el.textContent=t; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), 2000); };

let stripe, elements, paymentElement, paymentRequest, prButton, clientSecret;
const cart=[]; let selectedRate=null; let subtotalCents=0;
let page=1;

const makeEl=document.getElementById('make'), modelEl=document.getElementById('model'), yearEl=document.getElementById('year');
const oemEl=document.getElementById('oem'), sortEl=document.getElementById('sort'), pageSizeEl=document.getElementById('pageSize');
const searchText=document.getElementById('searchText');
const resultsEl=document.getElementById('results'), totalEl=document.getElementById('total'), loadMoreBtn=document.getElementById('loadMore');

async function init(){
  // load filters
  const makes=await (await fetch('/api/makes')).json();
  makeEl.innerHTML=['<option value="">All</option>',...makes.map(x=>'<option>'+x+'</option>')].join('');
  const years=await (await fetch('/api/years')).json();
  yearEl.innerHTML=['<option value="">All</option>',...years.map(y=>'<option>'+y+'</option>')].join('');
  // parts cloud
  const parts=await (await fetch('/api/parts')).json();
  document.getElementById('cloud').innerHTML = parts.map(p=>\`<button data-p="\${p}">\${p}</button>\`).join('');
  document.querySelectorAll('#cloud button').forEach(b=>b.onclick=()=>{ searchText.value=b.dataset.p; doSearch(true); });

  // VIN modal
  const modal=document.getElementById('vinModal'); document.getElementById('openVin').onclick=()=>modal.style.display='flex';
  document.getElementById('closeVin').onclick=()=>modal.style.display='none';
  document.getElementById('decodeVin').onclick=decodeVIN;

  makeEl.onchange = async ()=>{ modelEl.innerHTML='<option value="">All</option>'; if(!makeEl.value) return;
    const models=await (await fetch('/api/models?make='+encodeURIComponent(makeEl.value))).json();
    modelEl.innerHTML=['<option value="">All</option>',...models.map(x=>'<option>'+x+'</option>')].join('');
  };

  document.getElementById('goSearch').onclick = ()=>doSearch(true);
  document.getElementById('doFilter').onclick = ()=>doSearch(true);
  loadMoreBtn.onclick = ()=>doSearch(false);

  // Stripe
  const { publishableKey } = await (await fetch('/config')).json();
  stripe = Stripe(publishableKey);
  await updateStripe(0,0);

  renderCart();
  await doSearch(true);
}

async function decodeVIN(){
  const status=document.getElementById('vinStatus'); const vin=document.getElementById('vin').value.trim();
  status.textContent='Decoding...';
  const r=await fetch('/api/vin/decode?vin='+encodeURIComponent(vin)); const d=await r.json();
  if(!d.ok){ status.textContent=d.error||'Failed to decode.'; return; }
  // set Make/Model/Year
  if (d.make){ makeEl.value=d.make; const models=await (await fetch('/api/models?make='+encodeURIComponent(d.make))).json(); modelEl.innerHTML=['<option value="">All</option>',...models.map(x=>'<option>'+x+'</option>')].join(''); }
  if (d.model){ modelEl.value=d.model; }
  if (d.year){ yearEl.value=d.year; }
  toast('VIN decoded: ' + [d.make,d.model,d.year].filter(Boolean).join(' • '));
  document.getElementById('vinModal').style.display='none';
  await doSearch(true);
}

async function doSearch(reset){
  if (reset){ page=1; resultsEl.innerHTML=''; }
  const params = new URLSearchParams();
  if (makeEl.value) params.set('make', makeEl.value);
  if (modelEl.value) params.set('model', modelEl.value);
  if (yearEl.value) params.set('year', yearEl.value);
  if (oemEl.value) params.set('oem', oemEl.value);
  if (searchText.value) params.set('q', searchText.value);
  params.set('sort', sortEl.value);
  params.set('page', page);
  params.set('page_size', pageSizeEl.value);
  const { items, total } = await (await fetch('/api/products?'+params.toString())).json();
  totalEl.textContent = total + ' results';
  renderResults(items);
  page++;
  loadMoreBtn.style.display = ((page-1)*parseInt(pageSizeEl.value,10) >= total) ? 'none' : 'block';
}

function renderResults(items){
  if(!items.length && !resultsEl.children.length){ resultsEl.innerHTML='<div class="muted">No results.</div>'; return; }
  const frag=document.createDocumentFragment();
  items.forEach(p=>{
    const row=document.createElement('div'); row.className='item';
    const img=document.createElement('img'); img.alt='image'; img.src=p.image_url||'';
    if(!p.image_url){ // AI image fetch, then attach
      fetch('/api/image/ai',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ productId: p.id }) })
        .then(r=>r.json()).then(j=>{ if(j.image_url){ img.src=j.image_url; }});
    }
    const info=document.createElement('div');
    info.innerHTML=\`
      <div style="font-weight:700">\${p.name}</div>
      <div class="muted">\${p.part_type} • \${p.oem?'OEM':'Aftermarket'} • \${p.year}</div>
      <div class="badges"><span class="badge">\${p.stock>0?'In stock':'Out of stock'}</span></div>\`;
    const right=document.createElement('div');
    right.innerHTML=\`<div class="price">\${fmt(p.price_cents)}</div>\`;
    const btn=document.createElement('button'); btn.className='btn'; btn.textContent=p.stock>0?'Add to Cart':'Out of stock'; btn.disabled = p.stock<=0;
    btn.onclick=()=>addToCart(p.id,p.name,p.price_cents);
    right.appendChild(btn);

    row.appendChild(img); row.appendChild(info); row.appendChild(right);
    frag.appendChild(row);
  });
  resultsEl.appendChild(frag);
}

function addToCart(id,name,price_cents){
  const found=cart.find(i=>i.id===id); if(found) found.qty+=1; else cart.push({ id,name,price_cents,qty:1 });
  renderCart();
}
function renderCart(){
  const c=document.getElementById('cart'); c.innerHTML='';
  if(!cart.length){ c.innerHTML='<div class="muted">Your cart is empty.</div>'; }
  cart.forEach(it=>{
    const row=document.createElement('div'); row.className='cart-item';
    row.innerHTML=\`<div>\${it.name}</div><div>
      <button class="btn" style="padding:6px 10px;background:#e5e7eb;color:#111" data-act="minus">-</button>
      <span>\${it.qty}</span>
      <button class="btn" style="padding:6px 10px" data-act="plus">+</button>
    </div><div>\${fmt(it.price_cents*it.qty)}</div>\`;
    row.querySelector('[data-act="minus"]').onclick=()=>{ it.qty=Math.max(0,it.qty-1); if(it.qty===0) cart.splice(cart.indexOf(it),1); renderCart(); };
    row.querySelector('[data-act="plus"]').onclick=()=>{ it.qty+=1; renderCart(); };
    c.appendChild(row);
  });
  subtotalCents = cart.reduce((s,i)=>s+i.price_cents*i.qty,0);
  document.getElementById('subtotal').textContent=fmt(subtotalCents);
  selectedRate=null; document.getElementById('rates').innerHTML=''; document.getElementById('shiptotal').textContent=fmt(0);
  updateTotals(); updateStripe(subtotalCents, 0);
}
function updateTotals(){ const ship=selectedRate?.amount_cents||0; document.getElementById('grandtotal').textContent=fmt(subtotalCents+ship); }

// Shipping + Checkout
document.getElementById('getRates').onclick = async ()=>{
  if(!cart.length){ alert('Add items first.'); return; }
  const address={ name:document.getElementById('name').value, email:document.getElementById('email').value,
    line1:document.getElementById('addr1').value, line2:document.getElementById('addr2').value,
    city:document.getElementById('city').value, state:document.getElementById('state').value,
    postal_code:document.getElementById('zip').value, country:document.getElementById('country').value,
    residential: document.getElementById('residential').checked };
  const r=await fetch('/api/shipping/rates',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ address, cart, subtotal_cents: subtotalCents }) });
  const { quotes } = await r.json();
  const list=document.getElementById('rates'); list.innerHTML='';
  quotes.forEach((q,i)=>{
    const wrap=document.createElement('label'); wrap.style.display='flex'; wrap.style.alignItems='center'; wrap.style.gap='8px';
    wrap.innerHTML=\`<input type="radio" name="rate" value="\${i}"> \${q.carrier} – \${q.service} \${q.days?'(~'+q.days+' days)':''} <div style="margin-left:auto;font-weight:800">\${fmt(q.amount_cents)}</div>\`;
    wrap.querySelector('input').onchange=()=>{ selectedRate=q; document.getElementById('shiptotal').textContent=fmt(q.amount_cents); updateTotals(); updateStripe(subtotalCents, q.amount_cents); };
    list.appendChild(wrap);
  });
};

async function initStripeElements(amount){
  const { publishableKey } = await (await fetch('/config')).json();
  stripe = Stripe(publishableKey);
}
async function createPI(subtotal, shipping_cents){
  const email=document.getElementById('email').value || undefined;
  const shippingMeta= selectedRate ? { carrier:selectedRate.carrier, service:selectedRate.service, days:selectedRate.days, amount_cents:selectedRate.amount_cents } : null;
  const payloadCart = cart.map(i=>({ id:i.id, name:i.name, qty:i.qty, price_cents:i.price_cents }));
  const r=await fetch('/create-payment-intent',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ currency:'usd', cart: payloadCart, email, shipping: shippingMeta }) });
  const js=await r.json(); if(js.error) throw new Error(js.error); return js;
}
async function updateStripe(subtotal, shipping_cents){
  const out = await createPI(subtotal, shipping_cents);
  clientSecret=out.clientSecret;
  if (!elements){ elements=stripe.elements({ clientSecret }); }
  if (paymentElement) paymentElement.unmount();
  paymentElement = elements.create('payment'); paymentElement.mount('#payment-element');

  if (!paymentRequest){
    paymentRequest = stripe.paymentRequest({ country:"US", currency:"usd", total:{ label:"Ohio Auto Parts", amount: out.amount }, requestPayerName:true, requestPayerEmail:true });
    prButton = elements.create('paymentRequestButton', { paymentRequest });
    const can = await paymentRequest.canMakePayment();
    if (can) prButton.mount('#payment-request-button'); else document.getElementById('payment-request-button').style.display='none';
    paymentRequest.on('paymentmethod', async (ev)=>{
      const { error } = await stripe.confirmCardPayment(clientSecret, { payment_method: ev.paymentMethod.id }, { handleActions: true });
      if (error){ ev.complete('fail'); document.getElementById('message').textContent = error.message||'Payment failed.'; return; }
      ev.complete('success'); document.getElementById('message').textContent = 'Payment successful!';
    });
  } else {
    paymentRequest.update({ total:{ label:"Ohio Auto Parts", amount: out.amount } });
  }
  document.getElementById('grandtotal').textContent = fmt(out.amount);
}
document.getElementById('pay').onclick = async ()=>{
  try{
    document.getElementById('message').textContent='Processing...';
    const { error } = await stripe.confirmPayment({ elements, confirmParams:{ return_url: window.location.href }, redirect:'if_required' });
    if (error) document.getElementById('message').textContent=error.message||'Payment failed.'; else document.getElementById('message').textContent='Payment successful!';
  }catch(e){ document.getElementById('message').textContent=e.message; }
};

init();
</script>
</body></html>`);
});

// ===== Start =====
app.listen(PORT, ()=>console.log("Ohio Auto Parts running on port", PORT));
