// server.js
// Ohio Auto Parts – Single-file store: Express + Stripe + VIN + Year/Make/Model + Catalog + Live Carrier Rates (EasyPost)
// Changes in this version:
// - Title: removed "US, Germany, Europe"
// - Theme: black / gold / white
// - VIN → OEM/Aftermarket matching endpoint with NHTSA (free) + optional PartsTech adapter
// - Live shipping rates via EasyPost (UPS/FedEx/DHL) if EASYPOST_API_KEY is set; heuristic fallback otherwise
// - Keeps AI "cheapest+75%" sourcing and Year filter

// ========================= ENV / CONFIG =========================
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_xxx";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_xxx";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APPLE_PAY_VERIFICATION_CONTENT = process.env.APPLE_PAY_VERIFICATION_CONTENT || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme-admin";

// Live Carrier (EasyPost REST) — optional
const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY || "";
const SHIP_FROM_NAME = process.env.SHIP_FROM_NAME || "Ohio Auto Parts";
const SHIP_FROM_STREET1 = process.env.SHIP_FROM_STREET1 || "123 Warehouse Rd";
const SHIP_FROM_STREET2 = process.env.SHIP_FROM_STREET2 || "";
const SHIP_FROM_CITY = process.env.SHIP_FROM_CITY || "Columbus";
const SHIP_FROM_STATE = process.env.SHIP_FROM_STATE || "OH";
const SHIP_FROM_ZIP = process.env.SHIP_FROM_ZIP || "43004";
const SHIP_FROM_COUNTRY = process.env.SHIP_FROM_COUNTRY || "US";
const SHIP_FROM_PHONE = process.env.SHIP_FROM_PHONE || "5555555555";
const SHIP_FROM_EMAIL = process.env.SHIP_FROM_EMAIL || "support@ohioautoparts.example";

// VIN → OEM Catalog (optional adapters)
// PartsTech (example adapter; requires org/project tokens)
const PARTSTECH_API_KEY = process.env.PARTSTECH_API_KEY || ""; // if set, adapter is enabled

// AI web price sourcing (optional)
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";   // serpapi.com
const EBAY_APP_ID = process.env.EBAY_APP_ID || "";   // eBay Finding API

const PORT = process.env.PORT || 3000;
const stripe = require("stripe")(STRIPE_SECRET_KEY);

// ========================= DB (Postgres optional) =========================
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
      console.warn("[DB] Postgres unavailable, using in-memory:", e.message);
      db = memoryDB();
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
      return state.products.filter(p =>
        (!filter.make || p.make === filter.make) &&
        (!filter.model || p.model === filter.model) &&
        (!filter.year || p.year === filter.year) &&
        (!filter.oemFlag || (filter.oemFlag === "oem" ? p.oem : !p.oem)) &&
        (!filter.q || (p.name.toLowerCase().includes(filter.q) || p.part_type.toLowerCase().includes(filter.q)))
      ).slice(0, 100);
    },
    async getProduct(id){ return state.products.find(p => p.id === id); },
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

