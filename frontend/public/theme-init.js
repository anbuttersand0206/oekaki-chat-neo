(function () {
  var t = localStorage.getItem('theme') || 'dark';
  document.documentElement.dataset.theme = t;
})();
