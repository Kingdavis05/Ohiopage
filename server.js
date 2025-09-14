// server.js
// Ohio Auto Parts – Full single-file store: Express + Postgres (optional) + Stripe + Frontend + Shipping Rates

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// ====== ENV / CONFIG ======
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_51S7BOVPYK4WIsSHnr5RiYjGeyGQan8kTcmedbcq8N2jRR4NibBrsz6pxOBUafn72I4qsnvmps75VvYggzZp58hSy00a0k9uwqA";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_51S7BOVPYK4WIsSHnzwgDFPaYZJDHYS";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APPLE_PAY_VERIFICATION_CONTENT = process.env.APPLE_PAY_VERIFICATION_CONTENT || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme-admin";
const PORT = process.env.PORT || 3000;

const stripe = require("stripe")(STRIPE_SECRET_KEY);

// ====== DATABASE (Postgres optional, else in-memory) ======
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
      console.warn("[DB] Postgres unavailable, falling back to in-memory:", e.message);
      db = memoryDB();
    }
  } else {
    db = memoryDB();
  }
})();

function memoryDB() {
  const state = { products: [], orders: [], users: [] };
  return {
    useMemory: true,
    async migrate(){},
    async seedProducts(items){ state.products = items; },
    async listProducts(filter){
      return state.products.filter(p =>
        (!filter.make || p.make === filter.make) &&
        (!filter.model || p.model === filter.model) &&
        (!filter.q || (p.name.toLowerCase().includes(filter.q) || p.part_type.toLowerCase().includes(filter.q)))
      );
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
      part_type text not null,
      price_cents integer not null,
      stock integer not null default 0,
      image_url text,
      weight_lb real default 2.0,
      dim_l_in real default 10.0,
      dim_w_in real default 8.0,
      dim_h_in real default 4.0
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

// Seed products with weight/dims for shipping
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
  const out = [];
  for (let i=0;i<140;i++){
    const make = pick(MAKES);
    const model = pick(MODELS[make]);
    const [part, weight_lb, L, W, H] = pick(PARTS);
    const price = (Math.floor(Math.random()*220)+35)*100; // $35–$255
    out.push({
      id: crypto.randomUUID(),
      name: `${make} ${model} – ${part}`,
      make, model,
      part_type: part,
      price_cents: price,
      stock: Math.floor(Math.random()*15)+2,
      image_url: pick(imgs),
      weight_lb, dim_l_in: L, dim_w_in: W, dim_h_in: H
    });
  }
  return out;
}

async function ensureSeed() {
  const items = sampleProducts();
  if (db.useMemory) {
    await db.seedProducts(items);
  } else {
    const { rows } = await pgPool.query("select count(*)::int as c from products");
    if (rows[0].c < 40) {
      const q = `insert into products(id,name,make,model,part_type,price_cents,stock,image_url,weight_lb,dim_l_in,dim_w_in,dim_h_in)
                 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 on conflict (id) do nothing`;
      for (const p of items) {
        await pgPool.query(q,[p.id,p.name,p.make,p.model,p.part_type,p.price_cents,p.stock,p.image_url,p.weight_lb,p.dim_l_in,p.dim_w_in,p.dim_h_in]);
      }
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
  if (q){ vals.push(`%${q}%`); where.push(`(lower(name) like $${vals.length} or lower(part_type) like $${vals.length})`); }
  const sql = `select * from products ${where.length?'where '+where.join(' and '):''} order by name limit 100`;
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

// ====== APP / MIDDLEWARE ======
const app = express();

// Stripe webhook (raw body)
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

// Apple Pay domain verification (optional)
if (APPLE_PAY_VERIFICATION_CONTENT) {
  app.get("/.well-known/apple-developer-merchantid-domain-association", (_req, res) => {
    res.type("text/plain").send(APPLE_PAY_VERIFICATION_CONTENT);
  });
}

// ====== Makes / Models / Parts (dropdown data) ======
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

const PARTS = ["Alternator","Battery","Starter","Spark Plugs","Ignition Coils","ECU","MAF Sensor","MAP Sensor","O2 Sensor",
  "Oil Filter","Air Filter","Cabin Filter","Fuel Filter","Fuel Pump","Radiator","Water Pump","Thermostat","Timing Belt/Chain",
  "Serpentine Belt","Turbocharger","Supercharger","Catalytic Converter","Exhaust Muffler","Brake Pads","Brake Rotors","Calipers",
  "ABS Sensor","Master Cylinder","Suspension Strut","Shock Absorber","Control Arm","Ball Joint","Tie Rod","Wheel Bearing","Axle/CV Joint",
  "AC Compressor","Condenser","Heater Core","Power Steering Pump","Rack and Pinion","Clutch Kit","Flywheel","Transmission Filter/Fluid",
  "Headlight Assembly","Taillight","Mirror","Bumper","Fender","Hood","Grille","Door Handle","Window Regulator","Wiper Blades","Floor Mats","Roof Rack","Infotainment Screen"];

// ====== API: Basics ======
app.get("/config", (_req, res) => res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY }));
app.get("/api/makes", (_req, res) => res.json(MAKES));
app.get("/api/models", (req, res) => res.json(MODELS[req.query.make] || []));
app.get("/api/parts", (_req, res) => res.json(PARTS));

app.get("/api/products", async (req, res) => {
  const { make, model, q } = req.query;
  const list = db.useMemory ? await db.listProducts({ make, model, q: (q||"").toLowerCase() })
                            : await dbListProducts({ make, model, q: (q||"").toLowerCase() });
  res.json(list);
});

app.post("/admin/seed", async (req, res) => {
  const token = (req.headers.authorization||"").split("Bearer ")[1];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  await ensureSeed();
  res.json({ ok: true });
});

// ====== SHIPPING RATES (FedEx, UPS, DHL, Freight – heuristic) ======
app.post("/api/shipping/rates", async (req, res) => {
  try {
    const { address = {}, cart = [], subtotal_cents = 0 } = req.body || {};
    const { country = "US", state = "", city = "", postal_code = "", residential = true } = address || {};

    // Aggregate to a single shipment (simple heuristic)
    let totalWeightLb = 0, dimL=0, dimW=0, dimH=0;
    for (const item of cart) {
      const p = await dbGetProduct(item.id); if (!p) continue;
      const qty = Math.max(1, parseInt(item.qty||1,10));
      totalWeightLb += (p.weight_lb||2) * qty;
      // approximate dimensions stacking
      dimL = Math.max(dimL, p.dim_l_in||10);
      dimW = Math.max(dimW, p.dim_w_in||8);
      dimH += (p.dim_h_in||4) * qty;
    }
    if (totalWeightLb <= 0) totalWeightLb = 2;

    const billable = Math.max(totalWeightLb, (dimL*dimW*dimH)/139); // dimensional divisor 139
    const domestic = (country || "US").toUpperCase() === "US";

    // Zone factor (US: by ZIP first digit; Intl: multiplier)
    let zoneMult = 1.0;
    if (domestic) {
      const z = String(postal_code||"").trim()[0] || "5";
      const table = { "0":1.00,"1":0.95,"2":0.98,"3":1.05,"4":1.10,"5":1.15,"6":1.20,"7":1.25,"8":1.28,"9":1.32 };
      zoneMult = table[z] ?? 1.15;
    } else {
      zoneMult = 1.65; // intl base uplift
    }

    const fuel = 0.12; // 12% fuel surcharge
    const residentialFee = residential ? 4.0 : 0.0;
    const remoteFee = (!domestic && /AU|NZ|ZA|BR|AR|CL|AE|SA|IN|ID|PH|CN|JP|KR/.test(country.toUpperCase())) ? 8.0 : 0.0;
    const insurance = Math.max(1.0, Math.min(50.0, 0.01 * (subtotal_cents/100))); // ~1% of subtotal, capped

    // Base rate functions (USD)
    function baseGround(bw){ return 8 + 0.55*bw; }
    function base2Day(bw){ return 15 + 0.95*bw; }
    function baseOvernight(bw){ return 24 + 1.45*bw; }
    function baseIntlExpress(bw){ return 32 + 1.65*bw; }
    function baseFreight(bw){ return 120 + 0.9*bw; } // LTL

    const isFreight = billable > 150; // LTL threshold
    let quotes = [];

    if (!isFreight && domestic) {
      const services = [
        { carrier:"UPS", service:"Ground", days:3, base: baseGround(billable) },
        { carrier:"UPS", service:"2nd Day Air", days:2, base: base2Day(billable) },
        { carrier:"UPS", service:"Next Day Air Saver", days:1, base: baseOvernight(billable) },
        { carrier:"FedEx", service:"Ground", days:3, base: baseGround(billable) * 0.98 },
        { carrier:"FedEx", service:"2Day", days:2, base: base2Day(billable) * 0.99 },
        { carrier:"FedEx", service:"Standard Overnight", days:1, base: baseOvernight(billable) }
      ];
      quotes = services.map(s => priceOut(s.carrier, s.service, s.days, s.base));
    } else if (!isFreight && !domestic) {
      // International small parcel → DHL Express + UPS Worldwide Saver + FedEx Intl Priority (heuristics)
      const services = [
        { carrier:"DHL", service:"Express Worldwide", days:4, base: baseIntlExpress(billable) },
        { carrier:"UPS", service:"Worldwide Saver", days:5, base: baseIntlExpress(billable) * 1.05 },
        { carrier:"FedEx", service:"International Priority", days:4, base: baseIntlExpress(billable) * 1.03 }
      ];
      quotes = services.map(s => priceOut(s.carrier, s.service, s.days, s.base));
    } else {
      // Freight (LTL)
      const econ = priceOut("Freight", "LTL Economy", 5, baseFreight(billable));
      const pri = priceOut("Freight", "LTL Priority", 3, baseFreight(billable) * 1.18);
      quotes = [econ, pri];
    }

    // helper to finalize cents
    function toCents(n){ return Math.max(1, Math.round(n*100)); }
    function priceOut(carrier, service, days, base){
      let amt = base * zoneMult;
      amt += residentialFee + remoteFee + insurance;
      amt = amt * (1 + fuel);
      return {
        carrier, service, days,
        amount_cents: toCents(amt),
        breakdown: {
          billable_lb: Math.round(billable*10)/10,
          zone_multiplier: zoneMult,
          fuel_pct: fuel, residential_fee: residentialFee, remote_fee: remoteFee, insurance_fee: Math.round(insurance*100)/100
        }
      };
    }

    // Sort cheapest first
    quotes.sort((a,b)=>a.amount_cents - b.amount_cents);

    res.json({ quotes, computed: { billable_lb: Math.round(billable*10)/10, domestic, totalWeightLb, dim: [dimL,dimW,dimH] } });
  } catch (e) {
    console.error("shipping rates error:", e);
    res.status(400).json({ error: e.message });
  }
});

// ====== PAYMENTS (includes shipping) ======
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { cart = [], currency = "usd", email, shipping = null } = req.body || {};
    // Compute subtotal server-side
    let subtotal = 0;
    const compactItems = [];
    for (const item of cart) {
      const p = await dbGetProduct(item.id);
      if (!p) continue;
      const qty = Math.max(1, parseInt(item.qty||1,10));
      subtotal += p.price_cents * qty;
      compactItems.push({ id: p.id, name: p.name, qty, unit_price_cents: p.price_cents });
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

// ====== FRONTEND (UI with address + rates + cart + checkout) ======
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ohio Auto Parts</title>
<link rel="preconnect" href="https://js.stripe.com"/>
<style>
:root{--bg:#0b1220;--card:#0e1a2d;--primary:#00d1ff;--accent:#00ffa3;--text:#eef3ff;--muted:#9fb2d3;--line:rgba(255,255,255,.08)}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#081024,#0b1220 45%,#0e1b2c);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{position:sticky;top:0;z-index:20;padding:20px 16px;background:linear-gradient(180deg,rgba(8,16,36,.9),rgba(8,16,36,.45),transparent);border-bottom:1px solid var(--line);backdrop-filter:saturate(1.1) blur(8px)}
.container{max-width:1180px;margin:0 auto;padding:0 16px}.brand{display:flex;gap:12px;align-items:center}
.logo{width:42px;height:42px;border-radius:12px;background:radial-gradient(60% 60% at 30% 30%,var(--primary),transparent 60%),radial-gradient(60% 60% at 75% 70%,var(--accent),transparent 60%),linear-gradient(135deg,#0b1a2c,#0d2037);box-shadow:0 0 30px rgba(0,209,255,.25), inset 0 0 12px rgba(0,255,163,.18)}
h1{margin:0;font-size:1.6rem}.subtitle{color:var(--muted);font-size:.95rem;margin-top:3px}
main{padding:26px 0 70px}.grid{display:grid;gap:16px}@media(min-width:1080px){.grid{grid-template-columns:1.6fr 1.4fr 1.2fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 8px 28px rgba(0,0,0,.35)}
label{display:block;margin-bottom:8px;color:#cfe1ff}input,select,button{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:#0c1526;color:var(--text);outline:none}
input:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(0,209,255,.22)}
.btn{cursor:pointer;font-weight:700;letter-spacing:.2px;border:none;color:#041225;background:linear-gradient(135deg,var(--primary),var(--accent));box-shadow:0 10px 24px rgba(0,209,255,.25);transition:transform .06s}.btn:active{transform:translateY(1px)}
.muted{color:var(--muted)}.status{min-height:1.2em;font-size:.92rem;margin-top:6px}
.products{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}@media(min-width:720px){.products{grid-template-columns:1fr 1fr 1fr}}
.prod{background:#0b1526;border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px}
.prod img{width:100%;height:140px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.cart{background:rgba(0,0,0,.15);border:1px solid var(--line);border-radius:14px;padding:12px}
.cart-item{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;margin-bottom:8px}
.parts{display:flex;flex-wrap:wrap;gap:8px;max-height:140px;overflow:auto;margin-top:6px}
.tag{padding:8px 10px;border:1px solid var(--line);border-radius:999px;font-size:.85rem;background:#0b1526;color:#d6e5ff;cursor:pointer}
.totals{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:8px}
.rate{display:flex;gap:8px;align-items:center;border:1px solid var(--line);padding:8px;border-radius:10px;background:#0b1526}
</style>
</head>
<body>
<header><div class="container brand">
  <div class="logo" aria-hidden="true"></div>
  <div><h1>Ohio Auto Parts <span class="muted">– US • Germany • Europe</span></h1>
  <div class="subtitle">OEM & aftermarket parts. Fast checkout with Apple Pay & Google Pay.</div></div>
</div></header>

<main class="container">
  <section class="grid">
    <!-- Search / Products -->
    <div class="card">
      <h2 style="margin:6px 0 10px">Find Parts</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label for="make">Make</label><select id="make"><option>Loading…</option></select></div>
        <div><label for="model">Model</label><select id="model" disabled><option>Select a make first</option></select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:12px;margin-top:10px">
        <div><label for="q">Search part</label><input id="q" placeholder="Brake Pads, Alternator, Radiator…"/></div>
        <div><label>&nbsp;</label><button id="search" class="btn">Search</button></div>
      </div>
      <div id="results" class="products"></div>
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
            <option value="US" selected>US</option>
            <option value="CA">CA</option>
            <option value="GB">GB</option>
            <option value="DE">DE</option>
            <option value="FR">FR</option>
            <option value="IT">IT</option>
            <option value="ES">ES</option>
            <option value="NL">NL</option>
            <option value="SE">SE</option>
            <option value="NO">NO</option>
            <option value="DK">DK</option>
            <option value="IE">IE</option>
            <option value="AU">AU</option>
            <option value="NZ">NZ</option>
            <option value="JP">JP</option>
            <option value="KR">KR</option>
          </select>
        </div>
        <label style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <input id="residential" type="checkbox" checked style="width:auto"> Residential address
        </label>
        <button id="getRates" class="btn" style="margin-top:10px">Get Rates</button>
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
      <div class="muted" style="margin-top:10px">You’ll see Apple Pay / Google Pay if your device supports it.</div>
    </div>
  </section>
</main>

<script src="https://js.stripe.com/v3/"></script>
<script>
const fmt = (c)=>'$'+(c/100).toFixed(2);
const partsCloudEl = document.getElementById('partsCloud');
const makeEl=document.getElementById('make'), modelEl=document.getElementById('model'), qEl=document.getElementById('q');
const cart = []; let selectedRate=null; let subtotalCents=0;

// Load dropdowns and parts tags
async function loadMakes(){ const r=await fetch('/api/makes'); const a=await r.json();
  makeEl.innerHTML='<option value="">Select a make</option>'+a.map(x=>'<option>'+x+'</option>').join(''); }
async function loadModels(make){ modelEl.disabled=true; modelEl.innerHTML='<option>Loading…</option>';
  const r=await fetch('/api/models?make='+encodeURIComponent(make)); const a=await r.json();
  modelEl.disabled=a.length===0; modelEl.innerHTML=a.length?a.map(x=>'<option>'+x+'</option>').join(''):'<option>No models</option>'; }
async function loadParts(){ const r=await fetch('/api/parts'); const a=await r.json();
  partsCloudEl.innerHTML=a.map(p=>'<button type="button" class="tag" data-p="'+p.replace(/"/g,'&quot;')+'">'+p+'</button>').join('');
  partsCloudEl.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ qEl.value=b.dataset.p; })); }

makeEl.addEventListener('change', (e)=>{ if(e.target.value) loadModels(e.target.value); });

async function search(){
  const params=new URLSearchParams(); if(makeEl.value) params.set('make',makeEl.value);
  if(modelEl.value) params.set('model',modelEl.value); if(qEl.value) params.set('q',qEl.value);
  const r=await fetch('/api/products?'+params.toString()); renderResults(await r.json());
}

function renderResults(items){
  const el=document.getElementById('results');
  if(!items.length){ el.innerHTML='<div class="muted">No products found.</div>'; return; }
  el.innerHTML=items.map(p=>\`
    <div class="prod">
      <img src="\${p.image_url||''}" alt="product image"/>
      <div style="font-weight:700">\${p.name}</div>
      <div class="row"><div class="muted">\${p.part_type}</div><div style="font-weight:800">\${fmt(p.price_cents)}</div></div>
      <button class="btn" data-id="\${p.id}" data-name="\${p.name}" data-price="\${p.price_cents}">Add to Cart</button>
    </div>\`).join('');
  el.querySelectorAll('button.btn').forEach(b=>b.addEventListener('click', ()=> addToCart(b.dataset.id,b.dataset.name,parseInt(b.dataset.price,10))));
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
  // Reset shipping when cart changes
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
  const payload = { address: { country: address.country, state: address.state, city: address.city, postal_code: address.postal_code, residential: address.residential }, cart, subtotal_cents: subtotalCents };
  const r = await fetch('/api/shipping/rates',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const { quotes } = await r.json();
  const list = document.getElementById('rates');
  if(!quotes || !quotes.length){ list.innerHTML='<div class="muted">No shipping options found.</div>'; return; }
  list.innerHTML = quotes.map((q,i)=>\`
    <label class="rate">
      <input type="radio" name="rate" value="\${i}">
      <div style="flex:1">\${q.carrier} – \${q.service} <span class="muted">(~\${q.days} biz days)</span></div>
      <div style="font-weight:800">\${fmt(q.amount_cents)}</div>
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
  const res = await fetch('/create-payment-intent',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ currency:'usd', cart, email, shipping: shippingMeta })
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

  // Payment Request
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

document.getElementById('search').addEventListener('click', search);

(async function boot(){
  await Promise.all([loadMakes(), loadParts()]);
  document.getElementById('model').innerHTML='<option>Select a make first</option>';
  renderCart();
  await initStripe();
})();
</script>
</body></html>
`);
});

// ====== SERVER START ======
app.listen(PORT, () => console.log("Ohio Auto Parts running on port", PORT));
