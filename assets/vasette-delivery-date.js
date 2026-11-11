/*
 * Flowers Vasette: the cart page's delivery / collection date picker.
 *
 * Reads the JSON the vasette-delivery-date section renders: the delivery calendar the phone orders app publishes
 * from its Settings (delivery days, time windows, store hours, closed dates) and each cart product's own rules
 * (Delivery off periods, off weekdays, notice needed). Days that can't be chosen are greyed out, with the reason.
 * The choice is saved as cart attributes with the same names the phone orders app uses, so packing slips, cards,
 * HubSpot and the app treat online orders like phone orders:
 *   Delivery method ("Delivery" / "Collection"), Delivery date (YYYY-MM-DD), Delivery time, Collection store.
 * In the cart: Delivery and Collection buttons; each opens a dialog with the calendar, the time (and the store).
 * Checkout buttons wait until a date that can be used is confirmed.
 *
 * The rules (VasetteDeliveryRules below) are the same as the app's (src/lib/product-dates.ts, schedule.ts);
 * the app's tests run this file against its own checks. No build step: plain browser JavaScript.
 */
(function (root) {
  "use strict";

  // ---- the rules (no DOM) -----------------------------------------------------------------------------

  var WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  var SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var YMD = /^\d{4}-\d{2}-\d{2}$/;

  function isDate(v) {
    return typeof v === "string" && YMD.test(v) && !isNaN(Date.parse(v + "T00:00:00Z"));
  }
  function weekdayOf(date) {
    if (!isDate(date)) return null;
    return WEEKDAYS[(new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7];
  }
  function addDays(date, days) {
    var d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function shortDate(date) {
    if (!isDate(date)) return date || "no date";
    var d = new Date(date + "T00:00:00Z");
    return SHORT_DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }
  function toMinutes(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(hm || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }
  /** Today in Melbourne (YYYY-MM-DD) and the minutes since midnight there. */
  function melbourneNow(now) {
    var at = now || new Date();
    var today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(at);
    var parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
    var h = 0;
    var m = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour") h = Number(parts[i].value) % 24;
      if (parts[i].type === "minute") m = Number(parts[i].value);
    }
    return { today: today, minutes: h * 60 + m };
  }
  function weekdayFromName(name) {
    var n = String(name || "").trim().toLowerCase();
    for (var i = 0; i < WEEKDAYS.length; i++) if (WEEKDAYS[i] === n || DAY_NAMES[WEEKDAYS[i]].toLowerCase() === n) return WEEKDAYS[i];
    return null;
  }

  /** The cart's products as the section renders them, cleaned up (bad dates dropped, weekday names read). */
  function cleanProducts(list) {
    var out = [];
    var seen = {};
    (list || []).forEach(function (p) {
      var id = String(p.productId || "");
      if (!id || seen[id]) return;
      seen[id] = true;
      var periods = [];
      (p.offPeriods || []).forEach(function (x) {
        var from = String((x && x.from) || "").trim();
        var to = String((x && x.to) || "").trim() || from;
        if (!isDate(from) || !isDate(to)) return;
        periods.push({ name: String(x.name || "").trim(), from: from <= to ? from : to, to: from <= to ? to : from });
      });
      var days = [];
      (p.offWeekdays || []).forEach(function (n) {
        var d = weekdayFromName(n);
        if (d && days.indexOf(d) < 0) days.push(d);
      });
      var notice = Math.trunc(Number(p.noticeDays || 0));
      out.push({ productId: id, title: String(p.title || ""), offPeriods: periods, offWeekdays: days, noticeDays: isFinite(notice) && notice > 0 ? Math.min(notice, 60) : 0 });
    });
    return out;
  }

  /** "gid://shopify/Product/123" or 123 → "123". */
  function productKey(id) {
    var m = /(\d+)$/.exec(String(id || "").trim());
    return m ? m[1] : String(id || "").trim();
  }

  /**
   * The calendar's "Some products" closed dates (from the app's Settings) added to the cart products they name,
   * as off periods named by their reason. Same as the app's orderProductRules.
   */
  function withClosures(products, calendar) {
    var closures = (calendar && calendar.closures) || [];
    return products.map(function (p) {
      var extra = [];
      closures.forEach(function (c) {
        if (c.scope !== "products" || !c.products || c.products.indexOf(productKey(p.productId)) < 0) return;
        if (isDate(c.from) && isDate(c.to)) extra.push({ name: String(c.reason || ""), from: c.from, to: c.to });
      });
      return extra.length ? { productId: p.productId, title: p.title, offPeriods: p.offPeriods.concat(extra), offWeekdays: p.offWeekdays, noticeDays: p.noticeDays } : p;
    });
  }

  /** Same words as the app (product-dates.ts productDateProblem). */
  function productProblem(rule, date, today) {
    if (!isDate(date)) return null;
    for (var i = 0; i < rule.offPeriods.length; i++) {
      var p = rule.offPeriods[i];
      if (date >= p.from && date <= (p.to || p.from)) {
        var when = p.name || (p.to && p.to !== p.from ? shortDate(p.from) + " to " + shortDate(p.to) : "");
        return rule.title + " isn't available on " + shortDate(date) + (when ? " (" + when + ")" : "");
      }
    }
    var day = weekdayOf(date);
    if (day && rule.offWeekdays.indexOf(day) >= 0) return rule.title + " isn't available on " + DAY_NAMES[day] + "s";
    if (rule.noticeDays > 0) {
      var earliest = addDays(today, rule.noticeDays);
      if (date < earliest) return rule.title + " needs " + rule.noticeDays + " " + (rule.noticeDays === 1 ? "day's" : "days'") + " notice (" + shortDate(earliest) + " at the earliest)";
    }
    return null;
  }

  function findStore(calendar, name) {
    var stores = (calendar && calendar.collection && calendar.collection.stores) || [];
    for (var i = 0; i < stores.length; i++) if (stores[i].name === name) return stores[i];
    return null;
  }

  /** The time windows offered on a day (each marked passed or not), before any product rules. */
  function windowsFor(calendar, method, storeName, date, clock) {
    var day = weekdayOf(date);
    if (!day || !calendar) return [];
    var list = [];
    if (method === "collection") {
      var store = findStore(calendar, storeName);
      list = store && store.windows && store.windows[day] ? store.windows[day] : [];
    } else {
      list = (calendar.delivery && calendar.delivery.windows) || [];
    }
    return list.map(function (w) {
      var passed = date < clock.today || (date === clock.today && toMinutes(w.to) <= clock.minutes);
      return { from: w.from, to: w.to, label: w.label, passed: passed };
    });
  }

  /**
   * Can this day be chosen? { ok, reason }. The company calendar first (as the app's dayStatus), then each
   * product's own rules. Today only while one of its time windows hasn't ended.
   */
  function dayCheck(calendar, products, method, storeName, date, clock) {
    if (!isDate(date)) return { ok: false, reason: "Choose a date" };
    if (!calendar || calendar.version !== 1) return { ok: false, reason: "Dates can't be shown right now" };
    if (date < clock.today) return { ok: false, reason: "That date has passed" };
    var day = weekdayOf(date);
    var closures = calendar.closures || [];
    if (method === "collection") {
      var store = findStore(calendar, storeName);
      if (!store) return { ok: false, reason: "Choose a collection store" };
      for (var i = 0; i < closures.length; i++) {
        var c = closures[i];
        if (date < c.from || date > c.to) continue;
        if (c.scope === "all" || (c.scope === "collection" && (!c.stores || !c.stores.length || c.stores.indexOf(store.name) >= 0))) {
          return { ok: false, reason: store.name + " is closed" + (c.reason ? " · " + c.reason : "") };
        }
      }
      if (!store.hours || !store.hours[day] || !store.hours[day].open) return { ok: false, reason: store.name + " is closed on " + DAY_NAMES[day] + "s" };
      if (!store.windows || !store.windows[day] || !store.windows[day].length) return { ok: false, reason: store.name + " has no collection times on " + DAY_NAMES[day] + "s" };
    } else {
      for (var j = 0; j < closures.length; j++) {
        var d = closures[j];
        if (date >= d.from && date <= d.to && (d.scope === "all" || d.scope === "delivery")) return { ok: false, reason: "No deliveries" + (d.reason ? " · " + d.reason : "") };
      }
      if (!calendar.delivery || !calendar.delivery.days || !calendar.delivery.days[day]) return { ok: false, reason: "No deliveries on " + DAY_NAMES[day] + "s" };
      if (!calendar.delivery.windows || !calendar.delivery.windows.length) return { ok: false, reason: "No delivery time windows are set up" };
    }
    if (date === clock.today) {
      var left = windowsFor(calendar, method, storeName, date, clock).filter(function (w) {
        return !w.passed;
      });
      if (!left.length) return { ok: false, reason: "Too late for today" };
    }
    for (var k = 0; k < products.length; k++) {
      var problem = productProblem(products[k], date, clock.today);
      if (problem) return { ok: false, reason: problem };
    }
    return { ok: true, reason: "" };
  }

  var Rules = {
    isDate: isDate,
    weekdayOf: weekdayOf,
    addDays: addDays,
    shortDate: shortDate,
    melbourneNow: melbourneNow,
    cleanProducts: cleanProducts,
    withClosures: withClosures,
    productProblem: productProblem,
    windowsFor: windowsFor,
    dayCheck: dayCheck,
  };
  root.VasetteDeliveryRules = Rules;
  if (typeof module !== "undefined" && module.exports) module.exports = Rules;


  // ---- the picker (browser only) ------------------------------------------------------------------
  // In the cart: two buttons, Delivery and Collection, and the choice once made ("Delivering on …" · Change).
  // Either button opens a dialog: the store (collection), the calendar and the time. Confirm saves the choice to
  // the cart; Cancel leaves the earlier one as it was.

  if (typeof document === "undefined") return;

  var ATTR = { method: "Delivery method", date: "Delivery date", time: "Delivery time", store: "Collection store" };
  var MONTHS_AHEAD = 6;
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var CHECKOUT = 'button[name="checkout"], input[name="checkout"], a[href^="/checkout"], [data-vdd-checkout]';
  var EXPRESS = ".additional-checkout-buttons, [data-shopify='dynamic-checkout-cart'], shopify-accelerated-checkout-cart";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "on") Object.keys(attrs.on).forEach(function (ev) { node.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function readData(section) {
    var script = section.querySelector("script[data-vdd-data]");
    try {
      return JSON.parse(script ? script.textContent : "{}");
    } catch (e) {
      return {};
    }
  }

  function copy(st) {
    return { method: st.method, store: st.store, date: st.date, time: st.time };
  }

  function Picker(section) {
    this.section = section;
    this.required = section.getAttribute("data-required") !== "false";
    this.message = "";
    this.draft = null; // the dialog's choice while it's open
    this.attach(section);
    this.validateSaved();
  }

  /**
   * Takes in the section's markup: the cart's products and saved choice, or the empty placeholder when there is
   * nothing in the cart (then the picker is hidden and checkout isn't held up).
   */
  Picker.prototype.attach = function (from) {
    var wasEmpty = this.empty;
    this.empty = from.hasAttribute("data-vdd-empty");
    if (from !== this.section) {
      this.closeDialog();
      this.section.innerHTML = from.innerHTML;
      this.section.className = from.className;
    }
    this.section.hidden = this.empty;
    this.mount = this.section.querySelector("[data-vdd-root]");
    this.load(readData(this.section));
    if (!this.state || wasEmpty) {
      var a = this.data.attributes || {};
      this.state = {
        method: /^collect/i.test(a[ATTR.method] || "") ? "collection" : a[ATTR.method] ? "delivery" : "",
        store: a[ATTR.store] || "",
        date: isDate(a[ATTR.date]) ? a[ATTR.date] : "",
        time: a[ATTR.time] || "",
      };
    }
    this.render();
  };

  Picker.prototype.load = function (data) {
    this.data = data || {};
    this.calendar = this.data.calendar || null;
    this.products = withClosures(cleanProducts(this.data.products), this.calendar);
  };

  Picker.prototype.stores = function () {
    return (this.calendar && this.calendar.collection && this.calendar.collection.stores) || [];
  };

  Picker.prototype.check = function (st, date) {
    return dayCheck(this.calendar, this.products, st.method || "delivery", st.store, date, melbourneNow());
  };

  Picker.prototype.windows = function (st) {
    if (!st.date) return [];
    return windowsFor(this.calendar, st.method || "delivery", st.store, st.date, melbourneNow()).filter(function (w) { return !w.passed; });
  };

  /** A complete choice: a method, a date that can be used and, for collection, a store and a time. */
  Picker.prototype.complete = function (st) {
    if (!st.method || !st.date || !this.check(st, st.date).ok) return false;
    var offered = this.windows(st).some(function (w) { return w.label === st.time; });
    if (st.method === "collection") return !!st.store && offered;
    return !st.time || offered;
  };

  /** Ready for checkout: the confirmed choice is complete. */
  Picker.prototype.ready = function () {
    return this.complete(this.state);
  };

  Picker.prototype.save = function () {
    var s = this.state;
    var attributes = {};
    attributes[ATTR.method] = s.method === "collection" ? "Collection" : s.method === "delivery" ? "Delivery" : "";
    attributes[ATTR.date] = s.date;
    attributes[ATTR.time] = s.time;
    attributes[ATTR.store] = s.method === "collection" ? s.store : "";
    var self = this;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(function () {
      fetch((root.Shopify && root.Shopify.routes && root.Shopify.routes.root ? root.Shopify.routes.root : "/") + "cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ attributes: attributes }),
      }).catch(function () {
        self.message = "Your date couldn't be saved. Check your connection and choose it again.";
        self.render();
      });
    }, 150);
  };

  /** After the cart changes: a date that a new product rules out is cleared, with the reason. */
  Picker.prototype.validateSaved = function () {
    if (this.empty || !this.state.date) return;
    var c = this.check(this.state, this.state.date);
    if (!c.ok) {
      this.message = shortDate(this.state.date) + " can't be used any more: " + c.reason + ". Please choose another date.";
      this.state.date = "";
      this.state.time = "";
      this.render();
      this.save();
    }
  };

  /** What's chosen, in words. */
  Picker.prototype.summary = function (st) {
    var when = shortDate(st.date) + (st.time ? ", " + st.time : "");
    return st.method === "collection" ? "Collecting from " + st.store + " on " + when : "Delivering on " + when;
  };

  // ---- in the cart ----

  Picker.prototype.render = function () {
    var self = this;
    var s = this.state;
    var mount = this.mount;
    if (this.empty || !mount) {
      this.updateCheckout();
      return;
    }
    mount.innerHTML = "";
    if (!this.calendar) {
      mount.appendChild(el("p", { class: "vdd-note", text: "Delivery dates aren't available right now. Please call us to arrange your order." }));
      this.updateCheckout();
      return;
    }
    var done = this.ready();
    var choice = function (method, label) {
      return el("button", {
        type: "button",
        class: "vdd-choice",
        "aria-pressed": String(done && s.method === method),
        "aria-haspopup": "dialog",
        text: label,
        on: { click: function () { self.openDialog(method); } },
      });
    };
    var buttons = [choice("delivery", "Delivery")];
    if (this.stores().length) buttons.push(choice("collection", "Collection"));
    mount.appendChild(el("div", { class: "vdd-choices" }, buttons));
    if (done) {
      mount.appendChild(
        el("p", { class: "vdd-summary" }, [
          el("span", { text: this.summary(s) }),
          el("button", { type: "button", class: "vdd-change", text: "Change", on: { click: function () { self.openDialog(s.method); } } }),
        ]),
      );
    }
    if (this.message) mount.appendChild(el("p", { class: "vdd-message", role: "alert", text: this.message }));
    this.updateCheckout();
  };

  // ---- the dialog ----

  Picker.prototype.openDialog = function (method) {
    var s = this.state;
    var stores = this.stores();
    // Start from what's chosen if it's the same method; a new method starts afresh.
    this.draft = s.method === method ? copy(s) : { method: method, store: method === "collection" && stores.length === 1 ? stores[0].name : "", date: "", time: "" };
    if (method === "collection" && !this.draft.store && stores.length === 1) this.draft.store = stores[0].name;
    this.month = (this.draft.date || melbourneNow().today).slice(0, 7);
    this.dialogMessage = "";
    if (!this.dialog || !this.dialog.isConnected) {
      var self = this;
      this.dialog = el("dialog", { class: "vdd-dialog", "aria-labelledby": "vdd-dialog-title" });
      this.dialog.addEventListener("close", function () { self.draft = null; });
      this.dialog.addEventListener("click", function (e) {
        if (e.target === self.dialog) self.closeDialog(); // a click on the backdrop
      });
      this.section.appendChild(this.dialog);
    }
    this.renderDialog();
    if (typeof this.dialog.showModal === "function") this.dialog.showModal();
    else this.dialog.setAttribute("open", "");
    var first = this.dialog.querySelector(".vdd-day.is-selected, select, .vdd-day:not(.is-off)");
    if (first) first.focus();
  };

  Picker.prototype.closeDialog = function () {
    if (!this.dialog) return;
    if (typeof this.dialog.close === "function" && this.dialog.open) this.dialog.close();
    else this.dialog.removeAttribute("open");
    this.draft = null;
  };

  /** A change in the dialog: a time (or date) that no longer fits goes. */
  Picker.prototype.setDraft = function (patch) {
    var d = this.draft;
    Object.keys(patch).forEach(function (k) { d[k] = patch[k]; });
    if (d.date && !this.check(d, d.date).ok) d.date = "";
    var labels = this.windows(d).map(function (w) { return w.label; });
    if (d.time && labels.indexOf(d.time) < 0) d.time = "";
    this.dialogMessage = "";
    this.renderDialog();
  };

  Picker.prototype.confirm = function () {
    if (!this.draft || !this.complete(this.draft)) return;
    this.state = copy(this.draft);
    this.message = "";
    this.closeDialog();
    this.render();
    this.save();
  };

  Picker.prototype.renderDialog = function () {
    var self = this;
    var d = this.draft;
    var dialog = this.dialog;
    if (!dialog || !d) return;
    dialog.innerHTML = "";
    var collection = d.method === "collection";
    var stores = this.stores();
    var body = [];

    if (collection) {
      var select = el("select", { class: "vdd-select", "aria-label": "Collection store", on: { change: function (e) { self.setDraft({ store: e.target.value }); } } }, [el("option", { value: "", text: "Choose a store" })]);
      stores.forEach(function (st) { select.appendChild(el("option", { value: st.name, selected: st.name === d.store, text: st.name + (st.address ? " · " + st.address : "") })); });
      body.push(el("label", { class: "vdd-field" }, [el("span", { class: "vdd-label", text: "Store" }), select]));
    }
    if (collection && !d.store) body.push(el("p", { class: "vdd-note", text: "Choose a store to see its collection days." }));
    else body.push(this.renderMonth());

    if (d.date) {
      var time = el("select", { class: "vdd-select", "aria-label": "Time", on: { change: function (e) { self.setDraft({ time: e.target.value }); } } }, [
        el("option", { value: "", text: collection ? "Choose a time" : "Any time" }),
      ]);
      this.windows(d).forEach(function (w) { time.appendChild(el("option", { value: w.label, selected: w.label === d.time, text: w.label })); });
      body.push(el("label", { class: "vdd-field" }, [el("span", { class: "vdd-label", text: collection ? "Collection time" : "Delivery time" }), time]));
    }
    if (this.dialogMessage) body.push(el("p", { class: "vdd-message", role: "alert", text: this.dialogMessage }));

    var ok = this.complete(d);
    var hint = !d.date ? (collection && !d.store ? "Choose a store" : "Choose a date") : collection && !d.time ? "Choose a time" : this.summary(d);
    dialog.appendChild(
      el("div", { class: "vdd-dialog-inner" }, [
        el("div", { class: "vdd-dialog-head" }, [
          el("h2", { id: "vdd-dialog-title", class: "vdd-dialog-title", text: collection ? "Collection" : "Delivery" }),
          el("button", { type: "button", class: "vdd-close", "aria-label": "Close", text: "×", on: { click: function () { self.closeDialog(); } } }),
        ]),
        el("div", { class: "vdd-dialog-body" }, body),
        el("div", { class: "vdd-dialog-foot" }, [
          el("p", { class: "vdd-hint" + (ok ? " is-ready" : ""), text: hint }),
          el("div", { class: "vdd-actions" }, [
            el("button", { type: "button", class: "vdd-secondary", text: "Cancel", on: { click: function () { self.closeDialog(); } } }),
            el("button", { type: "button", class: "vdd-primary", disabled: !ok, text: "Confirm", on: { click: function () { self.confirm(); } } }),
          ]),
        ]),
      ]),
    );
  };

  Picker.prototype.renderMonth = function () {
    var self = this;
    var d = this.draft;
    var clock = melbourneNow();
    var month = this.month;
    var first = month + "-01";
    var minMonth = clock.today.slice(0, 7);
    var maxMonth = addDays(clock.today, 31 * MONTHS_AHEAD).slice(0, 7);
    var start = new Date(first + "T00:00:00Z");
    var title = MONTH_NAMES[start.getUTCMonth()] + " " + start.getUTCFullYear();
    var step = function (n) {
      var x = new Date(first + "T00:00:00Z");
      x.setUTCMonth(x.getUTCMonth() + n);
      return x.toISOString().slice(0, 7);
    };
    var head = el("div", { class: "vdd-head" }, [
      el("button", { type: "button", class: "vdd-nav", "aria-label": "Previous month", disabled: month <= minMonth, text: "‹", on: { click: function () { self.month = step(-1); self.renderDialog(); } } }),
      el("span", { class: "vdd-title", text: title }),
      el("button", { type: "button", class: "vdd-nav", "aria-label": "Next month", disabled: month >= maxMonth, text: "›", on: { click: function () { self.month = step(1); self.renderDialog(); } } }),
    ]);
    var grid = el("div", { class: "vdd-grid", role: "grid", "aria-label": title });
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (n) { grid.appendChild(el("span", { class: "vdd-dow", text: n })); });
    var lead = (start.getUTCDay() + 6) % 7;
    for (var i = 0; i < lead; i++) grid.appendChild(el("span", { class: "vdd-pad" }));
    for (var day = first; day.slice(0, 7) === month; day = addDays(day, 1)) {
      (function (date) {
        var c = self.check(d, date);
        var selected = date === d.date;
        grid.appendChild(
          el("button", {
            type: "button",
            class: "vdd-day" + (selected ? " is-selected" : "") + (date === clock.today ? " is-today" : "") + (c.ok ? "" : " is-off"),
            // Blocked days stay tappable so phones (no hover) can show why.
            "aria-disabled": c.ok ? false : "true",
            "aria-pressed": String(selected),
            "aria-label": shortDate(date) + (c.ok ? "" : ": " + c.reason),
            title: c.ok ? shortDate(date) : c.reason,
            text: String(Number(date.slice(8))),
            on: {
              click: function () {
                if (c.ok) return self.setDraft({ date: date });
                self.dialogMessage = shortDate(date) + ": " + c.reason + ".";
                self.renderDialog();
              },
            },
          }),
        );
      })(day);
    }
    return el("div", { class: "vdd-month" }, [head, grid]);
  };

  // ---- checkout ----

  /** Checkout waits for a confirmed choice; express checkout buttons are hidden until then. */
  Picker.prototype.updateCheckout = function () {
    if (!this.required || !this.section.isConnected) return;
    var ok = this.empty || this.ready();
    document.querySelectorAll(CHECKOUT).forEach(function (b) {
      if (ok) {
        b.removeAttribute("aria-disabled");
        b.classList.remove("vdd-blocked");
      } else {
        b.setAttribute("aria-disabled", "true");
        b.classList.add("vdd-blocked");
      }
    });
    document.querySelectorAll(EXPRESS).forEach(function (x) { x.style.display = ok ? "" : "none"; });
  };

  /** The picker on the page now (themes like Horizon redraw the cart, replacing it), or null. */
  function activePicker() {
    var list = document.querySelectorAll("[data-vdd-section]");
    for (var i = 0; i < list.length; i++) if (list[i].__vdd && list[i].__vdd.required) return list[i].__vdd;
    return null;
  }

  /** One guard for the page: a checkout click or submit waits until the picker on the page is ready. */
  function guardCheckout() {
    var stop = function (e) {
      var target = e.target && e.target.closest ? e.target.closest(CHECKOUT) : null;
      if (e.type === "submit") target = e.submitter && e.submitter.matches && e.submitter.matches(CHECKOUT) ? e.submitter : null;
      var self = activePicker();
      if (!target || !self || self.empty || self.ready()) return;
      e.preventDefault();
      e.stopPropagation();
      self.message = self.stores().length ? "Please choose Delivery or Collection, and a date, first." : "Please choose a delivery date first.";
      self.render();
      self.section.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    document.addEventListener("click", stop, true);
    document.addEventListener("submit", stop, true);
  }

  /** Re-reads the cart's products (the section, re-rendered by Shopify) after the cart changes. */
  Picker.prototype.refresh = function () {
    var self = this;
    var id = this.section.getAttribute("data-section-id");
    if (!id) return;
    fetch(window.location.pathname + "?section_id=" + encodeURIComponent(id))
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var tmp = document.createElement("div");
        tmp.innerHTML = html;
        var fresh = tmp.querySelector("[data-vdd-section]");
        if (!fresh) return;
        self.attach(fresh);
        self.validateSaved();
      })
      .catch(function () {});
  };

  /**
   * Starts a picker on each new copy of the section. A copy the theme drew after a cart change comes with the
   * cart's latest attributes, so the customer's choice carries over.
   */
  function start() {
    document.querySelectorAll("[data-vdd-section]").forEach(function (section) {
      if (section.__vdd) return;
      section.setAttribute("data-vdd-started", "");
      section.__vdd = new Picker(section);
    });
  }
  function refreshAll() {
    document.querySelectorAll("[data-vdd-section]").forEach(function (section) {
      if (section.__vdd) section.__vdd.refresh();
    });
  }
  root.VasetteDeliveryDate = { start: start, refresh: refreshAll };
  guardCheckout();
  // Themes announce cart changes differently: Dawn's pub/sub, Horizon's cart:update, and the common custom events.
  if (typeof root.subscribe === "function" && root.PUB_SUB_EVENTS && root.PUB_SUB_EVENTS.cartUpdate) root.subscribe(root.PUB_SUB_EVENTS.cartUpdate, refreshAll);
  ["cart:update", "cart:updated", "cart:change", "cart:refresh", "cart-drawer:refresh"].forEach(function (n) { document.addEventListener(n, refreshAll); });
  // Themes that redraw the cart (Horizon) put a fresh copy of the picker in the page: start it.
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(function () {
      if (document.querySelector("[data-vdd-section]:not([data-vdd-started])")) start();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  // Today's windows close as the day goes on.
  setInterval(function () {
    document.querySelectorAll("[data-vdd-section]").forEach(function (section) {
      var p = section.__vdd;
      if (p && !p.empty) {
        p.validateSaved();
        p.render();
        if (p.draft) p.renderDialog();
      }
    });
  }, 5 * 60 * 1000);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
