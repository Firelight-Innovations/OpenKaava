/**
 * The Design Mode probe: the shell's eyes and ears inside a page it does not own.
 *
 * Adapted from `src/main/browser/grab-guest-script.ts` in `stablyai/orca`
 * (MIT, (c) Stably AI). The element-selection and extraction approach — a
 * full-viewport click catcher in a closed shadow root, `elementFromPoint` with
 * the catcher briefly disabled, and a budgeted payload rather than a whole
 * document — is theirs. The transport is not: Orca injects per call over
 * Electron's `executeJavaScript` and returns a value; there is no such call
 * across a same-origin boundary here, so this is installed once by
 * `devtools::install_script` and answers over `postMessage`.
 *
 * A `.js` file rather than a string literal in `design.rs`, so that the browser
 * code in this repository that is hardest to get right is the one piece of it a
 * formatter and a linter can still read. `include_str!` is what puts it in the
 * binary.
 *
 * Three things about where this runs decide everything below.
 *
 * It runs in **every** frame the webview loads, the shell's own included, and
 * before any of that frame's code. So it must cost nothing until spoken to: one
 * listener, one shape check, no DOM.
 *
 * It runs in a document that may be **hostile**. Nothing here trusts the page —
 * but nothing here can be hidden from it either, so this is not a sandbox and
 * must not be read as one. What keeps a page from turning the probe on itself
 * is that arming is only accepted from the frame's own parent, and that the top
 * frame never arms at all.
 *
 * It runs **cross-origin**, which is why every reply goes to `"*"`. A child
 * cannot read its parent's origin, so it cannot name one. The reply is the
 * page's own DOM going to the frame that deliberately embedded the page, which
 * is the one party already able to see it.
 */
