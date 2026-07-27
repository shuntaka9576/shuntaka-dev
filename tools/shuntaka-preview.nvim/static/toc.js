// 目次 (iframe 内)。apps/web/src/components/TableOfContents.tsx の移植で、
// 見出し収集・ツリー化・スクロール追従 (tocbot 相当)・モバイルのモーダル目次まで
// 同じ挙動にする。クラス名も本番と同一なので globals.css の見た目がそのまま出る。
// 内容差し替え時は親 (client.js) が window.__shuntakaPreviewRefresh() を呼ぶ
(function () {
  // tocbot 相当の追従判定オフセット。見出しがこのラインを越えたらアクティブ扱い
  var HEADINGS_OFFSET = 100;

  var desktopEl = document.getElementById('toc-desktop');
  var mobileListEl = document.getElementById('toc-mobile-list');
  var dialogEl = document.getElementById('toc-mobile-dialog');
  var triggerEl = document.getElementById('toc-mobile-trigger');
  var bodyEl = document.getElementById('article-body');
  var sidebarEl = document.getElementById('sidebar');

  var headings = [];
  var activeId = null;

  // location.hash はパーセントエンコードされたまま返るため、
  // 日本語見出し ID と突き合わせるにはデコードが必要
  function decodeHashId(hash) {
    try {
      return decodeURIComponent(hash.replace(/^#/, ''));
    } catch {
      return hash.replace(/^#/, '');
    }
  }

  function collectHeadings() {
    headings = [];
    var content = document.querySelector('.article-content-wrapper');
    if (!content) {
      return;
    }
    var elements = content.querySelectorAll('h1, h2, h3');
    Array.prototype.forEach.call(elements, function (element, index) {
      // 旧コンバータ時代の content_html は見出しに ID が無いためフォールバックを振る
      if (!element.id) {
        element.id = 'heading-' + index;
      }
      // 見出し内のアンカー要素（heading-anchor の # と comrak の空 anchor）はラベルに含めない
      var text = Array.prototype.filter
        .call(element.childNodes, function (node) {
          return !(
            node instanceof Element &&
            (node.classList.contains('heading-anchor') || node.classList.contains('anchor'))
          );
        })
        .map(function (node) {
          return node.textContent || '';
        })
        .join('')
        .trim();
      headings.push({ id: element.id, text: text, level: Number(element.tagName.charAt(1)) });
    });
  }

  function buildTree() {
    var root = [];
    var stack = [{ level: 0, children: root }];
    headings.forEach(function (heading) {
      var node = { id: heading.id, text: heading.text, level: heading.level, children: [] };
      while (stack.length > 1 && heading.level <= stack[stack.length - 1].level) {
        stack.pop();
      }
      stack[stack.length - 1].children.push(node);
      stack.push({ level: heading.level, children: node.children });
    });
    return root;
  }

  function renderList(nodes) {
    var ol = document.createElement('ol');
    ol.className = 'toc-list';
    nodes.forEach(function (node) {
      var li = document.createElement('li');
      li.className = node.id === activeId ? 'toc-list-item is-active-li' : 'toc-list-item';
      var a = document.createElement('a');
      a.className = node.id === activeId ? 'toc-link is-active-link' : 'toc-link';
      a.href = '#' + node.id;
      a.textContent = node.text;
      li.appendChild(a);
      if (node.children.length > 0) {
        li.appendChild(renderList(node.children));
      }
      ol.appendChild(li);
    });
    return ol;
  }

  function renderToc() {
    desktopEl.textContent = '';
    mobileListEl.textContent = '';
    var tree = buildTree();
    if (tree.length > 0) {
      desktopEl.appendChild(renderList(tree));
      mobileListEl.appendChild(renderList(tree));
    }
    // 見出しが無い記事はサイドバーを出さず本文を中央に寄せる (page.tsx の hasToc 相当)
    bodyEl.className = headings.length > 0 ? 'article-body' : 'article-body article-body-centered';
    sidebarEl.style.display = headings.length > 0 ? '' : 'none';
  }

  function setActive(id) {
    if (id === activeId) {
      return;
    }
    activeId = id;
    renderToc();
    // アクティブ項目が目次ペインの表示範囲外に出たらペイン内スクロールで追従する
    // （scrollIntoView はページ側まで動かすことがあるため scrollTop を直接調整する）
    var link = desktopEl.querySelector('.is-active-link');
    if (!link) {
      return;
    }
    var paneRect = desktopEl.getBoundingClientRect();
    var linkRect = link.getBoundingClientRect();
    if (linkRect.top < paneRect.top) {
      desktopEl.scrollTop += linkRect.top - paneRect.top;
    } else if (linkRect.bottom > paneRect.bottom) {
      desktopEl.scrollTop += linkRect.bottom - paneRect.bottom;
    }
  }

  // スクロール位置からアクティブ見出しを追従する
  var rafId = 0;
  function update() {
    rafId = 0;
    if (headings.length === 0) {
      return;
    }
    // ページ最下部で止まった場合、スクロールでは到達できない見出しでも
    // hash が指していればそちらを優先してアクティブにする
    var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atBottom) {
      var hashId = decodeHashId(window.location.hash);
      if (
        hashId &&
        headings.some(function (h) {
          return h.id === hashId;
        })
      ) {
        setActive(hashId);
        return;
      }
    }
    var currentId = null;
    for (var i = 0; i < headings.length; i++) {
      var element = document.getElementById(headings[i].id);
      if (!element) {
        continue;
      }
      if (element.getBoundingClientRect().top <= HEADINGS_OFFSET) {
        currentId = headings[i].id;
      } else {
        break;
      }
    }
    setActive(currentId || headings[0].id);
  }
  function onScroll() {
    if (rafId) {
      return;
    }
    rafId = requestAnimationFrame(update);
  }
  document.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  // クリック直後にアクティブを確定させる（スクロール追従を待つとちらつくため）
  function activateFromLink(target) {
    var link = target.closest('a');
    if (link) {
      setActive(decodeHashId(link.getAttribute('href') || ''));
    }
    return link;
  }
  desktopEl.addEventListener('click', function (ev) {
    activateFromLink(ev.target);
  });
  // 見出しへ移動したらモーダルを閉じて本文を見せる。背景クリックでも閉じる
  dialogEl.addEventListener('click', function (ev) {
    var link = activateFromLink(ev.target);
    if (ev.target === dialogEl || link) {
      dialogEl.close();
    }
  });
  triggerEl.addEventListener('click', function () {
    dialogEl.showModal();
    // dialog は最初のリンクへ自動フォーカスし、block リンクの
    // フォーカスリングが下線のように見えるため、リスト全体へ移す
    mobileListEl.focus();
  });

  function refresh() {
    collectHeadings();
    activeId = null;
    renderToc();
    update();
  }
  window.__shuntakaPreviewRefresh = refresh;
  refresh();
})();
