// server.cjs — Ohio Auto Parts (CommonJS, works with Node 18/20/22)
// Copy to repo root, deploy on Render.

const http = require("http");
const PORT = process.env.PORT || 3000;

// --- Full catalog (20+ parts, body + mechanical) ---
function defaultCatalog() {
  return [
    // Body parts
    { id: "front-bumper",  name: "Front Bumper Cover",     image: "https://picsum.photos/seed/front-bumper/800/480",  base_price: 189.0, year: 2020, make: "Toyota", model: "Camry",   category: "body" },
    { id: "rear-bumper",   name: "Rear Bumper Cover",      image: "https://picsum.photos/seed/rear-bumper/800/480",   base_price: 199.0, year: 2020, make: "Toyota", model: "Camry",   category: "body" },
    { id: "left-fender",   name: "Fender (Driver Side)",   image: "https://picsum.photos/seed/left-fender/800/480",   base_price: 129.0, year: 2019, make: "Honda",  model: "Civic",   category: "body" },
    { id: "right-fender",  name: "Fender (Passenger)",     image: "https://picsum.photos/seed/right-fender/800/480",  base_price: 129.0, year: 2019, make: "Honda",  model: "Civic",   category: "body" },
    { id: "hood-panel",    name: "Hood Panel",             image: "https://picsum.photos/seed/hood-panel/800/480",    base_price: 249.0, year: 2021, make: "Ford",   model: "F-150",   category: "body" },
    { id: "trunk-lid",     name: "Trunk Lid",              image: "https://picsum.photos/seed/trunk-lid/800/480",     base_price: 279.0, year: 2018, make: "Nissan", model: "Altima",  category: "body" },
    { id: "grille",        name: "Grille Assembly",        image: "https://picsum.photos/seed/grille/800/480",        base_price: 159.0, year: 2018, make: "Nissan", model: "Altima",  category: "body" },
    { id: "side-mirror",   name: "Side Mirror (RH)",       image: "https://picsum.photos/seed/side-mirror/800/480",   base_price: 89.0,  year: 2017, make: "Chevy",  model: "Malibu",  category: "body" },
    { id: "door-shell",    name: "Front Door Shell",       image: "https://picsum.photos/seed/door-shell/800/480",    base_price: 299.0, year: 2018, make: "Nissan", model: "Altima",  category: "body" },
    { id: "quarter-panel", name: "Quarter Panel (LH)",     image: "https://picsum.photos/seed/quarter-panel/800/480", base_price: 349.0, year: 2015, make: "BMW",    model: "328i",    category: "body" },
    { id: "taillight",     name: "Tail Light Assembly",    image: "https://picsum.photos/seed/taillight/800/480",     base_price: 119.0, year: 2015, make: "BMW",    model: "328i",    category: "body" },
    { id: "headlight",     name: "Headlight Assembly",     image: "https://picsum.photos/seed/headlight/800/480",     base_price: 129.0, year: 2014, make: "Audi",   model: "A4",      category: "body" },
    { id: "spoiler",       name: "Rear Spoiler",           image: "https://picsum.photos/seed/spoiler/800/480",       base_price: 169.0, year: 2020, make: "Toyota", model: "Camry",   category: "body" },
    { id: "fog-light",     name: "Fog Light Bezel",        image: "https://picsum.photos/seed/fog-light/800/480",     base_price: 49.0,  year: 2019, make: "Honda",  model: "Civic",   category: "body" },
    { id: "splash-shield", name: "Engine Splash Shield",   image: "https://picsum.photos/seed/splash-shield/800/480", base_price: 64.0,  year: 2020, make: "Toyota", model: "Camry",   category: "body" },
    { id: "wheel-liner",   name: "Wheel Arch Liner",       image: "https://picsum.photos/seed/wheel-liner/800/480",   base_price: 54.0,  year: 2019, make: "Honda",  model: "Civic",   category: "body" },

    // Mechanical parts
    { id: "alternator",    name: "Alternator",             image: "https://picsum.photos/seed/alternator/800/480",    base_price: 199.99, year: 2019, make: "Honda", model: "Civic",   category: "mechanical" },
    { id: "radiator",      name: "Radiator",               image: "https://picsum.photos/seed/radiator/800/480",      base_price: 149.99, year: 2021, make: "Ford",  model: "F-150",   category: "mechanical" },
    { id: "battery",       name: "12V Car Battery",        image: "https://picsum.photos/seed/battery/800/480",      base_price: 139.0,  year: 2023, make: "Tesla", model: "Model 3", category: "mechanical" },
    { id: "brake-pads",    name: "Brake Pads (Front)",     image: "https://picsum.photos/seed/brake-pads/800/480",    base_price: 79.0,   year: 2020, make: "Toyota", model: "Camry",   category: "mechanical" },
    { id: "spark-plugs",   name: "Spark Plugs (4-pack)",   image: "https://picsum.photos/seed/spark-plugs/800/480",   base_price: 24.99,  year: 2016, make: "Hyundai", model: "Elantra", category: "mechanical" },
    { id: "starter",       name: "Starter Motor",          image: "https://picsum.photos/seed/starter/800/480",      base_price: 179.0,  year: 2012, make: "Jeep",  model: "Wrangler", category: "mechanical" },
    { id: "fuel-pump",     name: "Fuel Pump",              image: "https://picsum.photos/seed/fuel-pump/800/480",    base_price: 169.0,  year: 2013, make: "VW",    model: "Jetta",    category: "mechanical" }
  ];
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
  <main><div id="cards" class="grid"></div></main>
<script>
const FLAT_MARKUP = 50;
async function load(){
  const res = await fetch('/api/products');
  const products = await res.json();
  const wrap = document.getElementById('cards');
  wrap.innerHTML = '';
  products.forEach(p=>{
    const price = (Number(p.base_price||0) + FLAT_MARKUP).toFixed(2);
    const div = document.createElement('div');
    div.className='card';
    div.innerHTML = '<img src="'+p.image+'" alt="'+p.name+'"/>' +
      '<div class="p"><div class="name">'+p.name+'</div>' +
      '<div>'+(p.year||"")+' '+(p.make||"")+' '+(p.model||"")+'</div>' +
      '<div class="price">$'+price+'</div></div>';
    wrap.appendChild(div);
  });
}
load();
</script>
</body>
</html>`;

// --- Server routes ---
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/products")) {
    const list = defaultCatalog();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(list));
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  // default: storefront
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log("✅ Ohio Auto Parts running on port " + PORT);
});
