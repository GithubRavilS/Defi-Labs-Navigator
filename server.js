/**
 * Сервер для DeFi Labs Navigator.
 * Читает данные из Google Sheets (credentials из pusher-490008-bf7c384ba372.json)
 * и отдаёт их по /api/data. Ключи никогда не уходят в браузер.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getNavigatorDataFromSheets } = require('./lib/sheet-get-data');

const PORT = process.env.PORT || 3333;

async function fetchSpreadsheetData() {
  return getNavigatorDataFromSheets();
}

function serveFile(filePath, contentType, res) {
  const full = path.join(__dirname, filePath);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0] || '/';

  if (url === '/api/data') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const data = await fetchSpreadsheetData();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e.message), categories: [], tools: [] }));
    }
    return;
  }

  if (url === '/' || url === '/index.html') {
    serveFile('defi-lab-navigator.html', 'text/html; charset=utf-8', res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`DeFi Labs Navigator: http://localhost:${PORT}`);
  console.log('API: http://localhost:' + PORT + '/api/data');
});
