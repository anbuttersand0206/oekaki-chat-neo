// FOUC（スタイル未適用の瞬間的なフラッシュ）を防ぐため、
// CSS より先に実行してテーマをルート要素に即時適用する
(function () {
  var t = localStorage.getItem('theme') || 'dark';
  document.documentElement.dataset.theme = t;
})();