// ========================= Seed Catalog =========================
function sampleProducts() {
  const pick = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  const MAKES = ["Ford","Chevrolet","GMC","Ram","BMW","Mercedes-Benz","Audi","Volkswagen","Porsche","Volvo","Peugeot","Renault","Citroën","Fiat","Alfa Romeo","Škoda","Dacia","Land Rover","Jaguar","Mini","SEAT","Cupra","Opel","Tesla"];
  const MODELS = {
    Ford:["F-150","Mustang","Explorer","Ranger","Transit"],
    Chevrolet:["Silverado","Tahoe","Suburban","Equinox","Camaro"],
    GMC:["Sierra","Yukon","Acadia","Terrain","Canyon"],
    Ram:["1500","2500","ProMaster"],
    BMW:["3 Series","5 Series","X3","X5","i4"],
    "Mercedes-Benz":["C-Class","E-Class","GLC","GLE","EQE"],
    Audi:["A4","A6","Q5","Q7","Q8"],
    Volkswagen:["Golf","Jetta","Passat","Tiguan","Atlas","ID.4"],
    Porsche:["911","Cayenne","Macan","Taycan"],
    Volvo:["XC40","XC60","XC90","S60","EX30"],
    Peugeot:["208","308","3008","5008","508"],
    Renault:["Clio","Megane","Captur","Arkana"],
    Citroën:["C3","C4","C5 Aircross","Berlingo"],
    Fiat:["500","500X","Panda","Tipo"],
    "Alfa Romeo":["Giulia","Stelvio","Tonale"],
    "Škoda":["Octavia","Fabia","Kodiaq","Enyaq"],
    Dacia:["Duster","Sandero","Logan","Jogger"],
    "Land Rover":["Defender","Discovery","Range Rover","Evoque"],
    Jaguar:["XE","XF","F-PACE","I-PACE"],
    Mini:["3-Door","5-Door","Countryman"],
    SEAT:["Ibiza","Leon","Ateca","Tarraco"],
    Cupra:["Leon","Formentor","Born"],
    Opel:["Corsa","Astra","Mokka","Grandland"],
    Tesla:["Model 3","Model Y","Model S","Model X","Cybertruck"]
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
    "https://images.unsplash.com/photo-1517747614396-d21a78b850e8?q=80&w=800&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop",
    "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?q=80&w=800&auto=format&fit=crop"
  ];
  const years = Array.from({length: 21}, (_,i)=>2005+i); // 2005–2025
  const out = [];
  for (let i=0;i<200;i++){
    const make = pick(MAKES);
    const model = pick(MODELS[make]);
    const [part, weight_lb, L, W, H] = pick(PARTS);
    const year = pick(years);
    const price = (Math.floor(Math.random()*220)+35)*100;
    out.push({
      id: crypto.randomUUID(),
      name: `${year} ${make} ${model} – ${part}`,
      make, model, year, part_type: part,
      price_cents: price,
      stock: Math.floor(Math.random()*20),
      image_url: pick(imgs),
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
  if (rows[0].c < 60) {
    const q = `insert into products(id,name,make,model,year,part_type,price_cents,stock,image_url,weight_lb,dim_l_in,dim_w_in,dim_h_in,oem)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               on conflict (id) do nothing`;
    for (const p of items) {
      await pgPool.query(q,[p.id,p.name,p.make,p.model,p.year,p.part_type,p.price_cents,p.stock,p.image_url,p.weight_lb,p.dim_l_in,p.dim_w_in,p.dim_h_in,p.oem]);
    }
  }
}

// DB helpers
async function dbListProducts(filter) {
  const q = (filter.q||"").toLowerCase();
  if (db.useMemory) return db.listProducts(filter);
  let where = [], vals = [];
  if (filter.make) { vals.push(filter.make); where.push(`make = $${vals.length}`); }
  if (filter.model){ vals.push(filter.model); where.push(`model = $${vals.length}`); }
  if (filter.year){ vals.push(filter.year); where.push(`year = $${vals.length}`); }
  if (filter.oemFlag){
    if (filter.oemFlag === "oem") where.push(`oem = true`);
    else if (filter.oemFlag === "aftermarket") where.push(`oem = false`);
  }
  if (q){ vals.push(`%${q}%`); where.push(`(lower(name) like $${vals.length} or lower(part_type) like $${vals.length})`); }
  const sql = `select * from products ${where.length?'where '+where.join(' and '):''} order by stock desc, name limit 100`;
  const { rows } = await pgPool.query(sql, vals);
  return rows;
}
async function dbGetProduct(id) {
  if (db.useMemory) return db.getProduct(id);
  const { rows } = await pgPool.query("select * from products where id=$1",[id]);
  return rows[0] || null;
}
async function dbSaveOrder(o) {
  if (db.useMemory) return db.saveOrder(o);
  const sql = `insert into orders(id,stripe_pi,amount_cents,currency,email,name,address,items,shipping,status)
               values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  await pgPool.query(sql,[o.id,o.stripe_pi,o.amount_cents,o.currency,o.email,o.name,o.address,o.items,o.shipping,o.status]);
  return o;
}

// ========================= App / Webhooks =========================
const app = express();

app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  let event = req.body;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    }
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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
    console.log("[Order] saved", order.id);
  }

  res.json({ received: true });
});

app.use(bodyParser.json());

// Apple Pay domain association (optional)
if (APPLE_PAY_VERIFICATION_CONTENT) {
  app.get("/.well-known/apple-developer-merchantid-domain-association", (_req, res) => {
    res.type("text/plain").send(APPLE_PAY_VERIFICATION_CONTENT);
  });
}

// ========================= Catalog APIs =========================
const MAKES = ["Ford","Chevrolet","GMC","Ram","Dodge","Chrysler","Jeep","Cadillac","Buick","Lincoln","Tesla",
  "BMW","Mercedes-Benz","Audi","Volkswagen","Porsche","Opel","Mini","Smart",
  "Volvo","Saab","Peugeot","Renault","Citroën","Fiat","Alfa Romeo","Lancia","SEAT","Škoda","Dacia",
  "Land Rover","Jaguar","Aston Martin","Bentley","Rolls-Royce","Lotus","McLaren","Cupra","Iveco"].sort();

const MODELS = {
  Ford:["F-150","Maverick","Ranger","Super Duty","Mustang","Bronco","Explorer","Escape","Edge","Transit","Expedition"],
  Chevrolet:["Silverado","Colorado","Tahoe","Suburban","Blazer","Trailblazer","Equinox","Traverse","Malibu","Camaro","Bolt EUV"],
  GMC:["Sierra","Canyon","Yukon","Acadia","Terrain","Savana"],
  Ram:["1500","2500","3500","ProMaster","ProMaster City"],
  Dodge:["Charger","Challenger","Durango","Hornet","Caravan (legacy)"],
  Chrysler:["300","Pacifica","Voyager"],
  Jeep:["Wrangler","Grand Cherokee","Cherokee","Compass","Renegade","Gladiator","Wagoneer"],
  Cadillac:["Escalade","XT4","XT5","XT6","CT4","CT5","Lyriq"],
  Buick:["Encore","Encore GX","Envision","Enclave"],
  Lincoln:["Corsair","Nautilus","Aviator","Navigator"],
  Tesla:["Model S","Model 3","Model X","Model Y","Cybertruck"],
  BMW:["1 Series","2 Series","3 Series","4 Series","5 Series","7 Series","8 Series","X1","X3","X5","X7","i4","i5","i7","iX"],
  "Mercedes-Benz":["A-Class","C-Class","E-Class","S-Class","CLA","GLA","GLC","GLE","GLS","G-Class","EQB","EQE","EQS"],
  Audi:["A1","A3","A4","A5","A6","A7","A8","Q2","Q3","Q5","Q7","Q8","RS6","Q8 e-tron"],
  Volkswagen:["Polo","Golf","Jetta","Passat","Arteon","T-Roc","Tiguan","Touareg","Atlas","ID.3","ID.4","Transporter"],
  Porsche:["911","718","Panamera","Macan","Cayenne","Taycan"],
  Opel:["Corsa","Astra","Insignia","Mokka","Crossland","Grandland"],
  Mini:["3-Door","5-Door","Clubman","Countryman","Convertible"],
  Smart:["Fortwo","Forfour"],
  Volvo:["XC40","C40","XC60","XC90","EX30","EX90","S60","S90","V60","V90"],
  Saab:["900","9-3","9-5"],
  Peugeot:["208","2008","308","3008","408","508","5008"],
  Renault:["Twingo","Clio","Captur","Megane","Austral","Arkana","Scenic","Trafic","Master"],
  Citroën:["C3","C4","C4 X","C5 Aircross","Berlingo","SpaceTourer"],
  Fiat:["500","500X","Panda","Tipo","Doblo","Ducato"],
  "Alfa Romeo":["Giulia","Stelvio","Tonale"],
  Lancia:["Ypsilon","Delta"],
  SEAT:["Ibiza","Leon","Arona","Ateca","Tarraco"],
  "Škoda":["Fabia","Octavia","Superb","Kamiq","Karoq","Kodiaq","Enyaq"],
  Dacia:["Spring","Sandero","Logan","Duster","Jogger"],
  "Land Rover":["Defender","Discovery","Discovery Sport","Range Rover","Range Rover Sport","Velar","Evoque"],
  Jaguar:["XE","XF","F-PACE","E-PACE","F-TYPE","I-PACE"],
  "Aston Martin":["Vantage","DB12","DBX"],
  Bentley:["Bentayga","Continental GT","Flying Spur"],
  "Rolls-Royce":["Ghost","Phantom","Cullinan","Spectre"],
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

app.get("/config", (_req, res) => res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY }));
app.get("/api/makes", (_req, res) => res.json(MAKES));
app.get("/api/models", (req, res) => res.json(MODELS[req.query.make] || []));
app.get("/api/years", async (req, res) => {
  const { make, model } = req.query;
  let years = [];
  if (db.useMemory) {
    const all = await db.listProducts({ make, model });
    years = [...new Set(all.map(p=>p.year))].sort((a,b)=>b-a);
  } else {
    const { rows } = await pgPool.query(
      "select distinct year from products where make=$1 and model=$2 order by year desc",
      [make, model]
    );
    years = rows.map(r=>r.year);
  }
  res.json(years);
});
app.get("/api/parts", (_req, res) => res.json(PARTS()));

// ========================= VIN Decoding & OEM/Aftermarket Matching =========================
// NHTSA Decode VIN (free): https://vpic.nhtsa.dot.gov/api/
async function decodeVIN_NHTSA(vin){
  try{
    const u = new URL(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValues/${encodeURIComponent(vin)}?format=json`);
    const r = await fetch(u); if(!r.ok) return null; const j = await r.json();
    const row = j?.Results?.[0] || {};
    const make = row?.Make || null;
    const model = row?.Model || null;
    const year = row?.ModelYear ? parseInt(row.ModelYear,10) : null;
    return { make, model, year };
  }catch{ return null; }
}

// PartsTech adapter (pseudo; requires valid key + org setup)
async function searchPartsTech({ make, model, year, partQuery }){
  if (!PARTSTECH_API_KEY) return null;
  try {
    // This is a generic example endpoint; adapt to your PartsTech project endpoints.
    const url = "https://api.partstech.com/catalog/search";
    const body = { make, model, year, q: partQuery, limit: 10 };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization": `Bearer ${PARTSTECH_API_KEY}` },
      body: JSON.stringify(body)
    });
    if (!r.ok) return null;
    const data = await r.json();
    // Normalize a few fields
    const out = (data.items||[]).map(it => ({
      sku: it.sku || it.partNumber || it.id,
      brand: it.brand || it.manufacturer,
      name: it.title || it.name,
      oem: !!it.oem,
      price: parseFloat(it.price || it.listPrice || 0),
      link: it.link || it.url || null,
      image: it.image || it.imageUrl || null
    }));
    return out;
  } catch { return null; }
}

