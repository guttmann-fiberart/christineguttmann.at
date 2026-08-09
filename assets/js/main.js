/* Christine Guttmann — Fiber Art · Redesign */

(function () {
  'use strict';

  /* ----- Mobile navigation ----- */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('top-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', open);
    });

    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        document.body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ----- Slider (homepage only) ----- */
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var dotsWrap = document.querySelector('.slider-dots');

  if (slides.length && dotsWrap) {
    var current = 0;
    var timer = null;
    var INTERVAL = 6000;

    slides.forEach(function (_, i) {
      var dot = document.createElement('button');
      dot.setAttribute('aria-label', 'Bild ' + (i + 1));
      if (i === 0) dot.classList.add('is-active');
      dot.addEventListener('click', function () { goTo(i); restart(); });
      dotsWrap.appendChild(dot);
    });

    var dots = Array.prototype.slice.call(dotsWrap.children);

    var goTo = function (i) {
      slides[current].classList.remove('is-active');
      dots[current].classList.remove('is-active');
      current = (i + slides.length) % slides.length;
      slides[current].classList.add('is-active');
      dots[current].classList.add('is-active');
    };

    var restart = function () {
      clearInterval(timer);
      timer = setInterval(function () { goTo(current + 1); }, INTERVAL);
    };

    document.querySelector('.slider-arrow.prev').addEventListener('click', function () { goTo(current - 1); restart(); });
    document.querySelector('.slider-arrow.next').addEventListener('click', function () { goTo(current + 1); restart(); });
    restart();
  }

  /* ----- Portfolio filter (homepage only) ----- */
  var filters = Array.prototype.slice.call(document.querySelectorAll('.filter'));
  var items = Array.prototype.slice.call(document.querySelectorAll('.grid .item'));

  filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filters.forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      var cat = btn.dataset.filter;
      items.forEach(function (item) {
        item.classList.toggle('is-hidden', cat !== 'all' && item.dataset.cat !== cat);
      });
    });
  });

  /* ----- Lightbox -----
     Any <a data-lightbox href="…jpg"> opens in an overlay instead of
     navigating. Without JS the link still resolves to the full image. */
  var triggers = Array.prototype.slice.call(document.querySelectorAll('a[data-lightbox]'));

  if (triggers.length) {
    var box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Bildansicht');
    box.innerHTML =
      '<button class="lb-close" aria-label="Schließen">&times;</button>' +
      '<button class="lb-arrow prev" aria-label="Vorheriges Bild">&#10094;</button>' +
      '<button class="lb-arrow next" aria-label="Nächstes Bild">&#10095;</button>' +
      '<figure><img alt=""><figcaption></figcaption></figure>';
    document.body.appendChild(box);

    var lbImg = box.querySelector('img');
    var lbCap = box.querySelector('figcaption');
    var lbIndex = 0;
    var lastFocus = null;

    function visibleTriggers() {
      return triggers.filter(function (t) { return !t.classList.contains('is-hidden'); });
    }

    function show(list, i) {
      lbIndex = (i + list.length) % list.length;
      var t = list[lbIndex];
      lbImg.src = t.getAttribute('href');
      lbImg.alt = t.dataset.caption || '';
      lbCap.textContent = t.dataset.caption || '';
      box.classList.toggle('has-nav', list.length > 1);
    }

    function open(t) {
      var list = visibleTriggers();
      lastFocus = t;
      show(list, list.indexOf(t));
      box.classList.add('is-open');
      document.body.classList.add('lb-open');
      box.querySelector('.lb-close').focus();
    }

    function close() {
      box.classList.remove('is-open');
      document.body.classList.remove('lb-open');
      lbImg.removeAttribute('src');
      if (lastFocus) lastFocus.focus();
    }

    function step(delta) { show(visibleTriggers(), lbIndex + delta); }

    triggers.forEach(function (t) {
      t.addEventListener('click', function (e) {
        e.preventDefault();
        open(t);
      });
    });

    box.querySelector('.lb-close').addEventListener('click', close);
    box.querySelector('.lb-arrow.prev').addEventListener('click', function () { step(-1); });
    box.querySelector('.lb-arrow.next').addEventListener('click', function () { step(1); });
    box.addEventListener('click', function (e) { if (e.target === box) close(); });

    document.addEventListener('keydown', function (e) {
      if (!box.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }

  /* ----- Footer year ----- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
