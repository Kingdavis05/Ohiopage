// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// --- Simple Products API with images ---
// If db.json exists and has products, we'll use it.
// Otherwise we return a nice default catalog WITH images.
app.get("/api/products", (req, res) => {
  try {
    const dbPath = path.join(__dirname, "db.json");
    if (fs.existsSync(dbPath)) {
      const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      if (Array.isArray(db?.products) && db.products.length) {
        return res.json(db.products);
      }
    }
  } catch (e) {
    console.warn("db.json read failed:", e.message);
  }

  // Default catalog (swap image URLs later if you want)
  return res.json([
    { id: "brake-pads-front", name: "Brake Pads – Front",    image: "https://picsum.photos/seed/brake-pads/800/480",  base_price: 79.99,  year: 2020, make: "Toyota", model: "Camry" },
    { id: "alternator",       name: "Alternator",            image: "https://picsum.photos/seed/alternator/800/480",  base_price: 199.99, year: 2019, make: "Honda",  model: "Civic" },
    { id: "radiator",         name: "Radiator",              image: "https://picsum.photos/seed/radiator/800/480",    base_price: 149.99, year: 2021, make: "Ford",   model: "F-150" },
    { id: "air-filter",       name: "Engine Air Filter",     image: "https://picsum.photos/seed/air-filter/800/480",  base_price: 18.99,  year: 2018, make: "Nissan", model: "Altima" },
    { id: "oil-filter",       name: "Oil Filter",            image: "https://picsum.photos/seed/oil-filter/800/480",  base_price: 9.49,   year: 2017, make: "Chevy",  model: "Malibu" },
    { id: "spark-plugs",      name: "Spark Plugs (4-pack)",  image: "https://picsum.photos/seed/spark-plugs/800/480", base_price: 24.99,  year: 2016, make: "Hyundai",model: "Elantra" },
    { id: "wiper-blades",     name: "Wiper Blades (pair)",   image: "https://picsum.photos/seed/wiper/800/480",       base_price: 14.99,  year: 2022, make: "Kia",    model: "Sorento" },
    { id: "brake-rotor",      name: "Brake Rotor (Front)",   image: "https://picsum.photos/seed/rotor/800/480",       base_price: 59.99,  year: 2015, make: "BMW",    model: "328i" },
    { id: "headlight",        name: "Headlight Assembly",    image: "https://picsum.photos/seed/headlight/800/480",   base_price: 129.00, year: 2014, make: "Audi",   model: "A4" },
    { id: "car-battery",      name: "12V Car Battery",       image: "https://picsum.photos/seed/battery/800/480",     base_price: 139.00, year: 2023, make: "Tesla",  model: "Model 3" },
    { id: "starter",          name: "Starter Motor",         image: "https://picsum.photos/seed/starter/800/480",     base_price: 179.00, year: 2012, make: "Jeep",   model: "Wrangler" },
    { id: "fuel-pump",        name: "Fuel Pump",             image: "https://picsum.photos/seed/fuel-pump/800/480",   base_price: 169.00, year: 2013, make: "VW",     model: "Jetta" }
  ]);
});

// (Optional) Demo orders endpoint
app.post("/api/orders", (req, res) => {
  // In production, validate + store order, then charge via Stripe/PayPal.
  res.status(201).json({ ok: true });
});

// Always send index.html (so #/cart and #/checkout work)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
