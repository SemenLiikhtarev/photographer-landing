'use strict';

/* ============================================================
   Приём заявок с сайта → Excel на Яндекс Диске.

   Среда выполнения: Node.js 18/20, Yandex Cloud Functions.
   Внешних зависимостей нет: XLSX собирается встроенными
   средствами (zlib) и дописывается в существующий файл.

   Переменные окружения:
     YANDEX_DISK_TOKEN   — OAuth-токен с доступом к Яндекс Диску (обязательно)
     YANDEX_DISK_FOLDER  — путь к папке, например disk:/Заявки (по умолчанию)
     YANDEX_DISK_FILE    — имя файла, по умолчанию Заявки.xlsx
     ALLOWED_ORIGINS     — через запятую, например https://user.github.io
                           по умолчанию * (разрешить всем)

   Точка входа: index.handler
   ============================================================ */

const zlib = require('zlib');

const DISK_API = (process.env.YANDEX_DISK_API_BASE || 'https://cloud-api.yandex.net/v1/disk')
  .replace(/\/+$/, '');
const TOKEN = String(process.env.YANDEX_DISK_TOKEN || '').trim();
const FILE = (String(process.env.YANDEX_DISK_FILE || 'Заявки.xlsx').trim().replace(/[\\/]/g, '-') || 'Заявки.xlsx');
const FOLDER = normalizeFolder(process.env.YANDEX_DISK_FOLDER || 'disk:/Заявки');
const FILE_PATH = FOLDER + '/' + FILE;
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
if (!ALLOWED_ORIGINS.length) ALLOWED_ORIGINS.push('*');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BODY_BYTES = 24 * 1024;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const TYPE_LABELS = {
  wedding: 'Свадьба',
  'love-story': 'Love-story',
  family: 'Семейная',
  kids: 'Детская',
  other: 'Другое',
};

const rateHits = new Map();

class PublicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PublicError';
    this.status = status || 400;
  }
}

function normalizeFolder(value) {
  let folder = String(value || '').trim();
  if (!folder) folder = 'disk:/Заявки';
  if (!/^disk:/i.test(folder)) folder = 'disk:/' + folder.replace(/^\/+/, '');
  return folder.replace(/\/+$/, '');
}

function normalizeHeaders(headers) {
  const result = {};
  Object.keys(headers || {}).forEach((key) => {
    result[String(key).toLowerCase()] = headers[key];
  });
  return result;
}

function pickOrigin(origin) {
  if (!origin) return ALLOWED_ORIGINS[0] === '*' ? '*' : ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes('*')) return origin === 'null' ? '*' : origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': pickOrigin(origin),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function jsonResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      corsHeaders(origin)
    ),
    body: JSON.stringify(body),
  };
}

function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

function clientIp(event, headers) {
  const fromContext = event.requestContext
    && event.requestContext.identity
    && event.requestContext.identity.sourceIp;
  if (fromContext) return String(fromContext);
  const forwarded = headers['x-forwarded-for'];
  return forwarded ? String(forwarded).split(',')[0].trim() : 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const recent = (rateHits.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);

  if (recent.length >= RATE_LIMIT) {
    rateHits.set(ip, recent);
    return false;
  }

  recent.push(now);
  rateHits.set(ip, recent);

  if (rateHits.size > 2000) {
    rateHits.forEach((times, key) => {
      if (!times.some((time) => now - time < RATE_WINDOW_MS)) rateHits.delete(key);
    });
  }

  return true;
}

function parseBody(event) {
  let raw = event.body;
  if (raw == null || raw === '') throw new PublicError('Пустой запрос.', 400);
  if (typeof raw !== 'string') return raw;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');

  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new PublicError('Слишком большой запрос.', 413);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch (err) {
    throw new PublicError('Неверный формат данных.', 400);
  }
}

function clean(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validate(body) {
  const name = clean(body.name, 80);
  if (name.length < 2) throw new PublicError('Укажите имя.', 400);

  const phone = clean(body.phone, 30);
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new PublicError('Укажите корректный телефон.', 400);
  }

  const email = clean(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new PublicError('Укажите корректный email.', 400);
  }

  const date = clean(body.date, 10);
  if (date && !validDate(date)) throw new PublicError('Некорректная дата съёмки.', 400);

  const type = clean(body.type, 30);
  const typeLabel = TYPE_LABELS[type] || clean(body.typeLabel, 50) || 'Не указан';
  const message = clean(body.message, 2000);
  const page = clean(body.page, 300);

  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on';
  if (!consent) throw new PublicError('Нужно согласие на обработку персональных данных.', 400);

  return { name, phone, email, date, typeLabel, message, page };
}