(function () {
  "use strict";

  // The top frame is the shell's own window. It has no parent to be armed by,
  // and a probe that could be armed there would be a way for an embedded page
  // to read Veistra's interface rather than its own. Leaving before the listener
  // exists is cheaper than checking on every message.
  if (window.parent === window) return;

  var CHANNEL = "veistraDesign";

  /**
   * What a payload may carry. Budgets rather than a whole document, because
   * this ends up in an agent's prompt: an unbounded `outerHTML` is a page's
   * entire markup pasted into a context window.
   */
  var BUDGET = {
    html: 4096,
    text: 200,
    selector: 700,
    path: 900,
    attribute: 500,
    classes: 300,
    ancestors: 10,
  };

  /**
   * Attributes worth sending. An allow-list rather than a deny-list: the names
   * that identify an element are few and known, and everything else on a page
   * this shell did not write is an unknown of some author's invention. `aria-*`
   * is allowed as a family.
   */
  var SAFE_ATTRS = [
    "id",
    "class",
    "name",
    "type",
    "role",
    "href",
    "src",
    "alt",
    "title",
    "placeholder",
    "for",
    "action",
    "method",
    "value",
  ];

  /**
   * A value naming any of these is replaced rather than sent. Design Mode's
   * output goes into a prompt and a prompt goes to a model over somebody's
   * network, so a session token sitting in a `data-` attribute of the element
   * somebody clicked is a leak with a long tail. Matching on the name is crude
   * and caught by neither half — Rust re-runs it in `design.rs` for the case
   * where this frame is the thing that has been compromised.
   */
  var SECRETS = [
    "access_token",
    "auth_token",
    "api_key",
    "apikey",
    "client_secret",
    "session_id",
    "sessionid",
    "csrf",
    "secret",
    "password",
    "passwd",
    "bearer",
  ];

  /**
   * The computed properties reported, and the list is deliberately short.
   * `getComputedStyle` resolves several hundred, almost all of them the initial
   * value; the ones here are what somebody asking "why does this look wrong"
   * actually reads.
   */
  var STYLE_PROPS = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "color",
    "background-color",
    "border",
    "border-radius",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "text-align",
    "opacity",
    "z-index",
  ];

  var SAFE_PROTOCOLS = ["http:", "https:"];

  var state = null;

  // --- text and value handling ------------------------------------------------

  function clamp(value, max) {
    var text = typeof value === "string" ? value : "";
    return text.length <= max ? text : text.slice(0, max) + " … (truncated)";
  }

  function looksSecret(value) {
    var lower = String(value || "").toLowerCase();
    for (var i = 0; i < SECRETS.length; i += 1) {
      if (lower.indexOf(SECRETS[i]) !== -1) return true;
    }
    return false;
  }

  /** A URL with its query and fragment removed — that is where tokens ride. */
  function safeUrl(raw) {
    try {
      var url = new URL(raw, window.location.href);
      if (SAFE_PROTOCOLS.indexOf(url.protocol) === -1) return "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      // A URL that will not parse could still be a `javascript:` one, so the
      // raw string is dropped rather than passed through.
      return "";
    }
  }

  function textOf(element, max) {
    var raw;
    try {
      raw = element.textContent || "";
    } catch {
      return "";
    }
    return clamp(raw.replace(/\s+/g, " ").trim(), max);
  }

  // --- naming an element ------------------------------------------------------

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  /**
   * Whether a class name is worth putting in a selector. A build tool's hashed
   * class is unique to one build and useless in a prompt, so `css-1a2b3c` and
   * anything that reads like a digest are dropped.
   */
  function stableClasses(element, max) {
    var out = [];
    var list = element.classList || [];
    for (var i = 0; i < list.length && out.length < max; i += 1) {
      var name = list[i];
      if (!name || name.length > 60 || looksSecret(name)) continue;
      if (/^css-[a-z0-9]+$/i.test(name)) continue;
      if (/^[A-Za-z0-9_-]{12,}$/.test(name) && /\d/.test(name) && /[A-Z]/.test(name)) continue;
      out.push(name);
    }
    return out;
  }

  function selectorPart(element) {
    var tag = element.tagName.toLowerCase();
    if (element.id && !looksSecret(element.id)) return tag + "#" + escapeIdent(element.id);
    var classes = stableClasses(element, 2);
    if (classes.length === 0) return tag;
    return (
      tag +
      classes
        .map(function (name) {
          return "." + escapeIdent(name);
        })
        .join("")
    );
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function nthOfType(element) {
    var index = 1;
    var sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    return index > 1 ? ":nth-of-type(" + index + ")" : "";
  }

  /**
   * The shortest selector that still resolves to this element and nothing else,
   * built from the element upwards and stopped as soon as it is unique.
   */
  function buildSelector(element) {
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1 && parts.length < BUDGET.ancestors) {
      var part = selectorPart(current);
      if (!isUnique([part].concat(parts).join(" > "))) part += nthOfType(current);
      parts.unshift(part);
      var selector = parts.join(" > ");
      if (isUnique(selector)) return clamp(selector, BUDGET.selector);
      current = current.parentElement;
    }
    return clamp(parts.join(" > ") || element.tagName.toLowerCase(), BUDGET.selector);
  }

  function ancestorPath(element) {
    var path = [];
    var current = element.parentElement;
    while (current && current !== document.documentElement && path.length < BUDGET.ancestors) {
      var tag = current.tagName.toLowerCase();
      var role = current.getAttribute("role");
      path.push(role ? tag + "[role=" + role + "]" : tag);
      current = current.parentElement;
    }
    return clamp(path.reverse().join(" > "), BUDGET.path);
  }

  // --- what a click produces --------------------------------------------------

  function attributesOf(element) {
    var out = {};
    var attrs = element.attributes || [];
    for (var i = 0; i < attrs.length; i += 1) {
      var name = attrs[i].name.toLowerCase();
      if (SAFE_ATTRS.indexOf(name) === -1 && name.indexOf("aria-") !== 0) continue;
      var value = attrs[i].value;
      if (looksSecret(name) || looksSecret(value)) out[name] = "[redacted]";
      else if (name === "href" || name === "src" || name === "action") out[name] = safeUrl(value);
      else if (name === "class") out[name] = clamp(value, BUDGET.classes);
      else out[name] = clamp(value, BUDGET.attribute);
    }
    return out;
  }

  function stylesOf(element) {
    var computed = window.getComputedStyle(element);
    var out = {};
    for (var i = 0; i < STYLE_PROPS.length; i += 1) {
      out[STYLE_PROPS[i]] = computed.getPropertyValue(STYLE_PROPS[i]) || "";
    }
    return out;
  }

  /** `outerHTML`, with any script the element contains taken out first. */
  function htmlOf(element) {
    var clone;
    try {
      clone = element.cloneNode(true);
    } catch {
      return "";
    }
    var scripts = clone.querySelectorAll ? clone.querySelectorAll("script") : [];
    for (var i = 0; i < scripts.length; i += 1) scripts[i].remove();
    return clamp(clone.outerHTML || "", BUDGET.html);
  }

  function describe(element) {
    var rect = element.getBoundingClientRect();
    return {
      page: {
        url: safeUrl(window.location.href),
        title: clamp(document.title || "", BUDGET.text),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      target: {
        tagName: element.tagName.toLowerCase(),
        selector: buildSelector(element),
        ancestors: ancestorPath(element),
        text: textOf(element, BUDGET.text),
        html: htmlOf(element),
        attributes: attributesOf(element),
        styles: stylesOf(element),
        // In this frame's own coordinates. Turning that into somewhere on the
        // screen is the embedding frame's job, because only it knows where this
        // one was put; see `useCapture` in the app.
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      },
    };
  }

  // --- the overlay ------------------------------------------------------------

  /**
   * A full-viewport catcher that takes the pointer events, plus a closed shadow
   * root holding the highlight it draws.
   *
   * Catching rather than listening on `document` is what stops the selecting
   * click also being a click on the page — the point of Design Mode is to pick
   * a button, not to press it. The shadow root is closed so that the page
   * cannot reach in and rewrite what the person is being shown.
   */
  function buildOverlay() {
    var host = document.createElement("div");
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;";
    var shadow = host.attachShadow({ mode: "closed" });

    var box = document.createElement("div");
    box.style.cssText =
      "position:fixed;display:none;pointer-events:none;border:2px solid rgba(255,255,255,0.92);" +
      "border-radius:3px;background:rgba(90,160,255,0.14);" +
      "box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 2px 10px rgba(0,0,0,0.25);";
    shadow.appendChild(box);

    var label = document.createElement("div");
    label.style.cssText =
      "position:fixed;display:none;pointer-events:none;max-width:320px;overflow:hidden;" +
      "white-space:nowrap;text-overflow:ellipsis;padding:3px 8px;border-radius:4px;" +
      "background:rgba(24,24,27,0.94);color:#e7e7ea;" +
      "font:11px/1.4 ui-sans-serif,system-ui,sans-serif;" +
      "box-shadow:0 2px 8px rgba(0,0,0,0.35);";
    shadow.appendChild(label);

    document.documentElement.appendChild(host);
    return { host: host, box: box, label: label };
  }

  function labelFor(element, rect) {
    var parts = [element.tagName.toLowerCase()];
    var role = element.getAttribute("role");
    if (role) parts.push("role=" + role);
    var text = textOf(element, 40);
    if (text) parts.push('"' + text + '"');
    parts.push(Math.round(rect.width) + "×" + Math.round(rect.height));
    return parts.join("  ");
  }

  function highlight(element) {
    if (!state) return;
    if (!element || element === document.documentElement || element === document.body) {
      state.current = null;
      state.box.style.display = "none";
      state.label.style.display = "none";
      return;
    }
    state.current = element;
    var rect = element.getBoundingClientRect();
    state.box.style.left = rect.x + "px";
    state.box.style.top = rect.y + "px";
    state.box.style.width = rect.width + "px";
    state.box.style.height = rect.height + "px";
    state.box.style.display = "block";

    state.label.textContent = labelFor(element, rect);
    var below = rect.bottom + 6;
    state.label.style.left = Math.max(4, rect.x) + "px";
    state.label.style.top = (below + 28 > window.innerHeight ? rect.top - 28 : below) + "px";
    state.label.style.display = "block";
  }

  /** What is under the pointer, with the catcher briefly out of the way. */
  function elementUnder(x, y) {
    state.host.style.pointerEvents = "none";
    var found = document.elementFromPoint(x, y);
    state.host.style.pointerEvents = "auto";
    return found;
  }

  function onMove(event) {
    var found = elementUnder(event.clientX, event.clientY);
    if (found) highlight(found);
  }

  /**
   * Every pointer event the catcher eats, and only the last of them picks.
   *
   * Swallowing the whole sequence rather than `click` alone is what makes
   * picking safe on a page that does something. A button reacts to
   * `pointerdown` long before a click completes, and a page that navigated,
   * submitted or deleted something because somebody pointed at it in order to
   * describe it would make this feature unusable on exactly the pages it is
   * for.
   */
  var SWALLOWED = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"];

  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    swallow(event);
    if (!state || !state.current) return;
    var payload;
    try {
      payload = describe(state.current);
    } catch (failure) {
      reply({ kind: "failed", reason: String((failure && failure.message) || failure) });
      return;
    }
    reply({ kind: "picked", element: payload });
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    reply({ kind: "cancelled" });
    // Torn down here rather than left for the parent to ask for. The overlay is
    // this frame's, and a cancel that takes the crosshair off screen only once
    // a round trip has completed is a cancel that looks broken.
    disarm();
  }

  // --- talking to the frame that embedded this one ----------------------------

  function reply(body) {
    body[CHANNEL] = 1;
    // `"*"`: see the header. The parent's origin is not readable from here.
    window.parent.postMessage(body, "*");
  }

  function arm() {
    // A page that replaced its own document takes the overlay with it while
    // leaving `state` behind, and an early return there would arm nothing and
    // report success. Checking that the host is still in a document is cheaper
    // than listening for every way a page can do that.
    if (state && state.host.isConnected) return;
    if (state) disarm();
    var overlay = buildOverlay();
    state = {
      host: overlay.host,
      box: overlay.box,
      label: overlay.label,
      current: null,
    };
    state.host.addEventListener("mousemove", onMove, true);
    state.host.addEventListener("click", onClick, true);
    for (var i = 0; i < SWALLOWED.length; i += 1) {
      state.host.addEventListener(SWALLOWED[i], swallow, true);
    }
    window.addEventListener("keydown", onKey, true);
    reply({ kind: "armed" });
  }

  function disarm() {
    if (!state) return;
    state.host.removeEventListener("mousemove", onMove, true);
    state.host.removeEventListener("click", onClick, true);
    for (var i = 0; i < SWALLOWED.length; i += 1) {
      state.host.removeEventListener(SWALLOWED[i], swallow, true);
    }
    window.removeEventListener("keydown", onKey, true);
    try {
      state.host.remove();
    } catch {
      // The page replaced the document under us. There is nothing to remove and
      // nothing to report — the listeners went with it.
    }
    state = null;
    reply({ kind: "disarmed" });
  }

  /**
   * Take the highlight off screen, or put it back.
   *
   * The screenshot is of the real window, so an overlay left up is an overlay
   * in the picture. `id` comes back with the acknowledgement because the caller
   * has to know the frame has *painted* without it before it captures.
   */
  function veil(on, id) {
    if (state) state.host.style.display = on ? "none" : "";
    // Two frames, not one: the first is when the style change is committed, the
    // second is after it has been drawn.
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        reply({ kind: "veiled", id: id });
      });
    });
  }

  function onMessage(event) {
    // The only sender that is ever obeyed. A page can post to `window.top` and
    // to any frame it can name, so "who sent this" is the whole of the guard —
    // and it is resolved from the event, never from anything in the message.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data[CHANNEL] !== 1) return;

    if (data.kind === "arm") arm();
    else if (data.kind === "disarm") disarm();
    else if (data.kind === "veil") veil(data.on === true, data.id);
  }

  window.addEventListener("message", onMessage, false);
})();