app.get("/api/vin/decode", async (req, res) => {
  const vin = (req.query.vin||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  if (vin.length !== 17) return res.json({ ok:false, error:"VIN must be 17 characters." });
  const meta = await decodeVIN_NHTSA(vin);
  if (!meta) return res.json({ ok:false, error:"VIN decode failed." });
  res.json({ ok:true, vin, ...meta });
});

// Given a VIN & part query, return OEM & aftermarket matches (PartsTech if available, else local DB)
app.post("/api/vin/parts", async (req, res) => {
  try{
    let { vin, part } = req.body || {};
    vin = (vin||"").toUpperCase();
    const decoded = await decodeVIN_NHTSA(vin);
    if (!decoded) return res.status(400).json({ error: "VIN decode failed" });
    const { make, model, year } = decoded;

    // Try PartsTech if configured
    let items = await searchPartsTech({ make, model, year, partQuery: part });

    if (!items || !items.length) {
      // Fallback to local catalog filtered
      const local = await (db.useMemory ? db.listProducts({ make, model, year, q: (part||"").toLowerCase() })
                                        : dbListProducts({ make, model, year, q: (part||"").toLowerCase() }));
      items = local.map(p => ({
        sku: p.id, brand: p.oem ? "OEM" : "Aftermarket", name: p.name, oem: !!p.oem,
        price: p.price_cents/100, link: null, image: p.image_url
      }));
    }

    // Group into OEM vs Aftermarket
    const oem = items.filter(i=>i.oem);
    const aftermarket = items.filter(i=>!i.oem);
    res.json({ make, model, year, oem, aftermarket });
  } catch(e){
    console.error("vin parts error:", e);
    res.status(400).json({ error: e.message });
  }
});

// ========================= Live Carrier Rates (EasyPost) =========================
function ozFromLb(lb){ return Math.max(1, Math.round(lb * 16)); }

async function easypostRates({ to, parcel }){
  // Docs: https://www.easypost.com/docs/api#shipments
  const url = "https://api.easypost.com/v2/shipments";
  const payload = {
    shipment: {
      to_address: {
        name: to.name || to.email || "Customer",
        street1: to.line1, street2: to.line2 || "",
        city: to.city, state: to.state, zip: to.postal_code, country: to.country || "US",
        phone: to.phone || "0000000000", email: to.email || "customer@example.com", residential: !!to.residential
      },
      from_address: {
        name: SHIP_FROM_NAME, street1: SHIP_FROM_STREET1, street2: SHIP_FROM_STREET2,
        city: SHIP_FROM_CITY, state: SHIP_FROM_STATE, zip: SHIP_FROM_ZIP, country: SHIP_FROM_COUNTRY,
        phone: SHIP_FROM_PHONE, email: SHIP_FROM_EMAIL
      },
      parcel: {
        length: Math.max(1, Math.round(parcel.l)), width: Math.max(1, Math.round(parcel.w)), height: Math.max(1, Math.round(parcel.h)),
        weight: Math.max(1, ozFromLb(parcel.weight_lb)) // ounces
      },
      // You can pass carrier_accounts/services if you want to narrow — we'll filter client-side.
    }
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "Authorization": "Basic " + Buffer.from(EASYPOST_API_KEY + ":").toString("base64")
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`EasyPost error: ${resp.status} ${txt}`);
  }
  const json = await resp.json();
  const rates = (json.rates||[])
    .filter(r => ["UPS","FedEx","DHLExpress","DHL eCommerce","USPS"].includes(r.carrier))
    .map(r => ({
      carrier: r.carrier.replace("DHLExpress","DHL"),
      service: r.service,
      days: r.delivery_days || null,
      amount_cents: Math.round(parseFloat(r.rate)*100),
      currency: r.currency || "USD"
    }))
    .sort((a,b)=>a.amount_cents - b.amount_cents)
    .slice(0, 6);
  return rates;
}

