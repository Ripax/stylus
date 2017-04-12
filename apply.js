// Not using some slow features of ES6, see http://kpdecker.github.io/six-speed/
// like destructring, classes, defaults, spread, calculated key names
/* eslint no-var: 0 */
'use strict';

var ID_PREFIX = 'stylus-';
var ROOT = document.documentElement;
var isOwnPage = location.href.startsWith('chrome-extension:');
var disableAll = false;
var styleElements = new Map();
var disabledElements = new Map();
var retiredStyleTimers = new Map();
var docRewriteObserver;

requestStyles();
chrome.runtime.onMessage.addListener(applyOnMessage);

if (!isOwnPage) {
  window.dispatchEvent(new CustomEvent(chrome.runtime.id));
  window.addEventListener(chrome.runtime.id, orphanCheck, true);
}

function requestStyles(options) {
  var matchUrl = location.href;
  try {
    // dynamic about: and javascript: iframes don't have an URL yet
    // so we'll try the parent frame which is guaranteed to have a real URL
    if (!matchUrl.match(/^(http|file|chrome|ftp)/) && window != parent) {
      matchUrl = parent.location.href;
    }
  } catch (e) {}
  const request = Object.assign({
    method: 'getStyles',
    matchUrl,
    enabled: true,
    asHash: true,
  }, options);
  // If this is a Stylish page (Edit Style or Manage Styles),
  // we'll request the styles directly to minimize delay and flicker,
  // unless Chrome is still starting up and the background page isn't fully loaded.
  // (Note: in this case the function may be invoked again from applyStyles.)
  if (typeof getStylesSafe !== 'undefined') {
    getStylesSafe(request).then(applyStyles);
  } else {
    chrome.runtime.sendMessage(request, applyStyles);
  }
}


function applyOnMessage(request, sender, sendResponse) {
  // Do-It-Yourself tells our built-in pages to fetch the styles directly
  // which is faster because IPC messaging JSON-ifies everything internally
  if (request.styles == 'DIY') {
    getStylesSafe({
      matchUrl: location.href,
      enabled: true,
      asHash: true,
    }).then(styles =>
      applyOnMessage(Object.assign(request, {styles})));
    return;
  }
  switch (request.method) {

    case 'styleDeleted':
      removeStyle(request);
      break;

    case 'styleUpdated':
      if (request.codeIsUpdated === false) {
        applyStyleState(request.style);
        break;
      }
      if (!request.style.enabled) {
        removeStyle(request.style);
        break;
      }
      removeStyle({id: request.style.id, retire: true});
     // fallthrough to 'styleAdded'

    case 'styleAdded':
      if (request.style.enabled) {
        requestStyles({id: request.style.id});
      }
      break;

    case 'styleApply':
      applyStyles(request.styles);
      break;

    case 'styleReplaceAll':
      replaceAll(request.styles);
      break;

    case 'prefChanged':
      if ('disableAll' in request.prefs) {
        doDisableAll(request.prefs.disableAll);
      }
      break;

    case 'ping':
      sendResponse(true);
      break;
  }
}


function doDisableAll(disable) {
  if (!disable === !disableAll) {
    return;
  }
  disableAll = disable;
  Array.prototype.forEach.call(document.styleSheets, stylesheet => {
    if (stylesheet.ownerNode.matches(`STYLE.stylus[id^="${ID_PREFIX}"]`)
    && stylesheet.disabled != disable) {
      stylesheet.disabled = disable;
    }
  });
}


function applyStyleState({id, enabled}) {
  const inCache = disabledElements.get(id) || styleElements.get(id);
  const inDoc = document.getElementById(ID_PREFIX + id);
  if (enabled && inDoc || !enabled && !inDoc) {
    return;
  }
  if (enabled && !inDoc && !inCache) {
    requestStyles({id});
    return;
  }
  if (enabled && inCache) {
    addStyleElement(inCache);
    disabledElements.delete(id);
    return;
  }
  if (!enabled && inDoc) {
    disabledElements.set(id, inDoc);
    inDoc.remove();
    if (document.location.href == 'about:srcdoc') {
      const original = document.getElementById(ID_PREFIX + id);
      if (original) {
        original.remove();
      }
    }
    return;
  }
}


