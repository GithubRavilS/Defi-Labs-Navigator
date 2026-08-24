/**
 * Hotfix для устаревшего index.html: патчит gviz RWA APY (col 12) и период.
 * Подключается через middleware.js если статика не обновилась.
 */
(function () {
  if (window.__defilabsNavFixV2) return;
  window.__defilabsNavFixV2 = true;

  var COL = { platform: 0, openDate: 3, pair: 9, fee: 11, apy: 12, link: 13 };

  function cell(cells, i) {
    var c = cells[i];
    if (!c) return "";
    if (c.v != null && c.v !== "") return c.v;
    if (c.f != null && c.f !== "") return c.f;
    return "";
  }

  function parseDate(v) {
    if (v == null || v === "") return "";
    var s = String(v);
    var m = s.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+))?/);
    if (!m) return s;
    var y = parseInt(m[1], 10);
    var mo = parseInt(m[2], 10) + 1;
    var d = parseInt(m[3], 10);
    var hh = m[4] != null ? parseInt(m[4], 10) : 0;
    var mm = m[5] != null ? parseInt(m[5], 10) : 0;
    return (
      (d < 10 ? "0" : "") +
      d +
      "." +
      (mo < 10 ? "0" : "") +
      mo +
      "." +
      y +
      " " +
      (hh < 10 ? "0" : "") +
      hh +
      ":" +
      (mm < 10 ? "0" : "") +
      mm
    );
  }

  function periodFrom(openDate) {
    var m = String(openDate || "").match(
      /(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/,
    );
    if (!m) return "";
    var y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    var opened = new Date(
      y,
      parseInt(m[2], 10) - 1,
      parseInt(m[1], 10),
      m[4] ? +m[4] : 0,
      m[5] ? +m[5] : 0,
    );
    var hours = Math.max(0, Math.floor((Date.now() - opened.getTime()) / 3600000));
    if (hours < 72) return hours + " ч";
    return Math.floor(hours / 24) + " дн";
  }

  function parseApy(v) {
    var s = String(v || "")
      .replace(/%/g, "")
      .replace(",", ".");
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function parseRwaRows(payload) {
    var rows = (payload && payload.table && payload.table.rows) || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].c || [];
      var platform = String(cell(cells, COL.platform) || "").trim();
      if (!platform || /^платформа$/i.test(platform)) continue;
      var openDate = parseDate(cell(cells, COL.openDate));
      out.push({
        platform: platform,
        pair: String(cell(cells, COL.pair) || ""),
        apy: String(cell(cells, COL.apy) || ""),
        link: String(cell(cells, COL.link) || ""),
        fee: String(cell(cells, COL.fee) || ""),
        openDate: openDate,
        period: openDate ? periodFrom(openDate) : "",
      });
    }
    return out;
  }

  function patchDomTable() {
    var rows = document.querySelectorAll("#categoryPage tbody tr, .pool-battle-table tbody tr");
    if (!rows.length) return;
    var cache = window.__defilabsRwaCache;
    if (!cache || !cache.length) return;
    var byPair = {};
    cache.forEach(function (r) {
      byPair[(r.platform + "|" + r.pair).toLowerCase()] = r;
    });
    rows.forEach(function (tr) {
      var nameEl = tr.querySelector(".pool-battle-instrument-name, td:first-child");
      var pairEl = tr.querySelector(".pool-battle-pair, td:nth-child(2)");
      if (!nameEl || !pairEl) return;
      var key = (nameEl.textContent.trim() + "|" + pairEl.textContent.trim()).toLowerCase();
      var patch = byPair[key];
      if (!patch || !parseApy(patch.apy)) return;
      var cells = tr.querySelectorAll("td");
      if (cells.length >= 4) {
        if (cells[2].textContent.trim() === "—" || !parseApy(cells[2].textContent))
          cells[2].textContent = parseApy(patch.apy).toFixed(1).replace(".", ",") + "%";
        if (cells[3].textContent.trim() === "—" && patch.period)
          cells[3].textContent = patch.period;
      }
    });
  }

  var g = (window.google = window.google || {});
  g.visualization = g.visualization || {};
  g.visualization.Query = g.visualization.Query || {};
  var _orig = g.visualization.Query.setResponse;
  g.visualization.Query.setResponse = function (payload) {
    try {
      var url = String((payload && payload.version) || "");
      if (payload && payload.table && payload.table.cols) {
        var label = String((payload.table.cols[0] && payload.table.cols[0].label) || "");
        if (/платформа/i.test(label)) {
          window.__defilabsRwaCache = parseRwaRows(payload);
          setTimeout(patchDomTable, 500);
          setTimeout(patchDomTable, 2000);
        }
      }
    } catch (e) {}
    if (typeof _orig === "function") return _orig.apply(this, arguments);
  };

  console.log("DeFi Compass: nav-fix.js v2 loaded");
})();
