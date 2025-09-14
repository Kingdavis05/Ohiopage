// server.js — ONE FILE WEB SERVICE
// Run: node server.js   (Render will use: process.env.PORT)
// Features: Front page (filters/listings/cart/checkout) + /api/products + /api/orders
// If db.json exists with { "products": [...] }, it will use that. Otherwise it returns a default catalog with images.

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;

function readProducts() {
  try {
    const p = path.join(__dirname, "db.json");
    if (fs.existsSync(p)) {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(json?.products) && json.products.length) return json.products;
    }
  } catch (e) {
    console.warn("db.json read failed:", e.message);
  }
  // Default catalog with safe, royalty-free placeholder images
  return [
    { id: "brake-pads-front", name: "Brake Pads – Front",    image: "https://picsum.photos/seed/brake-pads/800/480",  base_price: 79.99,  year: 2020, make: "Toyota",  model: "Camry" },
    { id: "alternator",       name: "Alternator",            image: "https://picsum.photos/seed/alternator/800/480",  base_price: 199.99, year: 2019, make: "Honda",   model: "Civic" },
    { id: "radiator",         name: "Radiator",              image: "https://picsum.photos/seed/radiator/800/480",    base_price: 149.99, year: 2021, make: "Ford",    model: "F-150" },
    { id: "air-filter",       name: "Engine Air Filter",     image: "https://picsum.photos/seed/air-filter/800/480",  base_price: 18.99,  year: 2018, make: "Nissan",  model: "Altima" },
    { id: "oil-filter",       name: "Oil Filter",            image: "https://picsum.photos/seed/oil-filter/800/480",  base_price: 9.49,   year: 2017, make: "Chevy",   model: "Malibu" },
    { id: "spark-plugs",      name: "Spark Plugs (4-pack)",  image: "https://picsum.photos/seed/spark-plugs/800/480", base_price: 24.99,  year: 2016, make: "Hyundai", model: "Elantra" },
    { id: "wiper-blades",     name: "Wiper Blades (pair)",   image: "https://picsum.photos/seed/wiper/800/480",       base_price: 14.99,  year: 2022, make: "Kia",     model: "Sorento" },
    { id: "brake-rotor",      name: "Brake Rotor (Front)",   image: "https://picsum.photos/seed/rotor/800/480",       base_price: 59.99,  year: 2015, make: "BMW",     model: "328i" },
    { id: "headlight",        name: "Headlight Assembly",    image: "https://picsum.photos/seed/headlight/800/480",   base_price: 129.00, year: 2014, make: "Audi",    model: "A4" },
    { id: "car-battery",      name: "12V Car Battery",       image: "https://picsum.photos/seed/battery/800/480",     base_price: 139.00, year: 2023, make: "Tesla",   model: "Model 3" },
    { id: "starter",          name: "Starter Motor",         image: "https://picsum.photos/seed/starter/800/480",     base_price: 179.00, year: 2012, make: "Jeep",    model: "Wrangler" },
    { id: "fuel-pump",        name: "Fuel Pump",             image: "https://picsum.photos/seed/fuel-pump/800/480",   base_price: 169.00, year: 2013, make: "VW",      model: "Jetta" }
  ];
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Ohio Auto Parts</title>
  <style>
    :root{--blue:#0f3d99;--accent:#0ea5e9;--bg:#f6f7fb;--card:#fff;--text:#111827}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif}
    header{background:var(--blue);color:#fff;padding:24px 16px}
    header .wrap{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
    header h1{margin:0;font-size:28px}
    header nav a{color:#fff;text-decoration:none;margin-left:16px;font-weight:600}
    .container{max-width:1100px;margin:18px auto;padding:0 16px}
    .filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .filters select,.filters input{padding:10px 12px;border:1px solid #d1d5db;border-radius:12px;background:#fff}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:16px}
    @media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:600px){.grid{grid-template-columns:1fr}.filters{grid-template-columns:1fr}}
    .card{background:var(--card);border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.06);overflow:hidden;display:flex;flex-direction:column}
    .card img{width:100%;height:160px;object-fit:cover}
    .card .p{padding:14px}
    .name{font-weight:700;margin:0 0 6px}
    .meta{font-size:12px;color:#6b7280}
    .price{color:var(--blue);font-weight:800;margin:10px 0 0}
    .btn{cursor:pointer;appearance:none;border:0;background:var(--accent);color:#fff;padding:10px 12px;border-radius:12px;font-weight:700}
    .btn.wide{width:100%}
    .page{display:none}.page.active{display:block}
    .section{background:#fff;border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.06);padding:16px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #eef2f7}
    .row:last-child{border-bottom:0}
    .qty{width:64px;padding:8px;border:1px solid #d1d5db;border-radius:10px}
    .right{display:flex;align-items:center;gap:10px}
    .totals{display:flex;align-items:center;justify-content:space-between;margin-top:10px;font-weight:800}
    .empty{color:#6b7280;text-align:center;padding:20px}
    footer{margin:40px 0 20px;text-align:center;color:#6b7280;font-size:12px}
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Ohio Auto Parts</h1>
      <nav>
        <a href="#/">Home</a>
        <a href="#/cart">Cart</a>
        <a href="#/checkout">Checkout</a>
      </nav>
    </div>
  </header>

  <main id="page-home" class="page active">
    <div class="container">
      <div class="section" style="margin-bottom:14px">
        <div class="filters">
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
        <div>Subtotal</div>
        <div id="cart-subtotal" style="color:var(--blue)">$0.00</div>
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
          <div>Total</div>
          <div id="checkout-total" style="color:var(--blue)">$0.00</div>
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
      Object.entries(attrs).forEach(([k,v])=>{
        if(k==="class") n.className=v; else if(k==="html") n.innerHTML=v; else n.setAttribute(k,v)
      });
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
        let data = await res.json();
        PRODUCTS = (Array.isArray(data)?data:data.products||[]).map(function(p){
          return {
            id: (p.id!=null?p.id:crypto.randomUUID()),
            name: (p.name!=null?p.name:(p.title!=null?p.title:"Auto Part")),
            image: (p.image || "https://picsum.photos/seed/"+Math.floor(Math.random()*1000)+"/600/360"),
            base: Number((p.base_price!=null?p.base_price:p.price)||0),
            year: (p.year!=null?p.year:""),
            make: (p.make!=null?p.make:""),
            model: (p.model!=null?p.model:"")
          };
        }).map(function(p){ p.price = (p.base||0)+FLAT_MARKUP; return p; });
      }catch(err){
        console.warn("Falling back to sample data:", err.message);
        PRODUCTS = [
          {id:1,name:"Brake Pads – Front",image:"https://picsum.photos/seed/brake/600/360",year:2020,make:"Toyota",model:"Camry",price:129.99},
          {id:2,name:"Alternator",image:"https://picsum.photos/seed/alt/600/360",year:2019,make:"Honda",model:"Civic",price:249.99},
          {id:3,name:"Radiator",image:"https://picsum.photos/seed/rad/600/360",year:2021,make:"Ford",model:"F-150",price:199.99}
        ];
      }
      buildFilters(); renderCards();
    }

    const fYear = $('#filter-year'), fMake = $('#filter-make'), fModel = $('#filter-model'), fSearch = $('#filter-search');
    function buildFilters(){
      const years=[...new Set(PRODUCTS.map(p=>p.year).filter(Boolean))];
      const makes=[...new Set(PRODUCTS.map(p=>p.make).filter(Boolean))];
      const models=[...new Set(PRODUCTS.map(p=>p.model).filter(Boolean))];
      function fill(sel, arr){
        sel.innerHTML = '<option value="">' + sel.options[0].text + '</option>' + arr.map(function(v){
          return '<option value="' + String(v) + '">' + String(v) + '</option>';
        }).join('');
      }
      fill(fYear, years); fill(fMake, makes); fill(fModel, models);
    }
    [fYear,fMake,fModel,fSearch].forEach(function(el){ if(el) el.addEventListener('input', renderCards); });

    function filterProducts(){
      const y=fYear.value, m=fMake.value, mo=fModel.value, s=(fSearch.value||'').toLowerCase();
      return PRODUCTS.filter(function(p){
        return (!y || String(p.year)===y) && (!m || p.make===m) && (!mo || p.model===mo) && (!s || p.name.toLowerCase().includes(s));
      });
    }

    function renderCards(){
      const list = filterProducts();
      const wrap = document.getElementById('cards');
      wrap.innerHTML = '';
      if(!list.length){ wrap.appendChild($el('div',{class:'empty',html:'No parts found. Adjust your filters.'})); return }
      list.forEach(function(p){
        const card = $el('div',{class:'card'},[
          $el('img',{src:p.image,alt:p.name}),
          $el('div',{class:'p'},[
            $el('h3',{class:'name',html:p.name}),
            $el('div',{class:'meta',html:( (p.year||'') + ' ' + (p.make||'') + ' ' + (p.model||'') )}),
            $el('div',{class:'price',html:('$' + Number(p.price||0).toFixed(2))}),
            $el('button',{class:'btn wide',html:'Add to Cart'})
          ])
        ]);
        card.querySelector('button').onclick=function(){ cart.add({id:p.id,name:p.name,price:Number(p.price||0)}); };
        wrap.appendChild(card);
      });
    }

    function renderCart(){
      const box = document.getElementById('cart-list');
      const items = cart.get();
      box.innerHTML = '';
      if(!items.length){ box.appendChild($el('div',{class:'empty',html:'Your cart is empty.'})); updateTotals(); return }
      items.forEach(function(it){
        const row = $el('div',{class:'row'},[
          $el('div',{},[$el('div',{class:'name',html:it.name}), $el('div',{class:'meta',html:('$'+it.price.toFixed(2)+' each')})]),
          $el('div',{class:'right'},[
            $el('input',{class:'qty',type:'number',min:'1',value:String(it.qty)}),
            $el('button',{class:'btn',html:'Remove'})
          ])
        ]);
        row.querySelector('.qty').oninput=function(e){ cart.update(it.id, parseInt(e.target.value||'1',10)); updateTotals(); };
        row.querySelector('button').onclick=function(){ cart.remove(it.id); renderCart(); };
        box.appendChild(row);
      });
      updateTotals();
    }

    function updateTotals(){
      const sub = cart.subtotal();
      const $sub = document.getElementById('cart-subtotal'); if($sub) $sub.textContent = '$' + sub.toFixed(2);
      const $tot = document.getElementById('checkout-total'); if($tot) $tot.textContent = '$' + sub.toFixed(2);
    }

    const payBtn = document.getElementById('pay-btn');
    if(payBtn){ payBtn.addEventListener('click', function(){
      alert('✅ Order placed (demo). Wire to Stripe/PayPal on your server if needed.');
      localStorage.removeItem(cart.key);
      window.location.hash = '#/'; renderRoute();
    }); }

    function renderRoute(){
      const hash = (location.hash||'#/').toLowerCase();
      ['home','cart','checkout'].forEach(function(p){ document.getElementById('page-'+p).classList.remove('active'); });
      if(hash.indexOf('#/cart')===0){ document.getElementById('page-cart').classList.add('active'); renderCart(); }
      else if(hash.indexOf('#/checkout')===0){ document.getElementById('page-checkout').classList.add('active'); updateTotals(); }
      else { document.getElementById('page-home').classList.add('active'); }
    }
    window.addEventListener('hashchange', renderRoute);
    document.getElementById('yr').textContent = new Date().getFullYear();
    loadProducts().then(function(){ renderRoute(); });
  </script>
</body>
</html>`;

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  // API: products
  if (pathname === "/api/products" && req.method === "GET") {
    const products = readProducts();
    return send(res, 200, "application/json; charset=utf-8", JSON.stringify(products));
  }

  // API: orders (demo)
  if (pathname === "/api/orders" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try { JSON.parse(body || "{}"); } catch {}
      return send(res, 201, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
    });
    return;
  }

  // Health check
  if (pathname === "/health") {
    return send(res, 200, "text/plain; charset=utf-8", "ok");
  }

  // Everything else → serve the storefront HTML
  return send(res, 200, "text/html; charset=utf-8", HTML);
});

server.listen(PORT, () => {
  console.log(`✅ Ohio Auto Parts server running on ${PORT}`);
});
