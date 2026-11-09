/**
 * hbe-toc.js
 *
 * 解决 hexo-blog-encrypt 加密文与 NexT 主题的配合问题。
 *
 * 背景：
 * 1. 加密插件在 generate 时把正文换成密文，主题用 toc(page.content) 扫不到标题，
 *    侧边栏目录为空；又不能在 HTML 里预渲染 toc(page.origin)，否则标题明文泄露。
 * 2. NexT 的代码块增强、Fancybox 图片灯箱等只在首次 page:loaded / boot 时跑一遍，
 *    当时正文还是密文，解密后必须再初始化一次，效果才和普通文章一致。
 *
 * 做法：
 * - 不改 themes/next8（升级主题不会被冲掉）。
 * - 只在加密文通过 post-body-end.njk 加载本脚本。
 * - 监听插件的 hexo-blog-decrypt；解密后再拼 TOC，并补跑代码块 / 表格 / Fancybox。
 *
 * 加载前可配置（post-body-end.njk 里已按主题 toc 配置写入）：
 *   window.HBE_TOC = {
 *     className: 'nav',       // 与 NexT toc(..., {class:'nav'}) 一致，CSS/scrollspy 才能对上
 *     maxDepth: 6,
 *     listNumber: true,       // 是否显示 1. / 1.1. 这类编号
 *     onRender: function (container, decrypted) {}
 *   };
 */