function moscowNow() {
  const date = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    pad(date.getUTCDate()) + '.' + pad(date.getUTCMonth() + 1) + '.' + date.getUTCFullYear() +
    ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes())
  );
}

function displayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? match[3] + '.' + match[2] + '.' + match[1] : value || '';
}

/* ---------- Яндекс Диск ---------- */

async function diskRequest(path, options) {
  const request = options || {};
  const response = await fetch(DISK_API + path, {
    method: request.method || 'GET',
    headers: Object.assign(
      { Authorization: 'OAuth ' + TOKEN, Accept: 'application/json' },
      request.headers || {}
    ),
    body: request.body,
    signal: AbortSignal.timeout(15000),
  });
  return response;
}

async function diskError(response, fallback) {
  let detail = '';
  try {
    const data = await response.json();
    detail = clean(data.message || data.description || '', 200);
  } catch (err) {
    /* тело может быть пустым */
  }

  if (response.status === 401) {
    return new PublicError('Токен Яндекс Диска недействителен или истёк.', 500);
  }
  if (response.status === 403) {
    return new PublicError('У токена нет прав на запись в эту папку.', 500);
  }
  if (response.status === 404) {
    return new PublicError('Папка не найдена на Яндекс Диске. Проверьте YANDEX_DISK_FOLDER.', 500);
  }
  if (response.status === 507) {
    return new PublicError('На Яндекс Диске закончилось свободное место.', 500);
  }
  return new PublicError(fallback + (detail ? ': ' + detail : ''), 500);
}

async function ensureFolder() {
  const response = await diskRequest('/resources?path=' + encodeURIComponent(FOLDER) + '&fields=type');
  if (response.ok) return;
  if (response.status !== 404) throw await diskError(response, 'Не удалось проверить папку');

  const create = await diskRequest('/resources?path=' + encodeURIComponent(FOLDER), { method: 'PUT' });
  if (!create.ok && create.status !== 409) {
    throw await diskError(create, 'Не удалось создать папку');
  }
}

async function downloadWorkbook() {
  const meta = await diskRequest('/resources/download?path=' + encodeURIComponent(FILE_PATH));
  if (meta.status === 404) return null;
  if (!meta.ok) throw await diskError(meta, 'Не удалось получить файл');

  const data = await meta.json();
  if (!data.href) throw new PublicError('Яндекс Диск не вернул ссылку на скачивание.', 500);

  const file = await fetch(data.href, { signal: AbortSignal.timeout(20000) });
  if (!file.ok) throw new PublicError('Не удалось скачать файл с Яндекс Диска.', 500);
  return Buffer.from(await file.arrayBuffer());
}

async function uploadWorkbook(buffer) {
  const meta = await diskRequest(
    '/resources/upload?path=' + encodeURIComponent(FILE_PATH) + '&overwrite=true'
  );
  if (!meta.ok) throw await diskError(meta, 'Не удалось получить ссылку на загрузку');

  const data = await meta.json();
  if (!data.href) throw new PublicError('Яндекс Диск не вернул ссылку на загрузку.', 500);

  const upload = await fetch(data.href, {
    method: data.method || 'PUT',
    headers: { 'Content-Type': XLSX_MIME },
    body: buffer,
    signal: AbortSignal.timeout(30000),
  });

  if (!upload.ok) throw await diskError(upload, 'Не удалось загрузить файл на Яндекс Диск');
}

async function backupBrokenFile() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const backupName = FILE.replace(/\.xlsx$/i, '') + '-backup-' + stamp + '.xlsx';
  const response = await diskRequest(
    '/resources/move?from=' + encodeURIComponent(FILE_PATH) +
    '&path=' + encodeURIComponent(FOLDER + '/' + backupName) +
    '&overwrite=false',
    { method: 'POST' }
  );
  if (!response.ok && response.status !== 404) {
    console.error('Не удалось сохранить резервную копию:', await response.text());
  }
}

