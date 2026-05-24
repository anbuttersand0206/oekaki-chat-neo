fetch('/brush_engine.wasm', { method: 'HEAD' }).then(function (r) {
  if (r.ok) {
    var s = document.createElement('script');
    s.src = '/brush_engine.js';
    document.head.appendChild(s);
  }
}).catch(function () {});
