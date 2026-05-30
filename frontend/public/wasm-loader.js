// Wasm バイナリが存在する場合のみブラシエンジンスクリプトを読み込む。
// HEAD リクエストで存在確認してから <script> を挿入することで、
// Wasm が未ビルドの環境でも TS フォールバックが正常に動作する。
fetch('/brush_engine.wasm', { method: 'HEAD' }).then(function (r) {
  if (r.ok) {
    var s = document.createElement('script');
    s.src = '/brush_engine.js';
    document.head.appendChild(s);
  }
}).catch(function () {});