/* ---------- XLSX: запись ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31),
    date: (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31),
  };
}

function zip(files) {
  const now = new Date();
  const stamp = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;

  files.forEach((data, name) => {
    const nameBuffer = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
    centralSize += central.length + nameBuffer.length;
  });

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat(localParts.concat(centralParts, [end]));
}

function unzip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');

  const total = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  let pointer = centralOffset;

  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('Central directory is broken');

    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const packed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) data = zlib.inflateRawSync(packed);
    else throw new Error('Unsupported ZIP method: ' + method);

    files.set(name, data);
    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

/* ---------- XLSX: генерация и дописывание ---------- */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cellXml(ref, value, styleIndex) {
  if (value === '' || value == null) return '';
  const style = styleIndex == null ? '' : ' s="' + styleIndex + '"';

  if (typeof value === 'number' && Number.isFinite(value)) {
    return '<c r="' + ref + '"' + style + '><v>' + value + '</v></c>';
  }

  return (
    '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' +
    escapeXml(value) +
    '</t></is></c>'
  );
}

function rowXml(rowNumber, values, styleIndex) {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const cells = values
    .map((value, index) => cellXml(letters[index] + rowNumber, value, styleIndex))
    .join('');
  return '<row r="' + rowNumber + '">' + cells + '</row>';
}

function workbookFiles() {
  const headers = [
    '№',
    'Получена',
    'Имя',
    'Телефон',
    'Email',
    'Дата съёмки',
    'Тип съёмки',
    'Сообщение',
    'Страница',
  ];

  const headerCells = headers
    .map((value, index) => cellXml(String.fromCharCode(65 + index) + '1', value, 1))
    .join('');

  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    '<dimension ref="A1:I1"/>' +
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols>' +
      '<col min="1" max="1" width="6" customWidth="1"/>' +
      '<col min="2" max="2" width="18" customWidth="1"/>' +
      '<col min="3" max="3" width="22" customWidth="1"/>' +
      '<col min="4" max="4" width="18" customWidth="1"/>' +
      '<col min="5" max="5" width="24" customWidth="1"/>' +
      '<col min="6" max="6" width="14" customWidth="1"/>' +
      '<col min="7" max="7" width="16" customWidth="1"/>' +
      '<col min="8" max="8" width="50" customWidth="1"/>' +
      '<col min="9" max="9" width="30" customWidth="1"/>' +
    '</cols>' +
    '<sheetData><row r="1" ht="30" customHeight="1">' + headerCells + '</row></sheetData>' +
    '<autoFilter ref="A1:I1"/>' +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    '</worksheet>';

  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFC08573"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
        '<left style="thin"><color rgb="FFE6DED6"/></left>' +
        '<right style="thin"><color rgb="FFE6DED6"/></right>' +
        '<top style="thin"><color rgb="FFE6DED6"/></top>' +
        '<bottom style="thin"><color rgb="FFE6DED6"/></bottom>' +
        '<diagonal/>' +
      '</border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" wrapText="1"/>' +
      '</xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="top" wrapText="1"/>' +
      '</xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  const files = new Map();
  files.set('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>',
    'utf8'
  ));
  files.set('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>',
    'utf8'
  ));
  files.set('xl/workbook.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>' +
      '<sheets><sheet name="Заявки" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>',
    'utf8'
  ));
  files.set('xl/_rels/workbook.xml.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>',
    'utf8'
  ));
  files.set('xl/styles.xml', Buffer.from(stylesXml, 'utf8'));
  files.set('xl/worksheets/sheet1.xml', Buffer.from(sheetXml, 'utf8'));

  return files;
}

function findFirstSheetPath(files) {
  try {
    const workbook = files.get('xl/workbook.xml');
    const rels = files.get('xl/_rels/workbook.xml.rels');
    if (workbook && rels) {
      const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook.toString('utf8'));
      if (sheet) {
        const rel = new RegExp(
          '<Relationship\\b[^>]*\\bId="' + sheet[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '"[^>]*\\bTarget="([^"]+)"'
        ).exec(rels.toString('utf8'));
        if (rel) {
          let target = rel[1].replace(/^\/+/, '');
          if (!target.startsWith('xl/')) target = 'xl/' + target;
          if (files.has(target)) return target;
        }
      }
    }
  } catch (err) {
    /* используем стандартный путь */
  }

  return Array.from(files.keys()).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)) || null;
}

function hasBodyStyle(files) {
  const styles = files.get('xl/styles.xml');
  if (!styles) return false;
  const match = /<cellXfs\b[^>]*\bcount="(\d+)"/.exec(styles.toString('utf8'));
  return Boolean(match && Number(match[1]) > 2);
}