// Heuristic fallback (used previously)
function heuristicRates({ domestic, billable, zoneMult, residentialFee, remoteFee, insurance }){
  function baseGround(bw){ return 8 + 0.55*bw; }
  function base2Day(bw){ return 15 + 0.95*bw; }
  function baseOvernight(bw){ return 24 + 1.45*bw; }
  function baseIntlExpress(bw){ return 32 + 1.65*bw; }
  function toCents(n){ return Math.max(1, Math.round(n*100)); }

  const fuel = 0.12;
  const quote = (carrier,service,days,base)=>{
    let amt = base * zoneMult;
    amt += residentialFee + remoteFee + insurance;
    amt = amt * (1 + fuel);
    return { carrier, service, days, amount_cents: toCents(amt) };
  };

  if (domestic) {
    return [
      quote("UPS","Ground",3, baseGround(billable)),
      quote("UPS","2nd Day Air",2, base2Day(billable)),
      quote("FedEx","Ground",3, baseGround(billable)*0.98),
      quote("FedEx","2Day",2, base2Day(billable)*0.99),
      quote("FedEx","Standard Overnight",1, baseOvernight(billable))
    ].sort((a,b)=>a.amount_cents-b.amount_cents);
  } else {
    return [
      quote("DHL","Express Worldwide",4, baseIntlExpress(billable)),
      quote("UPS","Worldwide Saver",5, baseIntlExpress(billable)*1.05),
      quote("FedEx","International Priority",4, baseIntlExpress(billable)*1.03)
    ].sort((a,b)=>a.amount_cents-b.amount_cents);
  }
}

app.post("/api/shipping/rates", async (req, res) => {
  try {
    const { address = {}, cart = [], subtotal_cents = 0 } = req.body || {};
    const to = {
      name: address.name || "", email: address.email || "",
      line1: address.line1 || "", line2: address.line2 || "",
      city: address.city || "", state: address.state || "", postal_code: address.postal_code || "",
      country: (address.country||"US").toUpperCase(), residential: !!address.residential
    };

    // Aggregate parcel dims
    let totalWeightLb = 0, dimL=0, dimW=0, dimH=0;
    for (const item of cart) {
      const p = await dbGetProduct(item.id); if (!p) continue;
      const qty = Math.max(1, parseInt(item.qty||1,10));
      totalWeightLb += (p.weight_lb||2) * qty;
      dimL = Math.max(dimL, p.dim_l_in||10);
      dimW = Math.max(dimW, p.dim_w_in||8);
      dimH += (p.dim_h_in||4) * qty;
    }
    if (totalWeightLb <= 0) totalWeightLb = 2;

    const billable = Math.max(totalWeightLb, (dimL*dimW*dimH)/139);
    const domestic = to.country === "US";

    // Try EasyPost first
    let quotes = [];
    if (EASYPOST_API_KEY && to.postal_code && to.city && to.state && to.line1) {
      try {
        quotes = await easypostRates({ to, parcel: { l:dimL, w:dimW, h:dimH, weight_lb: totalWeightLb } });
      } catch (e) {
        console.warn("[shipping] EasyPost failed, falling back:", e.message);
      }
    }

    if (!quotes.length) {
      // Fallback heuristic
      let zoneMult = 1.0;
      if (domestic) {
        const z = String(to.postal_code||"").trim()[0] || "5";
        const table = { "0":1.00,"1":0.95,"2":0.98,"3":1.05,"4":1.10,"5":1.15,"6":1.20,"7":1.25,"8":1.28,"9":1.32 };
        zoneMult = table[z] ?? 1.15;
      } else {
        zoneMult = 1.65;
      }
      const remoteFee = (!domestic && /AU|NZ|ZA|BR|AR|CL|AE|SA|IN|ID|PH|CN|JP|KR/.test(to.country)) ? 8.0 : 0.0;
      const residentialFee = to.residential ? 4.0 : 0.0;
      const insurance = Math.max(1.0, Math.min(50.0, 0.01 * (subtotal_cents/100)));
      quotes = heuristicRates({ domestic, billable, zoneMult, residentialFee, remoteFee, insurance });
    }

    res.json({ quotes, computed: { billable_lb: Math.round(billable*10)/10, dim: [dimL,dimW,dimH], weight_lb: totalWeightLb } });
  } catch (e) {
    console.error("shipping rates error:", e);
    res.status(400).json({ error: e.message });
  }
});

// ========================= AI Cheapest + 75% Markup =========================
async function fetchCheapestFromSerpAPI(query){
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
    let lowest = null;
    for (const it of items) {
      const priceStr = (it.price||"").replace(/[^0-9.]/g,"");
      const price = parseFloat(priceStr);
      if (Number.isFinite(price)) {
        if (!lowest || price < lowest.price) lowest = { price, title: it.title, link: it.link, source: "Google Shopping" };
      }
    }
    return lowest;
  } catch { return null; }
}
async function fetchCheapestFromEbay(query){
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
    const arr = json.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];
    let lowest = null;
    for (const it of arr) {
      const p = parseFloat(it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || "NaN");
      const title = it.title?.[0];
      const link = it.viewItemURL?.[0];
      if (Number.isFinite(p)) {
        if (!lowest || p < lowest.price) lowest = { price: p, title, link, source: "eBay" };
      }
    }
    return lowest;
  }catch{ return null; }
}
function markup75(price){ return Math.round(price * 1.75 * 100); }

