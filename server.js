const http = require('http');
const fs = require('fs');
const path = require('path');

// Ma'lumotlar saqlanadigan JSON fayl
const DB_FILE = path.join(__dirname, 'db.json');

// Agar db.json fayli yo'q bo'lsa, uni boshlang'ich qiymatlar bilan yaratamiz
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    objects: {},
    entries: {},
    payments: {},
    workers: {}
  }, null, 2));
}

// Barcha ma'lumotlarni xotirada saqlab turamiz (tez ishlashi uchun)
let dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

// Xotiradagi ma'lumotni db.json faylga yozish funksiyasi
function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
}

const server = http.createServer((req, res) => {
  // CORS sozlamalari (boshqa joydan ulanishga ruxsat berish)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONS so'rovlariga javob (pre-flight)
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Asosiy HTML faylni ko'rsatish
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const htmlPath = path.join(__dirname, 'PROVIK obyektlar hisobi.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  // API Yo'nalishlari (Endpoints)
  if (req.url.startsWith('/api/')) {
    const parts = req.url.split('/').filter(Boolean); // Masalan: ['api', 'objects', 'id']
    const collection = parts[1]; // objects, entries, payments yoki workers
    const id = parts[2];

    // Barcha ma'lumotlarni olish (Read)
    if (req.method === 'GET' && collection && !id) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(dbData[collection] || {}));
    }

    // Kelayotgan ma'lumotni o'qib olish
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        // Yangi qo'shish (Create)
        if (req.method === 'POST' && collection && !id) {
          const obj = JSON.parse(body);
          // Tasodifiy ID yaratish (masalan: lqz8x3a)
          const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          
          if (!dbData[collection]) dbData[collection] = {};
          
          // createdAt qo'shib ketamiz
          obj.createdAt = obj.createdAt || Date.now();
          dbData[collection][newId] = obj;
          
          saveDb();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: newId }));
        }

        // Yangilash (Update)
        if (req.method === 'PUT' && collection && id) {
          const patch = JSON.parse(body);
          if (!dbData[collection]) dbData[collection] = {};
          
          dbData[collection][id] = Object.assign(dbData[collection][id] || {}, patch);
          saveDb();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true }));
        }

        // O'chirish (Delete)
        if (req.method === 'DELETE' && collection && id) {
          if (dbData[collection] && dbData[collection][id]) {
            delete dbData[collection][id];
            saveDb();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true }));
        }

        // Topilmasa
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      } catch (e) {
        // Xatolik bo'lsa
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.toString() }));
      }
    });
    return;
  }

  // Boshqa yo'llar topilmasa
  res.writeHead(404);
  res.end('Not found');
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`Server ishga tushdi!`);
  console.log(`Dasturni ochish uchun quyidagi ssilkaga kiring:`);
  console.log(`-> http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
