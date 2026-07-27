// 外側ページ (shell) のブラウザ側。WebSocket でサーバーから HTML とスクロール位置を
// 受け取って同一オリジンの iframe (/view) に反映し、記事一覧サイドバーと
// pc / mobile 切り替えもここで行う。
// DOM 型と bun-types が衝突するため TS にせず素の JS で静的配信する
(function () {
  var iframe = document.getElementById('view');
  var latestHtml = null;
  var currentPath = null;

  function applyHtml() {
    if (latestHtml === null) {
      return;
    }
    var doc = iframe.contentDocument;
    var el = doc && doc.getElementById('content');
    if (el) {
      el.innerHTML = latestHtml;
      // 目次 (toc.js) を新しい本文で組み立て直す
      var win = iframe.contentWindow;
      if (win && typeof win.__shuntakaPreviewRefresh === 'function') {
        win.__shuntakaPreviewRefresh();
      }
    }
  }
  // iframe のリロード後にも最新 HTML を反映し直す
  iframe.addEventListener('load', applyHtml);

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onmessage = function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.type === 'html') {
      latestHtml = msg.html;
      applyHtml();
      if (msg.path && msg.path !== currentPath) {
        currentPath = msg.path;
        loadArticles();
      } else {
        renderList();
      }
    } else if (msg.type === 'scroll') {
      var win = iframe.contentWindow;
      var doc = iframe.contentDocument;
      if (!win || !doc) {
        return;
      }
      var d = doc.documentElement;
      var max = d.scrollHeight - d.clientHeight;
      win.scrollTo(0, Math.max(0, max * msg.ratio));
    }
  };

  // サーバー停止（:ShuntakaPreviewStop / Neovim 終了）をタブ側でも分かるようにする
  ws.onclose = function () {
    document.title = '(disconnected) ' + document.title;
  };

  // ---- 記事一覧サイドバー ----
  var listEl = document.getElementById('articles');
  var sortEl = document.getElementById('sort');
  var articles = [];

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  function fmtDate(ms) {
    var d = new Date(ms);
    return (
      d.getFullYear() +
      '/' +
      pad(d.getMonth() + 1) +
      '/' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  function sortedArticles() {
    var mode = sortEl.value;
    var list = articles.slice();
    if (mode === 'name') {
      list.sort(function (a, b) {
        return a.name < b.name ? -1 : 1;
      });
    } else if (mode === 'created') {
      list.sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
    } else {
      list.sort(function (a, b) {
        return b.updatedAt - a.updatedAt;
      });
    }
    return list;
  }

  function renderList() {
    listEl.textContent = '';
    sortedArticles().forEach(function (a) {
      var li = document.createElement('li');
      if (a.path === currentPath) {
        li.className = 'active';
      }
      var title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = a.title;
      var dates = document.createElement('div');
      dates.className = 'item-dates';
      dates.textContent = '更新 ' + fmtDate(a.updatedAt) + ' / 作成 ' + fmtDate(a.createdAt);
      li.appendChild(title);
      li.appendChild(dates);
      li.addEventListener('click', function () {
        // サーバー経由で Neovim 側にも :edit してもらう
        ws.send(JSON.stringify({ type: 'open', path: a.path }));
      });
      listEl.appendChild(li);
    });
  }

  function loadArticles() {
    fetch('/articles')
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        articles = data.articles;
        if (data.current) {
          currentPath = data.current;
        }
        renderList();
      })
      .catch(function () {
        // サーバー停止中などは一覧をそのままにする
      });
  }

  sortEl.addEventListener('change', renderList);
  // 保存で mtime が変わるので、タブに戻ってきたタイミングで一覧を取り直す
  window.addEventListener('focus', loadArticles);
  loadArticles();

  // ---- pc / mobile 切り替え ----
  var STORAGE_KEY = 'shuntaka-preview-viewport';
  var buttons = document.querySelectorAll('[data-viewport-mode]');

  function setViewport(mode) {
    document.body.dataset.viewport = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // プライベートモード等で localStorage が使えなくても切り替え自体は動かす
    }
    buttons.forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.viewportMode === mode);
    });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setViewport(btn.dataset.viewportMode);
    });
  });

  var saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // 読めなければ既定の pc にする
  }
  setViewport(saved === 'mobile' ? 'mobile' : 'pc');
})();
