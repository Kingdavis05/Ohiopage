const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const DB_FILE = path.join(__dirname, 'db.json');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/products', (req, res) => {
  const db = readDB();
  res.json(db.products);
});

app.post('/api/orders', (req, res) => {
  const db = readDB();
  const order = {
    id: Date.now().toString(),
    items: req.body.items || [],
    customer: req.body.customer || {},
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);
  writeDB(db);
  // Trigger simple automation processor (append to queue file)
  const queueFile = path.join(__dirname, 'automation_queue.json');
  let queue = [];
  if (fs.existsSync(queueFile)) queue = JSON.parse(fs.readFileSync(queueFile));
  queue.push(order);
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
  res.json({ success: true, orderId: order.id });
});

// Admin listing of orders (simple password)
app.get('/admin/orders', (req, res) => {
  const pwd = req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: 'forbidden' });
  const db = readDB();
  res.json(db.orders);
});

// Simple endpoint to trigger processing (render cron or manual)
app.post('/admin/process', (req, res) => {
  const pwd = req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(403).json({ error: 'forbidden' });
  // move queue to processing and call orderProcessor
  const queueFile = path.join(__dirname, 'automation_queue.json');
  if (!fs.existsSync(queueFile)) return res.json({ processed: 0 });
  const queue = JSON.parse(fs.readFileSync(queueFile));
  // append to automation log and clear queue
  const logFile = path.join(__dirname, 'automation.log');
  fs.appendFileSync(logFile, JSON.stringify(queue, null, 2) + "\n");
  fs.unlinkSync(queueFile);
  res.json({ processed: queue.length });
});

// Fallback — serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