function removeStyle({id, retire = false}) {
  const el = document.getElementById(ID_PREFIX + id);
  if (el) {
    if (retire) {
      // to avoid page flicker when the style is updated
      // instead of removing it immediately we rename its ID and queue it
      // to be deleted in applyStyles after a new version is fetched and applied
      const deadID = 'ghost-' + id;
      el.id = ID_PREFIX + deadID;
      // in case something went wrong and new style was never applied
      retiredStyleTimers.set(deadID, setTimeout(removeStyle, 1000, {id: deadID}));
    } else {
      el.remove();
    }
  }
  styleElements.delete(ID_PREFIX + id);
  disabledElements.delete(id);
  retiredStyleTimers.delete(id);
}


function applyStyles(styles) {
  if (!styles) {
    // Chrome is starting up
    requestStyles();
    return;
  }
  if ('disableAll' in styles) {
    doDisableAll(styles.disableAll);
    delete styles.disableAll;
  }
  if (document.head
  && document.head.firstChild
  && document.head.firstChild.id == 'xml-viewer-style') {
    // when site response is application/xml Chrome displays our style elements
    // under document.documentElement as plain text so we need to move them into HEAD
    // which is already autogenerated at this moment
    ROOT = document.head;
  }
  for (const id in styles) {
    applySections(id, styles[id]);
  }
  initDocRewriteObserver();
  if (retiredStyleTimers.size) {
    setTimeout(() => {
      for (const [id, timer] of retiredStyleTimers.entries()) {
        removeStyle({id});
        clearTimeout(timer);
      }
    });
  }
}


function applySections(styleId, sections) {
  let el = document.getElementById(ID_PREFIX + styleId);
  if (el) {
    return;
  }
  if (document.documentElement instanceof SVGSVGElement) {
    // SVG document, make an SVG style element.
    el = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  } else if (document instanceof XMLDocument) {
    el = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  } else {
    // This will make an HTML style element. If there's SVG embedded in an HTML document, this works on the SVG too.
    el = document.createElement('style');
  }
  Object.assign(el, {
    id: ID_PREFIX + styleId,
    className: 'stylus',
    type: 'text/css',
    textContent: sections.map(section => section.code).join('\n'),
  });
  addStyleElement(el);
  styleElements.set(el.id, el);
  disabledElements.delete(styleId);
}


function addStyleElement(el) {
  if (ROOT && !document.getElementById(el.id)) {
    ROOT.appendChild(el);
    el.disabled = disableAll;
  }
}


function replaceAll(newStyles) {
  const oldStyles = Array.prototype.slice.call(
    document.querySelectorAll(`STYLE.stylus[id^="${ID_PREFIX}"]`));
  oldStyles.forEach(el => (el.id += '-ghost'));
  styleElements.clear();
  disabledElements.clear();
  retiredStyleTimers.clear();
  applyStyles(newStyles);
  oldStyles.forEach(el => el.remove());
}


function initDocRewriteObserver() {
  if (isOwnPage || docRewriteObserver || !styleElements.size) {
    return;
  }
  // re-add styles if we detect documentElement being recreated
  const reinjectStyles = () => {
    ROOT = document.documentElement;
    for (const el of styleElements.values()) {
      addStyleElement(document.importNode(el, true));
    }
  };
  // detect documentElement being rewritten from inside the script
  docRewriteObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.localName == 'html') {
          reinjectStyles();
          return;
        }
      }
    }
  });
  docRewriteObserver.observe(document, {childList: true});
  // detect dynamic iframes rewritten after creation by the embedder i.e. externally
  setTimeout(() => document.documentElement != ROOT && reinjectStyles());
}


function orphanCheck() {
  const port = chrome.runtime.connect();
  if (port) {
    port.disconnect();
    return;
  }

  // we're orphaned due to an extension update
  // we can detach the mutation observer
  if (docRewriteObserver) {
    docRewriteObserver.disconnect();
  }
  // we can detach event listeners
  window.removeEventListener(chrome.runtime.id, orphanCheck, true);
  // we can't detach chrome.runtime.onMessage because it's no longer connected internally
  // we can destroy our globals in this context to free up memory
  [ // functions
    'addStyleElement',
    'applyOnMessage',
    'applySections',
    'applyStyles',
    'applyStyleState',
    'doDisableAll',
    'initDocRewriteObserver',
    'orphanCheck',
    'removeStyle',
    'replaceAll',
    'requestStyles',
    // variables
    'ROOT',
    'disabledElements',
    'retiredStyleTimers',
    'styleElements',
    'docRewriteObserver',
  ].forEach(fn => (window[fn] = null));
}
