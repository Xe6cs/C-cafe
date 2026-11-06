/* تتبع نشاط الزوار: بلا كوكيز وبلا بيانات شخصية. يتوقف تلقائيًا في المعاينة وعند فتح الملف محليًا. */
(function () {
  'use strict';

  if (location.protocol === 'file:' || window.CCAFE_PREVIEW) return;
  try {
    if (localStorage.getItem('ccafe-notrack') === '1') return;
  } catch (e) { /* التخزين غير متاح: يستمر التتبع */ }

  var sid = null;
  try {
    sid = sessionStorage.getItem('ccafe-sid');
  } catch (e) { /* يُولَّد معرّف جديد */ }
  if (!sid) {
    var bytes = new Uint8Array(10);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    sid = Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
    try {
      sessionStorage.setItem('ccafe-sid', sid);
    } catch (e) { /* معرّف لهذه الصفحة فقط */ }
  }

  function send(data) {
    data.s = sid;
    var body = JSON.stringify(data);
    if (navigator.sendBeacon && navigator.sendBeacon('api/track', new Blob([body], { type: 'text/plain' }))) return;
    if (window.fetch) {
      fetch('api/track', { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
    }
  }

  /* الزيارة: المصدر هو اسم الموقع القادم منه فقط، وليس الرابط الكامل */
  var referrer = '';
  try {
    if (document.referrer) {
      var host = new URL(document.referrer).hostname;
      if (host !== location.hostname) referrer = host;
    }
  } catch (e) { /* مصدر غير معروف */ }
  var utm = '';
  try {
    utm = new URLSearchParams(location.search).get('utm_source') || '';
  } catch (e) { /* متصفح قديم */ }
  send({ e: 'pageview', r: referrer, u: utm });

  /* الأقسام التي وصل إليها الزائر: عند مرور القسم بمنتصف الشاشة */
  if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          send({ e: 'section', n: entry.target.id });
          seen.unobserve(entry.target);
        }
      });
    }, { rootMargin: '-40% 0px -40% 0px' });
    document.querySelectorAll('main section[id]').forEach(function (section) {
      if (section.id !== 'top') seen.observe(section);
    });
  }

  function linkKind(href, anchor) {
    if (/^tel:/i.test(href)) return 'call';
    if (/^mailto:/i.test(href)) return 'email';
    if (href.charAt(0) === '#') return 'internal';
    if (/(^https?:\/\/)?(maps\.|[^/]*google\.[^/]+\/maps|goo\.gl\/maps)/i.test(href)) return 'directions';
    if (/instagram\.com/i.test(href)) return 'instagram';
    if (/wa\.me|whatsapp\.com/i.test(href)) return 'whatsapp';
    return anchor.hostname === location.hostname ? 'internal' : 'external';
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var tab = target.closest('.mood-tab');
    if (tab) {
      send({ e: 'mood', n: tab.textContent.trim() });
      return;
    }
    var anchor = target.closest('a[href]');
    if (!anchor) return;
    send({
      e: 'click',
      k: linkKind(anchor.getAttribute('href'), anchor),
      n: (anchor.textContent.trim() || anchor.getAttribute('aria-label') || '').slice(0, 80),
    });
  }, true);

  /* مدة البقاء الفعلية (عندما تكون الصفحة ظاهرة) وأقصى نسبة تمرير */
  var visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
  var visibleTotal = 0;
  var maxScroll = 0;

  window.addEventListener('scroll', function () {
    var room = document.documentElement.scrollHeight - window.innerHeight;
    if (room > 0) maxScroll = Math.max(maxScroll, (window.scrollY / room) * 100);
  }, { passive: true });

  function report() {
    if (visibleSince !== null) {
      visibleTotal += Date.now() - visibleSince;
      visibleSince = null;
    }
    send({ e: 'leave', ms: visibleTotal, sc: maxScroll });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (visibleSince !== null) report();
    } else if (visibleSince === null) {
      visibleSince = Date.now();
    }
  });
  window.addEventListener('pagehide', function () {
    if (visibleSince !== null) report();
  });
})();
