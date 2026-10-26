/* ============================================================
   Артём Акимов — связка сайта и админки.
   Читает данные, сохранённые в admin.html (localStorage), и
   применяет их к галерее, ценам и контактам.
   Если localStorage пуст (например, на хостинге у посетителя),
   пробует загрузить data.json, лежащий рядом с index.html.
   ============================================================ */
(() => {
  'use strict';

  const KEYS = {
    photos: 'akimov_photos',
    pricing: 'akimov_pricing',
    contacts: 'akimov_contacts',
  };

  const SPANS = [34, 38, 28, 21, 34, 38];
  const SIZES = '(max-width: 767px) 50vw, (max-width: 1023px) 33vw, 25vw';

  let hasLocalData = false;

  /* ---------- Чтение localStorage ---------- */
  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      return value || null;
    } catch (err) {
      console.warn('[content] Не удалось прочитать «' + key + '»:', err);
      return null;
    }
  }

  /* ---------- Галерея ---------- */
  function renderGallery(photos) {
    const grid = document.getElementById('galleryGrid');
    if (!grid || !Array.isArray(photos) || photos.length === 0) return false;

    const frag = document.createDocumentFragment();

    photos.forEach((photo, index) => {
      if (!photo || !photo.src) return;

      const figure = document.createElement('figure');
      figure.className = 'gallery__item';
      figure.dataset.category = photo.category || 'weddings';
      figure.dataset.full = photo.src;
      figure.style.setProperty('--span', photo.span || SPANS[index % SPANS.length]);
      figure.setAttribute('tabindex', '0');
      figure.setAttribute('role', 'button');
      figure.setAttribute('aria-label', 'Открыть фото: ' + (photo.alt || ''));

      const img = document.createElement('img');
      img.src = photo.src;
      img.alt = photo.alt || '';
      img.width = photo.width || 1024;
      img.height = photo.height || 1024;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.sizes = SIZES;

      // data:-URL содержит запятые, поэтому srcset для них не задаём.
      // Пробелы в имени файла обязательно кодируем — иначе srcset ломается.
      if (!photo.src.startsWith('data:')) {
        img.srcset = photo.src.replace(/ /g, '%20') + ' ' + img.width + 'w';
      }

      figure.appendChild(img);
      frag.appendChild(figure);
    });

    if (!frag.childNodes.length) return false;
    grid.replaceChildren(frag);
    return true;
  }

  /* ---------- Цены ---------- */
  function applyPricing(pricing) {
    if (!pricing || typeof pricing !== 'object') return;

    document.querySelectorAll('[data-plan]').forEach((card) => {
      const data = pricing[card.dataset.plan];
      if (!data || typeof data !== 'object') return;

      setCardText(card, '.price-card__name', data.name);
      setCardText(card, '.price-card__price', data.price);
      setCardText(card, '.price-card__desc', data.desc);

      if (Array.isArray(data.includes) && data.includes.length) {
        const list = card.querySelector('.price-card__includes');
        if (!list) return;

        const items = data.includes
          .filter((line) => typeof line === 'string' && line.trim())
          .map((line) => {
            const li = document.createElement('li');
            li.textContent = line.trim();
            return li;
          });

        if (items.length) list.replaceChildren(...items);
      }
    });
  }

  function setCardText(card, selector, value) {
    if (typeof value !== 'string' || !value.trim()) return;
    const el = card.querySelector(selector);
    if (el) el.textContent = value;
  }

  /* ---------- Контакты ---------- */
  function applyContacts(contacts) {
    if (!contacts || typeof contacts !== 'object') return;

    const city = document.querySelector('[data-contact="city"]');
    if (city && contacts.city) city.textContent = contacts.city;

    const phone = document.querySelector('[data-contact="phone"]');
    if (phone && contacts.phone) {
      phone.textContent = contacts.phone;
      const tel = contacts.phone.replace(/[^\d+]/g, '');
      if (tel) phone.setAttribute('href', 'tel:' + tel);
    }

    const email = document.querySelector('[data-contact="email"]');
    if (email && contacts.email) {
      email.textContent = contacts.email;
      email.setAttribute('href', 'mailto:' + contacts.email);
    }

    const vk = document.querySelector('[data-contact="vk"]');
    if (vk && contacts.vk) vk.setAttribute('href', contacts.vk);
  }

  /* ---------- Применение набора данных ---------- */
  function applyData(data) {
    if (!data) return;
    if (data.photos) renderGallery(data.photos);
    if (data.pricing) applyPricing(data.pricing);
    if (data.contacts) applyContacts(data.contacts);

    // script.js перевешивает tabindex/aria и повторно применяет фильтр
    window.dispatchEvent(new CustomEvent('akimov:content-updated'));
  }

  function applyLocal() {
    const data = {
      photos: readJSON(KEYS.photos),
      pricing: readJSON(KEYS.pricing),
      contacts: readJSON(KEYS.contacts),
    };

    hasLocalData = Boolean(data.photos || data.pricing || data.contacts);
    applyData(data);

    if (!data.photos || !data.pricing || !data.contacts) {
      loadFallback(data);
    }
  }

  /* ---------- data.json: запасной вариант для хостинга ---------- */
  async function loadFallback(local) {
    try {
      const res = await fetch('data.json', { cache: 'no-store' });
      if (!res.ok) return;

      const remote = await res.json();
      if (!remote || typeof remote !== 'object') return;

      const merged = {
        photos: local.photos || remote.photos,
        pricing: local.pricing || remote.pricing,
        contacts: local.contacts || remote.contacts,
      };

      if (merged.photos || merged.pricing || merged.contacts) applyData(merged);
    } catch (err) {
      // data.json может отсутствовать — это нормально
    }
  }

  /* ---------- Синхронизация между вкладками ---------- */
  window.addEventListener('storage', (e) => {
    if (!e.key || Object.values(KEYS).includes(e.key)) applyLocal();
  });

  /* ---------- Старт ---------- */
  applyLocal();

  // Небольшая подсказка в консоли для владельца сайта
  if (!hasLocalData) {
    console.info('[content] Локальных данных админки нет — используется галерея из HTML или data.json.');
  }
})();
