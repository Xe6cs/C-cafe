(function () {
  'use strict';

  /* اختيار المزاج: تبويبات تعمل باللمس والفأرة ولوحة المفاتيح */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.mood-tab'));
  var panels = tabs.map(function (tab) {
    return document.getElementById(tab.getAttribute('aria-controls'));
  });

  function selectMood(index, moveFocus) {
    tabs.forEach(function (tab, i) {
      var active = i === index;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      panels[i].classList.toggle('is-active', active);
    });
    if (moveFocus) tabs[index].focus();

    // في عرض الشرائح الأفقية يبقى الخيار المحدد ظاهرًا، بلا تحريك للصفحة نفسها
    var list = tabs[index].parentElement;
    if (list.scrollWidth > list.clientWidth) {
      var tabBox = tabs[index].getBoundingClientRect();
      var listBox = list.getBoundingClientRect();
      list.scrollBy({
        left: tabBox.left + tabBox.width / 2 - (listBox.left + listBox.width / 2),
        behavior: 'smooth'
      });
    }
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectMood(i); });
    tab.addEventListener('keydown', function (e) {
      var last = tabs.length - 1;
      var next = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = i === last ? 0 : i + 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = i === 0 ? last : i - 1;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = last;
      if (next !== null) {
        e.preventDefault();
        selectMood(next, true);
      }
    });
  });

  /* الترويسة: شفافة فوق البرتقالي، وتتحول إلى ليلية مع أول تمرير حتى لا يتداخل المحتوى معها */
  var head = document.querySelector('[data-head]');
  function updateHead() {
    head.classList.toggle('is-stuck', window.scrollY > 24);
  }
  window.addEventListener('scroll', updateHead, { passive: true });
  updateHead();

  var moodsSection = document.getElementById('moods');
  var reveals = document.querySelectorAll('.reveal');

  // لا حاجة لتأثيرات الظهور في معاينة لوحة التحكم
  if (window.CCAFE_PREVIEW || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
    return;
  }

  /* تحميل صور الأمزجة مسبقًا عند الاقتراب من القسم حتى يكون التبديل فوريًا */
  var preload = new IntersectionObserver(function (entries) {
    if (entries.some(function (entry) { return entry.isIntersecting; })) {
      panels.forEach(function (panel) {
        var img = panel.querySelector('img');
        if (img) img.loading = 'eager';
      });
      preload.disconnect();
    }
  }, { rootMargin: '600px 0px' });
  if (moodsSection) preload.observe(moodsSection);

  /* ظهور هادئ عند التمرير */
  var revealer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        revealer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px' });
  reveals.forEach(function (el) { revealer.observe(el); });
})();