app.post("/api/market/cheapest", async (req, res) => {
  try {
    const { make, model, year, part } = req.body || {};
    const q = [year, make, model, part, "OEM OR Aftermarket"].filter(Boolean).join(" ");
    let best = null;
    try { best = await fetchCheapestFromSerpAPI(q); } catch {}
    if (!best) { try { best = await fetchCheapestFromEbay(q); } catch {} }
    if (!best) {
      const base = /rotor|radiator|bumper|compressor|converter/i.test(part||"") ? 180
                : /alternator|shock|control|bearing|headlight/i.test(part||"") ? 120
                : /filter|plug|sensor/i.test(part||"") ? 28
                : 75;
      best = { price: base, title: `${year||""} ${make||""} ${model||""} ${part||""}`.trim(), link: null, source: "Heuristic" };
    }
    const marked = markup75(best.price); // cents
    const product = {
      id: "ai-"+crypto.randomUUID(),
      name: `${year||""} ${make||""} ${model||""} – ${part||""} (AI-sourced)`.replace(/\s+/g," ").trim(),
      make, model, year: year?parseInt(year,10):undefined,
      part_type: part, price_cents: marked, stock: 5,
      image_url: null,
      source_price: best.price,
      source_link: best.link,
      source_from: best.source
    };
    res.json({ product });
  } catch (e) {
    console.error("market cheapest error:", e);
    res.status(400).json({ error: e.message });
  }
});

// ========================= Payments =========================
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { cart = [], currency = "usd", email, shipping = null } = req.body || {};
    let subtotal = 0;
    const compactItems = [];

    for (const item of cart) {
      let p = null;
      if (!String(item.id).startsWith("ai-")) {
        p = await dbGetProduct(item.id);
      }
      const qty = Math.max(1, parseInt(item.qty||1,10));
      const unit = p ? p.price_cents : parseInt(item.price_cents, 10);
      if (!Number.isFinite(unit)) continue;
      subtotal += unit * qty;
      compactItems.push({ id: item.id, name: item.name, qty, unit_price_cents: unit });
    }
    if (subtotal <= 0) subtotal = 4900;

    const shipping_cents = shipping?.amount_cents ? parseInt(shipping.amount_cents,10) : 0;
    const amount = subtotal + Math.max(0, shipping_cents);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      receipt_email: email || undefined,
      automatic_payment_methods: { enabled: true },
      metadata: {
        site: "Ohio Auto Parts",
        items: JSON.stringify(compactItems.slice(0, 20)),
        shipping: JSON.stringify(shipping || {})
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret, amount, subtotal, shipping_cents });
  } catch (e) {
    console.error("create-payment-intent error:", e);
    res.status(400).json({ error: e.message });
  }
});