function appendToSheet(sheetText, rowNumber, values, styleIndex) {
  let xml = sheetText;
  const row = rowXml(rowNumber, values, styleIndex);

  if (/<sheetData\s*\/>/.test(xml)) {
    xml = xml.replace(/<sheetData\s*\/>/, '<sheetData>' + row + '</sheetData>');
  } else if (xml.includes('</sheetData>')) {
    xml = xml.replace(/<\/sheetData>/, row + '</sheetData>');
  } else {
    throw new Error('sheetData not found');
  }

  xml = xml.replace(/<dimension\b[^>]*\bref="[^"]*"/, '<dimension ref="A1:I' + rowNumber + '"');
  xml = xml.replace(/<autoFilter\b[^>]*\bref="[^"]*"/, '<autoFilter ref="A1:I' + rowNumber + '"');

  return xml;
}

function payloadValues(rowNumber, payload) {
  return [
    rowNumber,
    moscowNow(),
    payload.name,
    payload.phone,
    payload.email,
    displayDate(payload.date),
    payload.typeLabel,
    payload.message,
    payload.page,
  ];
}

async function appendRequest(payload) {
  await ensureFolder();

  let buffer = await downloadWorkbook();
  let rowNumber = 2;

  if (buffer) {
    try {
      const files = unzip(buffer);
      const sheetPath = findFirstSheetPath(files);
      if (!sheetPath) throw new Error('Worksheet not found');

      const sheet = files.get(sheetPath).toString('utf8');
      const rowMatches = Array.from(sheet.matchAll(/<row\b[^>]*\br="(\d+)"/g));
      let lastRow = rowMatches.reduce((max, match) => Math.max(max, Number(match[1])), 0);
      if (!lastRow) lastRow = (sheet.match(/<row\b/g) || []).length;

      rowNumber = lastRow + 1;
      const styleIndex = hasBodyStyle(files) ? 2 : null;
      const updated = appendToSheet(sheet, rowNumber, payloadValues(rowNumber, payload), styleIndex);

      files.set(sheetPath, Buffer.from(updated, 'utf8'));
      buffer = zip(files);
    } catch (err) {
      console.error('Существующий XLSX не удалось прочитать, создаю новый:', err);
      await backupBrokenFile();
      buffer = null;
    }
  }

  if (!buffer) {
    const files = workbookFiles();
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const sheet = files.get(sheetPath).toString('utf8');
    rowNumber = 2;
    files.set(
      sheetPath,
      Buffer.from(
        appendToSheet(sheet, rowNumber, payloadValues(rowNumber, payload), 2),
        'utf8'
      )
    );
    buffer = zip(files);
  }

  await uploadWorkbook(buffer);
  return { row: rowNumber };
}

/* ---------- HTTP ---------- */

exports.handler = async (event) => {
  const headers = normalizeHeaders(event.headers);
  const origin = headers.origin || '';

  if (!isAllowedOrigin(origin)) {
    return jsonResponse(403, { ok: false, error: 'Origin not allowed' }, origin);
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  try {
    if (!TOKEN) {
      throw new PublicError('Функция не настроена: добавьте YANDEX_DISK_TOKEN в переменные окружения.', 500);
    }

    if (event.httpMethod === 'GET') {
      return jsonResponse(200, {
        ok: true,
        service: 'wedding-requests',
        file: FILE,
      }, origin);
    }

    if (event.httpMethod !== 'POST') {
      throw new PublicError('Метод не поддерживается.', 405);
    }

    const ip = clientIp(event, headers);
    if (!checkRateLimit(ip)) {
      throw new PublicError('Слишком много заявок. Попробуйте через несколько минут.', 429);
    }

    const body = parseBody(event);

    // Honeypot: боты заполняют скрытое поле. Отвечаем успехом, но ничего не пишем.
    if (clean(body.company, 100)) {
      return jsonResponse(200, { ok: true, row: null }, origin);
    }

    const payload = validate(body);
    const result = await appendRequest(payload);

    console.log('Заявка записана:', payload.name, 'row=' + result.row);
    return jsonResponse(200, { ok: true, row: result.row }, origin);
  } catch (err) {
    console.error('Ошибка обработки заявки:', err && err.stack ? err.stack : err);
    if (err instanceof PublicError) {
      return jsonResponse(err.status, { ok: false, error: err.message }, origin);
    }
    return jsonResponse(500, { ok: false, error: 'Внутренняя ошибка сервиса.' }, origin);
  }
};

/* Для локальных тестов */
exports._private = {
  appendToSheet,
  workbookFiles,
  unzip,
  zip,
  validate,
  payloadValues,
};
