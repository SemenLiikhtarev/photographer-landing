/* ============================================================
   Локальный сервер для проверки сайта и админки.
   Нужен только для разработки: на хостинге это не используется.

   Запуск:  node server.js
   Адрес:   http://localhost:8000/admin.html
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const root = __dirname;
const startPort = Number(process.env.PORT) || 8000;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createServer() {
  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(req.url.split('?')[0]);
    } catch (err) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(root, relative);

    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Не найдено: ' + pathname);
        return;
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
}

function listen(port, attempt = 0) {
  const server = createServer();

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error('Не удалось запустить сервер:', err.message);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port + '/admin.html';
    console.log('');
    console.log('  Сайт:    http://localhost:' + port + '/');
    console.log('  Админка: ' + url);
    console.log('');
    console.log('  Остановить сервер: Ctrl + C');
    console.log('');

    if (process.platform === 'win32' && process.env.OPEN_BROWSER !== '0') {
      exec('start "" "' + url + '"');
    }
  });
}

listen(startPort);