// ========================= Frontend =========================
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ohio Auto Parts</title>
<link rel="preconnect" href="https://js.stripe.com"/>
<style>
:root{
  --bg:#0a0a0a; --card:#121212; --gold:#d4af37; --white:#ffffff; --text:#f2f2f2;
  --muted:#c9c6b8; --line:rgba(255,255,255,.08)
}
*{box-sizing:border-box}
body{ margin:0; color:var(--text); font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  background: radial-gradient(900px 600px at 20% -10%, rgba(212,175,55,.12), transparent 60%),
              radial-gradient(700px 500px at 110% 10%, rgba(255,255,255,.08), transparent 60%),
              linear-gradient(180deg, #000, #0a0a0a 40%, #0e0e0e);
}
body::before{
  content:""; position:fixed; inset:0; z-index:-1; opacity:.15;
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='420' height='420' viewBox='0 0 420 420'%3E%3Cg fill='none' stroke='%23d4af37' stroke-opacity='.4'%3E%3Cpath d='M30 40h120l15 20h90l15-20h120l-30 40H60z'/%3E%3Ccircle cx='210' cy='210' r='28'/%3E%3Crect x='40' y='300' width='120' height='28' rx='6'/%3E%3Crect x='260' y='80' width='110' height='28' rx='6'/%3E%3Cpath d='M100 210h80l10 16h40l10-16h80'/%3E%3C/g%3E%3C/svg%3E");
  background-size: 420px 420px; background-repeat: repeat;
}
header{position:sticky;top:0;z-index:20;padding:20px 16px;background:linear-gradient(180deg,rgba(0,0,0,.85),rgba(0,0,0,.45),transparent);border-bottom:1px solid var(--line);backdrop-filter:saturate(1.1) blur(8px)}
.container{max-width:1180px;margin:0 auto;padding:0 16px}.brand{display:flex;gap:12px;align-items:center}
.logo{width:42px;height:42px;border-radius:12px;background:radial-gradient(60% 60% at 30% 30%,var(--gold),transparent 60%),linear-gradient(135deg,#141414,#1b1b1b);box-shadow:0 0 24px rgba(212,175,55,.35), inset 0 0 12px rgba(255,255,255,.08)}
h1{margin:0;font-size:1.6rem;color:var(--white)}
.subtitle{color:var(--muted);font-size:.95rem;margin-top:4px}
main{padding:26px 0 70px}.grid{display:grid;gap:16px}@media(min-width:1180px){.grid{grid-template-columns:1.4fr 1.2fr 1.2fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 8px 28px rgba(0,0,0,.35)}
label{display:block;margin-bottom:8px;color:#f4e9c5}
input,select,button{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:#0f0f0f;color:var(--text);outline:none}
input:focus,select:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(212,175,55,.22)}
.btn{cursor:pointer;font-weight:800;letter-spacing:.2px;border:none;color:#111;background:linear-gradient(135deg,#ffd76b,var(--gold));box-shadow:0 10px 24px rgba(212,175,55,.25);transition:transform .06s}.btn:active{transform:translateY(1px)}
.muted{color:var(--muted)}.status{min-height:1.2em;font-size:.92rem;margin-top:6px}
.products{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}@media(min-width:720px){.products{grid-template-columns:1fr 1fr 1fr}}
.prod{background:#101010;border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px}
.prod img{width:100%;height:140px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.stock{font-weight:700;border:1px solid rgba(212,175,55,.55);color:#111;background:linear-gradient(180deg,#ffd76b,#d4af37);padding:2px 8px;border-radius:999px;font-size:.85rem}
.cart{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:14px;padding:12px}
.cart-item{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;margin-bottom:8px}
.parts{display:flex;flex-wrap:wrap;gap:8px;max-height:140px;overflow:auto;margin-top:6px}
.tag{padding:8px 10px;border:1px solid var(--line);border-radius:999px;font-size:.85rem;background:#0f0f0f;color:#f7f4ea;cursor:pointer}
.totals{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:8px}
.rate{display:flex;gap:8px;align-items:center;border:1px solid var(--line);padding:8px;border-radius:10px;background:#0f0f0f}
.badge{display:inline-block;padding:4px 8px;border:1px solid rgba(255,255,255,.2);border-radius:999px;font-size:.85rem;margin-left:8px;color:#eee}
</style>
</head>
<body>
<header><div class="container brand">
  <div class="logo" aria-hidden="true"></div>
  <div><h1>Ohio Auto Parts</h1>
  <div class="subtitle">VIN & Year-matched parts • In-stock status • Live carrier rates • Apple Pay & Google Pay</div></div>
</div></header>

<main class="container">
  <section class="grid">
    <!-- VIN + Search -->
    <div class="card">
      <h2 style="margin:6px 0 10px">VIN Search</h2>
      <div style="display:grid;grid-template-columns:2fr auto;gap:10px">
        <input id="vin" maxlength="17" placeholder="Enter 17-character VIN"/>
        <button id="decodeVin" class="btn">Decode VIN</button>
      </div>
      <div id="vinMeta" class="muted" style="margin-top:8px"></div>
      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent);margin:14px 0"></div>

      <h2 style="margin:6px 0 10px">Find Parts</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div><label for="make">Make</label><select id="make"><option>Loading…</option></select></div>
        <div><label for="model">Model</label><select id="model" disabled><option>Select a make first</option></select></div>
        <div><label for="year">Year</label><select id="year" disabled><option>Select model</option></select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:12px;margin-top:10px;align-items:end">
        <div><label for="q">Search part</label><input id="q" placeholder="Brake Pads, Alternator, Radiator…"/></div>
        <div>
          <label>Type</label>
          <div>
            <label><input type="radio" name="oem" value="" checked style="width:auto"> All</label>
            <label><input type="radio" name="oem" value="oem" style="width:auto"> OEM</label>
            <label><input type="radio" name="oem" value="aftermarket" style="width:auto"> Aftermarket</label>
          </div>
        </div>
      </div>
      <button id="search" class="btn" style="margin-top:10px">Search</button>
      <div id="results" class="products"></div>
      <div id="aiResult" class="products" style="margin-top:10px"></div>
      <div class="parts" id="partsCloud" style="margin-top:10px"></div>
    </div>

    <!-- Cart / Rates -->
    <div class="card">
      <h2 style="margin:6px 0 10px">Cart & Shipping</h2>
      <div id="cart" class="cart"></div>
      <div class="totals"><div class="muted">Subtotal:</div><div id="subtotal">$0.00</div></div>
      <div style="margin-top:10px">
        <div class="muted" style="margin-bottom:6px">Shipping Address</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <input id="name" placeholder="Full name"/>
          <input id="email" placeholder="Email"/>
        </div>
        <input id="addr1" placeholder="Address line 1" style="margin-top:8px"/>
        <input id="addr2" placeholder="Address line 2 (optional)" style="margin-top:8px"/>
        <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px;margin-top:8px">
          <input id="city" placeholder="City"/>
          <input id="state" placeholder="State/Province"/>
          <input id="zip" placeholder="ZIP/Postal"/>
          <select id="country">
            <option value="US" selected>US</option><option value="CA">CA</option><option value="GB">GB</option>
            <option value="DE">DE</option><option value="FR">FR</option><option value="IT">IT</option><option value="ES">ES</option>
            <option value="NL">NL</option><option value="SE">SE</option><option value="NO">NO</option><option value="DK">DK</option>
            <option value="IE">IE</option><option value="AU">AU</option><option value="NZ">NZ</option><option value="JP">JP</option><option value="KR">KR</option>
          </select>
        </div>
        <label style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <input id="residential" type="checkbox" checked style="width:auto"> Residential address
        </label>
        <button id="getRates" class="btn" style="margin-top:10px">Get Live Rates</button>
      </div>
      <div id="rates" style="display:flex;flex-direction:column;gap:8px;margin-top:10px"></div>
      <div class="totals"><div class="muted">Shipping:</div><div id="shiptotal">$0.00</div></div>
      <div class="totals"><div class="muted">Order Total:</div><div id="grandtotal">$0.00</div></div>
    </div>

    <!-- Checkout -->
    <div class="card">
      <h2 style="margin:6px 0 10px">Checkout</h2>
      <div id="payment-request-button" style="margin-top:8px"></div>
      <div id="payment-element" style="margin-top:10px"></div>
      <button id="pay" class="btn" style="margin-top:12px">Pay Now</button>
      <div id="message" class="status"></div>
      <div class="muted" style="margin-top:10px">Apple Pay / Google Pay shows when supported.</div>
    </div>
  </section>
</main>

<script src="https://js.stripe.com/v3"></script>
<script>
const fmt = (c)=>'$'+(c/100).toFixed(2);
const partsCloudEl = document.getElementById('partsCloud');
const makeEl=document.getElementById('make'), modelEl=document.getElementById('model'), yearEl=document.getElementById('year'), qEl=document.getElementById('q');
const vinEl=document.getElementById('vin'), vinMeta=document.getElementById('vinMeta');
const cart = []; let selectedRate=null; let subtotalCents=0;

async function loadMakes(){ const r=await fetch('/api/makes'); const a=await r.json();
  makeEl.innerHTML='<option value="">Select a make</option>'+a.map(x=>'<option>'+x+'</option>').join(''); }
async function loadModels(make){ modelEl.disabled=true; yearEl.disabled=true; modelEl.innerHTML='<option>Loading…</option>';
  const r=await fetch('/api/models?make='+encodeURIComponent(make)); const a=await r.json();
  modelEl.disabled=a.length===0; modelEl.innerHTML=a.length?a.map(x=>'<option>'+x+'</option>').join(''):'<option>No models</option>';
  yearEl.innerHTML='<option>Select model</option>';
}
async function loadYears(make, model){ yearEl.disabled=true; yearEl.innerHTML='<option>Loading…</option>';
  const r=await fetch('/api/years?make='+encodeURIComponent(make)+'&model='+encodeURIComponent(model)); const a=await r.json();
  yearEl.disabled=a.length===0; yearEl.innerHTML=a.length?a.map(x=>'<option>'+x+'</option>').join(''):'<option>No years</option>'; }

async function loadParts(){ const r=await fetch('/api/parts'); const a=await r.json();
  partsCloudEl.innerHTML=a.map(p=>'<button type="button" class="tag" data-p="'+p.replace(/"/g,'&quot;')+'">'+p+'</button>').join('');
  partsCloudEl.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ qEl.value=b.dataset.p; })); }

makeEl.addEventListener('change', (e)=>{ if(e.target.value) loadModels(e.target.value); });
modelEl.addEventListener('change', (e)=>{ if(makeEl.value && e.target.value) loadYears(makeEl.value, e.target.value); });

// VIN decode + VIN parts search (OEM/Aftermarket)
document.getElementById('decodeVin').addEventListener('click', async ()=>{
  const vin = vinEl.value.trim();
  if (!vin){ vinMeta.textContent="Enter a 17-character VIN."; return; }
  const r = await fetch('/api/vin/decode?vin='+encodeURIComponent(vin));
  const d = await r.json();
  if (!d.ok){ vinMeta.textContent=d.error || "VIN decode failed."; return; }
  let info = []; if (d.make) info.push(d.make); if (d.year) info.push(d.year); if (d.model) info.push(d.model);
  vinMeta.innerHTML = 'Decoded: <span class="badge">'+(info.join(" • ")||"Unknown")+'</span>';
  if (d.make){ makeEl.value = d.make; await loadModels(d.make); }
  if (d.model){ modelEl.value = d.model; await loadYears(d.make, d.model); }
  if (d.year){ yearEl.value = d.year; }
  search();
});

// OEM filter
function selectedOemFlag(){ const el=document.querySelector('input[name="oem"]:checked'); return el?el.value:""; }

async function search(){
  const params = new URLSearchParams();
  if (makeEl.value) params.set('make', makeEl.value);
  if (modelEl.value) params.set('model', modelEl.value);
  if (yearEl.value) params.set('year', yearEl.value);
  if (qEl.value) params.set('q', qEl.value);
  const oem = selectedOemFlag(); if (oem) params.set('oem', oem);
  const r=await fetch('/api/products?'+params.toString());
  const items=await r.json();
  renderResults(items);
  // AI sourcing (best effort)
  if (makeEl.value && modelEl.value && yearEl.value && qEl.value){
    const ai = await fetch('/api/market/cheapest',{ method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ make: makeEl.value, model: modelEl.value, year: yearEl.value, part: qEl.value }) });
    const out = await ai.json();
    renderAI(out.product);
  } else {
    document.getElementById('aiResult').innerHTML='';
  }
}
document.getElementById('search').addEventListener('click', search);

function renderResults(items){
  const el=document.getElementById('results');
  if(!items.length){ el.innerHTML='<div class="muted">No local inventory found for that filter.</div>'; return; }
  el.innerHTML=items.map(p=>\`
    <div class="prod">
      <img src="\${p.image_url||''}" alt="product image"/>
      <div style="font-weight:800;color:#fff">\${p.name}</div>
      <div class="row">
        <div class="muted">\${p.part_type} · \${p.oem ? 'OEM' : 'Aftermarket'}</div>
        <div class="stock">\${p.stock>0 ? 'In stock' : 'Out of stock'}</div>
      </div>
      <div class="row">
        <div></div>
        <div style="font-weight:800;color:#ffd76b">\${fmt(p.price_cents)}</div>
      </div>
      <button class="btn" data-id="\${p.id}" data-name="\${p.name}" data-price="\${p.price_cents}" \${p.stock>0?'':'disabled'}>\${p.stock>0?'Add to Cart':'Out of stock'}</button>
    </div>\`).join('');
  el.querySelectorAll('button.btn').forEach(b=>b.addEventListener('click', ()=> addToCart(b.dataset.id,b.dataset.name,parseInt(b.dataset.price,10))));
}

function renderAI(prod){
  const el=document.getElementById('aiResult');
  if(!prod){ el.innerHTML=''; return; }
  const src = prod.source_from ? \` <span class="muted">(via \${prod.source_from})</span>\` : '';
  const link = prod.source_link ? \`<a href="\${prod.source_link}" target="_blank" rel="noopener" class="muted" style="text-decoration:underline">source</a>\` : '';
  el.innerHTML = \`
    <div class="prod">
      <img src="\${prod.image_url || 'https://images.unsplash.com/photo-1517048676732-d65bc937f952?q=80&w=800&auto=format&fit=crop'}" alt="ai sourced"/>
      <div style="font-weight:800;color:#fff">\${prod.name}</div>
      <div class="row"><div class="muted">AI-sourced best price\${src} · \${link}</div><div style="font-weight:800;color:#ffd76b">\${fmt(prod.price_cents)}</div></div>
      <button class="btn" id="addAI">Add to Cart</button>
    </div>\`;
  document.getElementById('addAI').onclick=()=> addToCart(prod.id, prod.name, prod.price_cents);
}

function addToCart(id,name,price_cents){
  const found = cart.find(i=>i.id===id); if(found) found.qty+=1; else cart.push({ id,name,price_cents,qty:1 });
  renderCart();
}

function renderCart(){
  const cartEl=document.getElementById('cart'); cartEl.innerHTML='';
  if(!cart.length){ cartEl.innerHTML='<div class="muted">Your cart is empty.</div>'; }
  cart.forEach(item=>{
    const row=document.createElement('div'); row.className='cart-item';
    row.innerHTML=\`
      <div>\${item.name}</div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn" style="padding:6px 10px" data-act="minus">-</button>
        <span>\${item.qty}</span>
        <button class="btn" style="padding:6px 10px" data-act="plus">+</button>
      </div>
      <div>\${fmt(item.price_cents*item.qty)}</div>\`;
    row.querySelector('[data-act="minus"]').onclick=()=>{ item.qty=Math.max(0,item.qty-1); if(item.qty===0){ cart.splice(cart.indexOf(item),1); } renderCart(); };
    row.querySelector('[data-act="plus"]').onclick=()=>{ item.qty+=1; renderCart(); };
    cartEl.appendChild(row);
  });
  subtotalCents = cart.reduce((s,i)=>s+i.price_cents*i.qty,0);
  document.getElementById('subtotal').textContent=fmt(subtotalCents);
  updateTotals();
  selectedRate=null; document.getElementById('rates').innerHTML=''; document.getElementById('shiptotal').textContent=fmt(0);
  updateStripe(subtotalCents, 0);
}

function updateTotals(){
  const ship = selectedRate?.amount_cents || 0;
  document.getElementById('grandtotal').textContent=fmt(subtotalCents + ship);
}

// Shipping rates
document.getElementById('getRates').addEventListener('click', getRates);
async function getRates(){
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
  const payload = { address: { ...address }, cart, subtotal_cents: subtotalCents };
  const r = await fetch('/api/shipping/rates',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const { quotes } = await r.json();
  const list = document.getElementById('rates');
  if(!quotes || !quotes.length){ list.innerHTML='<div class="muted">No shipping options found.</div>'; return; }
  list.innerHTML = quotes.map((q,i)=>\`
    <label class="rate">
      <input type="radio" name="rate" value="\${i}">
      <div style="flex:1">\${q.carrier} – \${q.service} \${q.days?'<span class="muted">(~'+q.days+' days)</span>':''}</div>
      <div style="font-weight:800;color:#ffd76b">\${fmt(q.amount_cents)}</div>
    </label>\`).join('');
  list.querySelectorAll('input[name="rate"]').forEach((rb,i)=>{
    rb.addEventListener('change', ()=>{
      selectedRate = quotes[i];
      document.getElementById('shiptotal').textContent = fmt(selectedRate.amount_cents);
      updateTotals();
      updateStripe(subtotalCents, selectedRate.amount_cents);
    });
  });
}

// Stripe
let stripe, elements, paymentElement, paymentRequest, prButton, clientSecret;
const messageEl=document.getElementById('message'); const setMsg=(m)=>messageEl.textContent=m||'';

async function initStripe(){
  const { publishableKey } = await (await fetch('/config')).json();
  stripe = Stripe(publishableKey);
  await updateStripe(0,0);
}

async function createPI(subtotal, shipping_cents){
  const email = document.getElementById('email').value || undefined;
  const shippingMeta = selectedRate ? { carrier:selectedRate.carrier, service:selectedRate.service, days:selectedRate.days, amount_cents:selectedRate.amount_cents } : null;
  const payloadCart = cart.map(i=>({ id:i.id, name:i.name, qty:i.qty, price_cents:i.price_cents }));
  const res = await fetch('/create-payment-intent',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ currency:'usd', cart: payloadCart, email, shipping: shippingMeta })
  });
  const js = await res.json(); if(js.error) throw new Error(js.error); return js;
}

async function updateStripe(subtotal, shipping_cents){
  setMsg('');
  const { clientSecret: cs, amount } = await createPI(subtotal, shipping_cents);
  clientSecret = cs;
  elements = stripe.elements({ clientSecret });

  if (paymentElement) paymentElement.unmount();
  paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');

  if (!paymentRequest) {
    paymentRequest = stripe.paymentRequest({
      country:'US', currency:'usd',
      total: { label:'Ohio Auto Parts', amount: amount|| (subtotal + (shipping_cents||0)) },
      requestPayerName:true, requestPayerEmail:true
    });
    prButton = elements.create('paymentRequestButton', { paymentRequest });
    const can = await paymentRequest.canMakePayment();
    if (can) prButton.mount('#payment-request-button'); else document.getElementById('payment-request-button').style.display='none';
    paymentRequest.on('paymentmethod', async (ev)=>{
      const { error } = await stripe.confirmCardPayment(clientSecret, { payment_method: ev.paymentMethod.id }, { handleActions: true });
      if (error) { ev.complete('fail'); setMsg(error.message||'Payment failed.'); return; }
      ev.complete('success'); setMsg('Payment successful!');
    });
  } else {
    paymentRequest.update({ total: { label:'Ohio Auto Parts', amount: amount|| (subtotal + (shipping_cents||0)) } });
  }

  document.getElementById('grandtotal').textContent = fmt(amount|| (subtotal + (shipping_cents||0)));
}

document.getElementById('pay').addEventListener('click', async ()=>{
  try{
    setMsg('Processing…');
    const { error } = await stripe.confirmPayment({ elements, confirmParams:{ return_url: window.location.href }, redirect: 'if_required' });
    if (error) setMsg(error.message||'Payment failed.'); else setMsg('Payment successful!');
  }catch(e){ setMsg(e.message); }
});

(async function boot(){
  await Promise.all([loadMakes(), loadParts()]);
  document.getElementById('model').innerHTML='<option>Select a make first</option>';
  renderCart();
  document.getElementById('search').addEventListener('click', search);
  await initStripe();
})();
</script>
</body></html>
`);
});

// ========================= Start =========================
app.listen(PORT, () => console.log("Ohio Auto Parts running on port", PORT));
