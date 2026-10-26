/* ============================================================
   Артём Акимов — лендинг. Ванильный JS, без зависимостей.
   ============================================================ */
(() => {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ============================================================
     Мобильное меню: бургер, блокировка скролла, Esc, клик вне
     ============================================================ */
  const burger = document.getElementById('burger');
  const nav = document.getElementById('nav');

  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  }

  burger.addEventListener('click', () => {
    setMenu(!document.body.classList.contains('menu-open'));
  });

  // Закрытие по Esc
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('menu-open')) setMenu(false);
    closeLightbox();
  });

  // Закрытие по клику вне меню и бургера
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('menu-open')) return;
    if (!nav.contains(e.target) && !burger.contains(e.target)) setMenu(false);
  });

  // Закрытие при переходе по ссылке меню
  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setMenu(false));
  });

  /* ============================================================
     Плавное появление блоков при скролле (IntersectionObserver)
     ============================================================ */
  const revealEls = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window && !reducedMotion) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    revealEls.forEach((el) => observer.observe(el));
  } else {
    // Без IO или при reduced-motion показываем всё сразу
    revealEls.forEach((el) => el.classList.add('is-visible'));
  }

  /* ============================================================
     Галерея: табы-фильтры
     Элементы запрашиваются динамически: content.js может
     перерисовать галерею из данных админки.
     ============================================================ */
  const tabs = document.querySelectorAll('.tab');
  const galleryGrid = document.getElementById('galleryGrid');
  let currentFilter = 'all';

  function galleryItems() {
    return galleryGrid ? Array.from(galleryGrid.querySelectorAll('.gallery__item')) : [];
  }

  function decorateGalleryItems() {
    galleryItems().forEach((item) => {
      const img = item.querySelector('img');
      item.setAttribute('tabindex', '0');
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', 'Открыть фото: ' + (img ? img.alt : ''));
    });
  }

  function applyFilter(filter) {
    currentFilter = filter;
    galleryItems().forEach((item) => {
      const show = filter === 'all' || item.dataset.category === filter;
      item.classList.toggle('is-hidden', !show);
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.classList.remove('is-active');
        t.setAttribute('aria-pressed', 'false');
      });
      tab.classList.add('is-active');
      tab.setAttribute('aria-pressed', 'true');
      applyFilter(tab.dataset.filter);
    });
  });

  decorateGalleryItems();

  // content.js обновил галерею — заново применяем фильтр и атрибуты
  window.addEventListener('akimov:content-updated', () => {
    decorateGalleryItems();
    applyFilter(currentFilter);
  });

  /* ============================================================
     Лайтбокс: открытие, стрелки, клавиатура, свайп
     ============================================================ */
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const btnClose = lightbox.querySelector('.lightbox__close');
  const btnPrev = lightbox.querySelector('.lightbox__nav--prev');
  const btnNext = lightbox.querySelector('.lightbox__nav--next');

  let currentItems = [];
  let currentIndex = 0;
  let lastFocused = null;

  // В лайтбоксе участвуют только видимые (отфильтрованные) фото
  function visibleItems() {
    return galleryItems().filter((item) => !item.classList.contains('is-hidden'));
  }

  function updateLightbox() {
    const item = currentItems[currentIndex];
    const img = item.querySelector('img');
    lightboxImg.src = item.dataset.full;
    lightboxImg.alt = img.alt;
    lightboxCaption.textContent = img.alt;
  }

  function openLightbox(item) {
    currentItems = visibleItems();
    currentIndex = currentItems.indexOf(item);
    if (currentIndex === -1) return;

    lastFocused = document.activeElement;
    updateLightbox();
    lightbox.hidden = false;
    document.body.classList.add('lightbox-open');
    btnClose.focus();
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    document.body.classList.remove('lightbox-open');
    lightboxImg.src = '';
    if (lastFocused) lastFocused.focus();
  }

  function step(dir) {
    const len = currentItems.length;
    currentIndex = (currentIndex + dir + len) % len;
    updateLightbox();
  }

  // Делегирование: работает и для фото, добавленных админкой после загрузки
  galleryGrid.addEventListener('click', (e) => {
    const item = e.target.closest('.gallery__item');
    if (item && galleryGrid.contains(item)) openLightbox(item);
  });

  galleryGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.gallery__item');
    if (!item) return;
    e.preventDefault();
    openLightbox(item);
  });

  btnClose.addEventListener('click', closeLightbox);
  btnPrev.addEventListener('click', () => step(-1));
  btnNext.addEventListener('click', () => step(1));

  // Закрытие по клику на фон
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  // Навигация стрелками ← →
  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  // Свайп через Pointer Events (мышь + тач)
  let lightboxStartX = null;
  lightbox.addEventListener('pointerdown', (e) => {
    lightboxStartX = e.clientX;
  });
  lightbox.addEventListener('pointerup', (e) => {
    if (lightboxStartX === null) return;
    const dx = e.clientX - lightboxStartX;
    lightboxStartX = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });
  lightbox.addEventListener('pointercancel', () => {
    lightboxStartX = null;
  });

  /* ============================================================
     Слайдер отзывов: кнопки, точки, свайп, автопрокрутка
     ============================================================ */
  const slider = document.getElementById('testimonialsSlider');
  const track = slider.querySelector('.slider__track');
  const slides = slider.querySelectorAll('.slider__slide');
  const dotsWrap = slider.querySelector('.slider__dots');
  const prevBtn = slider.querySelector('.slider__btn--prev');
  const nextBtn = slider.querySelector('.slider__btn--next');

  let slideIndex = 0;
  let autoTimer = null;

  // Точки создаём динамически по числу слайдов
  slides.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'slider__dot';
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `Отзыв ${i + 1} из ${slides.length}`);
    dot.addEventListener('click', () => goTo(i));
    dotsWrap.appendChild(dot);
  });
  const dots = dotsWrap.querySelectorAll('.slider__dot');

  function goTo(i) {
    slideIndex = (i + slides.length) % slides.length;
    track.style.transform = `translateX(-${slideIndex * 100}%)`;

    dots.forEach((d, di) => {
      d.classList.toggle('is-active', di === slideIndex);
      d.setAttribute('aria-selected', String(di === slideIndex));
    });

    slides.forEach((s, si) => {
      s.setAttribute('aria-hidden', String(si !== slideIndex));
    });
  }

  prevBtn.addEventListener('click', () => goTo(slideIndex - 1));
  nextBtn.addEventListener('click', () => goTo(slideIndex + 1));

  // Свайп
  let slideStartX = null;
  track.addEventListener('pointerdown', (e) => {
    slideStartX = e.clientX;
  });
  track.addEventListener('pointerup', (e) => {
    if (slideStartX === null) return;
    const dx = e.clientX - slideStartX;
    slideStartX = null;
    if (Math.abs(dx) > 50) goTo(slideIndex + (dx < 0 ? 1 : -1));
  });
  track.addEventListener('pointercancel', () => {
    slideStartX = null;
  });

  // Автопрокрутка: пауза при наведении/фокусе, отключена при reduced-motion
  function startAuto() {
    if (reducedMotion) return;
    stopAuto();
    autoTimer = setInterval(() => goTo(slideIndex + 1), 7000);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  slider.addEventListener('mouseenter', stopAuto);
  slider.addEventListener('mouseleave', startAuto);
  slider.addEventListener('focusin', stopAuto);
  slider.addEventListener('focusout', startAuto);

  goTo(0);
  startAuto();

  /* ============================================================
     Форма: HTML5-валидация + заглушка через alert
     (для приёма заявок подключите Formspree / Netlify Forms)
     ============================================================ */
  const form = document.getElementById('contactForm');
  const dateInput = document.getElementById('date');

  // Нельзя выбрать дату в прошлом
  const today = new Date().toISOString().split('T')[0];
  dateInput.min = today;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const name = document.getElementById('name').value.trim();
    alert(`Спасибо, ${name || 'друг'}! Ваша заявка отправлена — я отвечу в течение дня.`);
    form.reset();
  });
})();