(function () {
  'use strict';

  var opts = window.HBE_TOC || {};
  // NexT 侧边栏 TOC 的 class 前缀是 nav，不要改成 toc，否则主题 CSS 和 registerSidebarTOC 失效
  var cls = opts.className || 'nav';
  var maxDepth = opts.maxDepth || 6;
  // 代码块 / Fancybox 等只能初始化一次；重复调用会叠加复制按钮、语言标签
  var postUiReady = false;

  /**
   * 给没有 id 的标题生成锚点。
   * used 记录本页已占用的 id，避免两个「安装」都变成 #安装。
   * 同时避开文档里已经存在的 id（例如主题或其它脚本写过的）。
   */
  function slug(text, used) {
    var base = text.trim().toLowerCase().replace(/[\s]+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') || 'section';
    var id = base;
    for (var i = 1; used[id] || document.getElementById(id); i++) id = base + '-' + i;
    used[id] = true;
    return id;
  }

  /** 在解密后的正文根节点里收集 h1–h{maxDepth}，去掉空标题 */
  function headings(root) {
    var selector = [];
    for (var level = 1; level <= maxDepth; level++) selector.push('h' + level);
    return Array.prototype.filter.call(root.querySelectorAll(selector.join(',')), function (h) {
      return h.textContent.trim() !== '';
    });
  }

  /**
   * 按 Hexo toc() 的 DOM 结构拼目录，方便直接套 NexT 现成样式和 scrollspy。
   * 结构示例：
   *   ol.nav > li.nav-item.nav-level-2 > a.nav-link > span.nav-text
   *                     └─ ol.nav-child > ...
   * 标题文字用 textContent，不用 innerHTML，避免把标题里的 HTML 当标记执行。
   */
  function build(root) {
    var used = {};
    var list = document.createElement('ol');
    list.className = cls;
    // stack 保存当前标题的祖先链，用来决定挂到哪一层 ol.nav-child
    var stack = [];
    // counters 与 stack 对齐，生成 1. / 1.1. / 2. 这种编号
    var counters = [];

    headings(root).forEach(function (h) {
      var level = Number(h.tagName.charAt(1));
      if (!h.id) h.id = slug(h.textContent, used);

      // 当前标题不比栈顶更深时，弹出同级或更深的祖先
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      counters.length = stack.length + 1;
      counters[stack.length] = (counters[stack.length] || 0) + 1;

      var parentList = list;
      if (stack.length) {
        var parent = stack[stack.length - 1].item;
        parentList = parent.querySelector(':scope > ol.' + cls + '-child');
        if (!parentList) {
          parentList = document.createElement('ol');
          parentList.className = cls + '-child';
          parent.appendChild(parentList);
        }
      }

      var item = document.createElement('li');
      item.className = cls + '-item ' + cls + '-level-' + level;
      var link = document.createElement('a');
      link.className = cls + '-link';
      // NexT registerSidebarTOC 里用 decodeURI 还原，这里用 encodeURI 与之对应
      link.setAttribute('href', '#' + encodeURI(h.id));
      if (opts.listNumber) {
        var number = document.createElement('span');
        number.className = cls + '-number';
        number.textContent = counters.join('.') + '.';
        link.appendChild(number);
        link.appendChild(document.createTextNode(' '));
      }
      var text = document.createElement('span');
      text.className = cls + '-text';
      text.textContent = h.textContent.trim();
      link.appendChild(text);
      item.appendChild(link);
      parentList.appendChild(item);
      stack.push({ level: level, item: item });
    });
    return list;
  }

  /**
   * 加密文 generate 时 toc 为空，主题仍会留下 .post-toc-wrap，但里面没有 .post-toc。
   * 这里补上容器，后面才能把目录灌进去。不改主题模板。
   */
  function ensureContainer() {
    var wrap = document.querySelector('.post-toc-wrap');
    if (!wrap) return null;
    var container = wrap.querySelector('.post-toc:not(.placeholder-toc)');
    if (!container) {
      container = document.createElement('div');
      container.className = 'post-toc animated';
      wrap.appendChild(container);
    }
    return container;
  }

  /**
   * 加密文初次打开时侧边栏是「站点概览」面板（sidebar-overview-active）。
   * 目录生成后切到「文章目录」面板，并加上 sidebar-nav-active，两个 tab 才能正常切换。
   */
  function activateTocPanel() {
    var sidebar = document.querySelector('.sidebar-inner');
    if (!sidebar) return;
    sidebar.classList.add('sidebar-nav-active');
    if (window.NexT && NexT.utils && typeof NexT.utils.activateSidebarPanel === 'function') {
      // 0 = 目录面板，1 = 概览面板
      NexT.utils.activateSidebarPanel(0);
    } else {
      sidebar.classList.remove('sidebar-overview-active');
      sidebar.classList.add('sidebar-toc-active');
    }
  }

  /**
   * 补跑首屏时因密文而跳过的正文 UI。
   * 必须与 NexT.boot.refresh 顺序一致：先 wrapTableWithBox，再 registerCodeblock。
   *
   * 若顺序反了：registerCodeblock 会把整个 figure 包进 .code-container，
   * .code-lang 变成 figure 的兄弟节点，画在不透明的 figure 下面，语言水印看不见。
   * 先有 .table-container 时，code-container 包在 figure 内部，语言标签叠在代码区上方。
   */
  function refreshPostUI() {
    if (postUiReady) return;
    if (!document.querySelector('#hexo-blog-encrypt.hbe-decrypted-content')) return;
    if (!(window.NexT && NexT.utils)) return;

    // 等一帧，让浏览器先完成布局，registerCodeblock 量到的高度才适合判断是否折叠
    requestAnimationFrame(function () {
      if (postUiReady) return;
      if (typeof NexT.utils.wrapTableWithBox === 'function') {
        NexT.utils.wrapTableWithBox();
      }
      if (typeof NexT.utils.registerCodeblock === 'function') {
        // 复制按钮、语言水印、过长代码折叠
        NexT.utils.registerCodeblock();
      }
      if (typeof NexT.utils.registerVideoIframe === 'function') {
        NexT.utils.registerVideoIframe();
      }
      // 本站当前主要用 highlight.js 服务端高亮；若改开 Prism 客户端高亮，这里补跑
      if (window.CONFIG && CONFIG.prism && window.Prism && typeof Prism.highlightAll === 'function') {
        Prism.highlightAll();
      }
      refreshFancybox();
      postUiReady = true;
    });
  }

  /**
   * Fancybox 主题脚本只在 page:loaded 时包装图片，加密文那时还没有 img。
   * 解密后按 fancybox.js 同样的规则包一层 a[data-fancybox]，再重新 bind。
   * 先 unbind 再 bind，避免重复绑定导致一次点击弹出多次。
   */
  function refreshFancybox() {
    if (!window.Fancybox) return;
    var root = document.querySelector('#hexo-blog-encrypt.hbe-decrypted-content');
    if (!root) return;

    // 已在 <a> 里的图（原文就链出去的）不要再包；已包过 fancybox 的也不要再包
    root.querySelectorAll(':not(a) > img, :scope > img').forEach(function (image) {
      if (image.closest('a.fancybox, a[data-fancybox]')) return;
      // 开了懒加载时真实地址在 data-src
      var imageLink = image.dataset.src || image.src;
      var imageWrapLink = document.createElement('a');
      imageWrapLink.classList.add('fancybox');
      imageWrapLink.href = imageLink;
      imageWrapLink.setAttribute('itemscope', '');
      imageWrapLink.setAttribute('itemtype', 'http://schema.org/ImageObject');
      imageWrapLink.setAttribute('itemprop', 'url');

      var dataFancybox = 'default';
      if (image.closest('.post-gallery') !== null) {
        dataFancybox = 'gallery';
      } else if (image.closest('.group-picture') !== null) {
        dataFancybox = 'group';
      }
      imageWrapLink.dataset.fancybox = dataFancybox;

      var imageTitle = image.title || image.alt;
      if (imageTitle) {
        imageWrapLink.title = imageTitle;
        // Fancybox 灯箱底部说明文字读 data-caption
        imageWrapLink.dataset.caption = imageTitle;
      }
      // HTMLElement.prototype.wrap 由 NexT utils.js 提供
      image.wrap(imageWrapLink);
    });

    if (typeof Fancybox.unbind === 'function') {
      Fancybox.unbind('[data-fancybox]');
    }
    Fancybox.bind('[data-fancybox]', {
      // 关掉 hash，避免和 PJAX / 标题锚点抢 location.hash
      Hash: false
    });
  }

  /**
   * 解密完成后的总入口：正文 UI + 侧边栏 TOC。
   * 插件 swap 密文节点后会给容器加上 .hbe-decrypted-content，并 dispatch hexo-blog-decrypt。
   */
  function render() {
    var decrypted = document.querySelector('#hexo-blog-encrypt.hbe-decrypted-content');
    // 未输入密码或非加密页：直接返回，不影响普通文章
    if (!decrypted) return;

    refreshPostUI();

    var container = ensureContainer();
    if (!container) return;

    var list = build(decrypted);
    // 清空旧目录，避免重复解密时叠两份
    container.textContent = '';
    if (!list.children.length) return;
    container.appendChild(list);
    container.hidden = false;
    container.style.removeProperty('display');

    activateTocPanel();

    if (window.NexT && NexT.utils) {
      // 把新生成的 a.nav-link 登记进 scrollspy，点击才能滚到对应标题并高亮当前项
      if (typeof NexT.utils.registerSidebarTOC === 'function') {
        NexT.utils.registerSidebarTOC();
      }
      // 宽屏下按「有目录」规则展开侧边栏
      if (typeof NexT.utils.updateSidebarPosition === 'function') {
        NexT.utils.updateSidebarPosition();
      }
    }

    if (typeof opts.onRender === 'function') opts.onRender(container, decrypted);
  }

  // 用户输入密码解密后触发；部分 fork 可能不带 event.detail，故不依赖 detail
  window.addEventListener('hexo-blog-decrypt', render);
  // autoSave 用缓存密钥时，可能在本脚本执行前就已经解密；再补一次检查
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
