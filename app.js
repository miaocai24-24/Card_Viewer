"use strict";

const $ = (sel) => document.querySelector(sel);
// 静态快照模式（GitHub Pages 等）：没有后端，数据一次性读入 data.json，且不可编辑
const STATIC = typeof window.KARUTA_STATIC !== "undefined" && window.KARUTA_STATIC;
const staticData = { cards: [], meta: null, generated_at: null };
const CONDITION_STARS = (n) => (n == null ? "" : "★".repeat(n) + "☆".repeat(4 - n));

const storage = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 隐私模式等情况下不可用，忽略 */
    }
  },
};

const state = {
  meta: null,
  view: "cards",
  layout: storage.get("karuta.layout", "gallery") === "table" ? "table" : "gallery",
  requestSeq: 0,          // 丢弃过期的列表请求结果（快速输入搜索时响应可能乱序）
  owner: "",
  filters: {},            // 下拉框 / 搜索框之外的筛选（来自统计图点击）：series, character, print_min, print_max
  sort: "print_number",
  dir: "asc",
  page: 1,
  pageSize: 50,
  total: 0,
  cards: [],
  selected: new Set(),
};

// ------------------------------------------------------------ 工具

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4000 : 1500);
}

function staticMatches(card, f) {
  const like = (v, q) => String(v ?? "").toLowerCase().includes(q);
  if (f.source && card.source !== f.source) return false;
  // 导出时可能去掉了 Discord 用户 ID，这时卡主用 owner_key 标识
  if (f.owner && String(card.owner_key ?? card.owner_discord_id ?? "") !== String(f.owner)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!like(card.character, q) && !like(card.series, q) && !like(card.card_code, q)) return false;
  }
  if (f.series && card.series !== f.series) return false;
  if (f.character && card.character !== f.character) return false;
  if (f.edition && Number(card.edition) !== Number(f.edition)) return false;
  if (f.condition && Number(card.condition_stars) !== Number(f.condition)) return false;
  if (f.rarity && card.rarity !== f.rarity) return false;
  if (f.limited === "1" && !card.limited) return false;
  if (f.limited === "0" && card.limited !== 0) return false;
  if (f.print_min && !(card.print_number >= Number(f.print_min))) return false;
  if (f.print_max && !(card.print_number <= Number(f.print_max))) return false;
  if (f.tag === "none" ? card.tag != null : f.tag && card.tag !== f.tag) return false;
  if (f.favorite === "1" && !card.favorite) return false;
  if (f.stale === "1" && !card.annotation_stale) return false;
  if (f.missing === "1" ? !card.missing_since : card.missing_since) return false;
  if (f.has_image === "1" && !card.image_url) return false;
  if (f.has_image === "0" && card.image_url) return false;
  return true;
}

function staticQuery(params) {
  const f = Object.fromEntries(params);
  const rows = staticData.cards.filter((c) => staticMatches(c, f));
  const key = f.sort || "print_number";
  const dir = f.dir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return String(a.card_code).localeCompare(String(b.card_code));
    if (x == null) return 1;            // 空值永远排最后（与后端一致）
    if (y == null) return -1;
    if (x === y) return String(a.card_code).localeCompare(String(b.card_code));
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  const size = Number(f.page_size || 50);
  const page = Number(f.page || 1);
  return { cards: rows.slice((page - 1) * size, page * size), total: rows.length };
}

function staticStats(params) {
  const f = Object.fromEntries(params);
  const rows = staticData.cards.filter((c) => staticMatches(c, f));
  const countBy = (fn) => {
    const m = new Map();
    for (const c of rows) {
      const k = fn(c);
      if (k === undefined || k === null) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const tags = countBy((c) => c.tag ?? "__none");
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    total: rows.length,
    series: new Set(rows.map((c) => c.series)).size,
    characters: new Set(rows.map((c) => c.character)).size,
    favorites: rows.filter((c) => c.favorite).length,
    untagged: rows.filter((c) => c.tag == null).length,
    with_images: rows.filter((c) => c.image_url).length,
    stale_annotations: rows.filter((c) => c.annotation_stale).length,
    by_edition: [...countBy((c) => c.edition)].sort((a, b) => a[0] - b[0]).map(([edition, count]) => ({ edition, count })),
    by_condition: [...countBy((c) => c.condition_stars)].sort((a, b) => a[0] - b[0])
      .map(([condition, count]) => ({ condition, name: staticData.meta.condition_names[condition] || String(condition), count })),
    by_rarity: sorted(countBy((c) => c.rarity)).map(([rarity, count]) => ({ rarity, count })),
    by_banner: sorted(countBy((c) => (c.source === "lumina" ? c.banner || "常驻" : undefined)))
      .map(([banner, count]) => ({ banner, limited: banner !== "常驻", count })),
    by_source: sorted(countBy((c) => c.source)).map(([source, count]) => ({ source, count })),
    by_print_tier: staticData.meta.print_tiers.map((t) => ({
      ...t, count: rows.filter((c) => c.print_number >= t.min && (t.max == null || c.print_number <= t.max)).length,
    })),
    by_tag: [...staticData.meta.tags.map((t) => ({ tag: t, count: tags.get(t) || 0 })),
             { tag: null, count: tags.get("__none") || 0 }],
    top_series: sorted(countBy((c) => c.series)).slice(0, 10).map(([series, count]) => ({ series, count })),
  };
}

async function api(path, options = {}) {
  if (STATIC) {
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query || "");
    if (route === "/api/meta") return staticData.meta;
    if (route === "/api/cards") return staticQuery(params);
    if (route === "/api/stats") return staticStats(params);
    throw new Error("静态快照不支持这个操作");
  }
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function currentFilters() {
  const f = { ...state.filters };
  if (state.owner) f.owner = state.owner;
  const q = $("#q").value.trim();
  if (q) f.q = q;
  if ($("#f-edition").value) f.edition = $("#f-edition").value;
  if ($("#f-condition").value) f.condition = $("#f-condition").value;
  if ($("#f-tag").value) f.tag = $("#f-tag").value;
  if ($("#f-source").value) f.source = $("#f-source").value;
  if ($("#f-rarity").value) f.rarity = $("#f-rarity").value;
  if ($("#f-limited").value) f.limited = $("#f-limited").value;
  if ($("#f-image").value) f.has_image = $("#f-image").value;
  if ($("#f-stale").checked) f.stale = "1";
  if ($("#f-missing").checked) f.missing = "1";
  if ($("#f-favorite").checked) f.favorite = "1";
  return f;
}

async function copyText(text, label = text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${label}`);
  } catch {
    toast("复制失败", true);
  }
}

const SOURCE_LABEL = { karuta: "Karuta", lumina: "Lumina" };

function cardLabel(card) {
  return card.source === "lumina" ? `#${card.position}` : card.card_code;
}

function viewCommand(card) {
  return card.source === "lumina" ? `LVIEW ${card.position}` : `k!view ${card.card_code}`;
}

function limitedBadge(card) {
  if (card.source !== "lumina" || !card.limited) return null;
  return el("span", { class: "limited", title: card.banner ? `限定 banner：${card.banner}` : "限定卡" },
    card.banner || "Limited");
}

function missingBadge(card) {
  if (!card.missing_since) return null;
  return el("span", { class: "gone", title: `${new Date(card.missing_since).toLocaleString()} 的完整扫描中，这个位置已不在收藏里` },
    "已离开收藏");
}

function staleBadge(card) {
  if (!card.annotation_stale) return null;
  return el("span", { class: "stale", title: "这个收藏位置上的卡换了，下面的 Tag / 收藏 / 备注可能不对。改动一次即可消除提示" }, "标注待确认");
}

function tagDot(tag) {
  const dot = el("span", { class: "dot" });
  dot.style.background = `var(--tag-${tag || "none"})`;
  return dot;
}

function tagOptions(emptyLabel = "—") {
  return [el("option", { value: "" }, emptyLabel), ...state.meta.tags.map((t) => el("option", { value: t }, t))];
}

function setFavButton(button, favorite, withText = false) {
  button.setAttribute("aria-pressed", favorite ? "true" : "false");
  button.title = favorite ? "取消收藏" : "收藏";
  button.textContent = withText ? (favorite ? "♥ 已收藏" : "♡ 收藏") : favorite ? "♥" : "♡";
}

function cardImage(card, alt) {
  if (!card.image_url) return null;
  return el("img", { src: card.image_url, alt, loading: "lazy", decoding: "async", width: 274, height: 405 });
}

function placeholder(card) {
  return el("div", { class: "placeholder" },
    el("span", { class: "ph-code" }, cardLabel(card)),
    el("span", {}, "还没有图片"));
}

function copyViewButton(card) {
  const cmd = viewCommand(card);
  const copy = el("button", { class: "copy-cmd", type: "button", title: "复制后到 Discord 粘贴执行" },
    card.source === "lumina" ? "复制 LVIEW" : "复制 k!view");
  copy.addEventListener("click", () => copyText(cmd));
  return copy;
}

// ------------------------------------------------------------ 初始化

async function loadMeta() {
  state.meta = await api("/api/meta");
  const { owners, editions, conditions, tags, sources, rarities } = state.meta;

  const owner = $("#owner");
  owner.replaceChildren(
    el("option", { value: "" }, `全部卡主 (${owners.reduce((s, o) => s + o.count, 0)})`),
    ...owners.map((o) => el("option", { value: o.id }, `${o.name || o.id} (${o.count})`)),
  );
  if (owners.length === 1) state.owner = owners[0].id;
  owner.value = state.owner;

  const keep = (sel, n) => [...$(sel).options].slice(0, n);
  $("#f-source").replaceChildren(...keep("#f-source", 1),
    ...sources.map((s) => el("option", { value: s.source }, `${SOURCE_LABEL[s.source] || s.source} (${s.count})`)));
  $("#f-rarity").replaceChildren(...keep("#f-rarity", 1),
    ...rarities.map((r) => el("option", { value: r }, r.toUpperCase())));
  $("#f-edition").replaceChildren(...keep("#f-edition", 1), ...editions.map((e) => el("option", { value: e }, `◈${e}`)));
  $("#f-condition").replaceChildren(
    ...keep("#f-condition", 1),
    ...conditions.map((c) => el("option", { value: c.value }, `${CONDITION_STARS(c.value)} ${c.name}`)),
  );
  $("#f-tag").replaceChildren(...keep("#f-tag", 2), ...tags.map((t) => el("option", { value: t }, t)));
  $("#bulk-tag").replaceChildren(...keep("#bulk-tag", 2), ...tags.map((t) => el("option", { value: t }, t)));
  // 重建选项后浏览器可能保留错误的选中项，显式重置
  for (const sel of ["#f-edition", "#f-condition", "#f-tag", "#f-source", "#f-rarity"]) $(sel).value = "";
  $("#bulk-tag").value = "__";
}

// ------------------------------------------------------------ 卡牌列表

async function loadCards() {
  const params = new URLSearchParams({
    ...currentFilters(),
    sort: state.sort,
    dir: state.dir,
    page: state.page,
    page_size: state.pageSize,
  });
  const seq = ++state.requestSeq;
  try {
    const data = await api(`/api/cards?${params}`);
    if (seq !== state.requestSeq) return;  // 已有更新的请求
    state.cards = data.cards;
    state.total = data.total;
    const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page > maxPage) {
      state.page = maxPage;
      return loadCards();
    }
    renderCards();
  } catch (err) {
    toast(`加载失败：${err.message}`, true);
  }
  if (STATIC) {
    $("#export").href = "cards.csv";      // 静态快照：导出的是完整 CSV，不随筛选变化
    $("#export").textContent = "下载 CSV";
  } else {
    const exportParams = new URLSearchParams(currentFilters());
    $("#export").href = `/api/export.csv${exportParams.size ? "?" + exportParams : ""}`;
  }
}

const KARUTA_SORTS = ["print_number", "edition", "condition_stars", "wishlist", "effort"];
const LUMINA_SORTS = ["position", "rarity", "art_number"];

function sortForSource(source) {
  if (source === "lumina" && (KARUTA_SORTS.includes(state.sort) || state.sort === "card_code")) return "position";
  if (source === "karuta" && LUMINA_SORTS.includes(state.sort)) return "print_number";
  return null;
}

/** 切换来源后：排序换成该来源有意义的字段，并清掉另一来源那些已被隐藏的筛选。 */
function applySourceChange() {
  const source = $("#f-source").value;
  const next = sortForSource(source);
  if (next) {
    state.sort = next;
    state.dir = "asc";
  }
  if (source === "lumina") {
    $("#f-edition").value = "";
    $("#f-condition").value = "";
  } else if (source === "karuta") {
    $("#f-rarity").value = "";
    $("#f-limited").value = "";
  }
}

function renderCards() {
  // 只选了一种来源时，隐藏另一种来源用不到的列（CSS 按 data-source 控制）
  document.body.dataset.source = $("#f-source").value || "all";
  const gallery = state.layout === "gallery";
  $("#gallery").hidden = !gallery;
  $("#table-wrap").hidden = gallery;
  for (const b of document.querySelectorAll(".segmented button")) {
    b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
  }
  if (gallery) {
    $("#gallery").replaceChildren(...state.cards.map(renderTile));
    $("#cards tbody").replaceChildren();
    $("#gallery-empty").hidden = state.cards.length > 0;
  } else {
    $("#cards tbody").replaceChildren(...state.cards.map(renderRow));
    $("#gallery").replaceChildren();
    $("#gallery-empty").hidden = true;
    $("#empty").hidden = state.cards.length > 0;
  }

  const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
  const start = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
  const end = Math.min(state.total, state.page * state.pageSize);
  $("#summary").textContent = `共 ${state.total} 张，显示 ${start}–${end}`;
  $("#page-info").textContent = `${state.page} / ${maxPage}`;
  $("#prev").disabled = state.page <= 1;
  $("#next").disabled = state.page >= maxPage;

  for (const th of document.querySelectorAll("th[data-sort]")) {
    const active = th.dataset.sort === state.sort;
    if (active) th.setAttribute("aria-sort", state.dir === "asc" ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  }
  // 表头点出来的字段可能不在下拉框里（如 source / card_code），此时不要让下拉框变空白
  $("#sort").value = [...$("#sort").options].some((o) => o.value === state.sort) ? state.sort : "";
  $("#dir").textContent = state.dir === "asc" ? "↑" : "↓";
  $("#dir").title = state.dir === "asc" ? "升序（点击切换为降序）" : "降序（点击切换为升序）";
  renderChips();
  renderBulk();
}

function renderRow(card) {
  const selected = state.selected.has(card.id);
  const tr = el("tr", { class: selected ? "selected" : "", dataset: { code: String(card.id) } });

  const check = el("input", { type: "checkbox", "aria-label": `选择 ${cardLabel(card)}` });
  check.checked = selected;
  check.addEventListener("change", () => {
    check.checked ? state.selected.add(card.id) : state.selected.delete(card.id);
    tr.classList.toggle("selected", check.checked);
    renderBulk();
  });

  const fav = el("button", { class: "fav", type: "button" });
  setFavButton(fav, card.favorite);
  fav.addEventListener("click", async () => {
    const updated = await saveCard(card, { favorite: !card.favorite });
    if (updated) setFavButton(fav, updated.favorite);
  });

  const code = el("button", { class: "code", type: "button", title: "点击复制" }, cardLabel(card));
  code.addEventListener("click", () => copyText(cardLabel(card)));

  const dot = tagDot(card.tag);
  const tagSelect = el("select", { "aria-label": `${cardLabel(card)} 的 Tag` }, tagOptions());
  tagSelect.value = card.tag || "";
  tagSelect.addEventListener("change", async () => {
    const updated = await saveCard(card, { tag: tagSelect.value || null });
    if (updated) dot.style.background = `var(--tag-${updated.tag || "none"})`;
    else tagSelect.value = card.tag || "";
  });

  const notes = el("input", { class: "notes", type: "text", maxlength: 2000, placeholder: "添加备注", "aria-label": `${cardLabel(card)} 的备注` });
  notes.value = card.notes || "";
  const saveNotes = async () => {
    if ((notes.value.trim() || null) === (card.notes || null)) return;
    const updated = await saveCard(card, { notes: notes.value });
    if (updated) {
      notes.value = updated.notes || "";
      notes.classList.add("saved");
      setTimeout(() => notes.classList.remove("saved"), 1200);
    }
  };
  notes.addEventListener("change", saveNotes);
  notes.addEventListener("keydown", (e) => e.key === "Enter" && notes.blur());

  const numCell = (v, extra = "") => el("td", { class: `num ${extra}`.trim() },
    v == null ? el("span", { class: "null" }, "—") : v.toLocaleString());

  tr.append(
    el("td", { class: "col-select" }, check),
    el("td", { class: "col-fav" }, fav),
    el("td", { class: "src col-both" }, SOURCE_LABEL[card.source] || card.source),
    el("td", {}, code),
    el("td", { class: "character", title: card.character }, card.character, limitedBadge(card),
      missingBadge(card), staleBadge(card)),
    el("td", { class: "series", title: card.series }, card.series),
    numCell(card.print_number, "col-karuta"),
    el("td", { class: "num col-karuta" }, card.edition == null ? "—" : `◈${card.edition}`),
    el("td", { class: "stars col-karuta", title: conditionName(card.condition_stars) }, CONDITION_STARS(card.condition_stars)),
    el("td", { class: "col-lumina" }, card.rarity ? card.rarity.toUpperCase() : el("span", { class: "null" }, "—")),
    numCell(card.wishlist, "col-karuta"),
    numCell(card.effort, "col-karuta"),
    el("td", {}, el("span", { class: "tag-cell" }, dot,
      STATIC ? el("span", { class: "tag-text" }, card.tag || "—") : null, tagSelect)),
    el("td", {}, notes),
  );
  return tr;
}

function renderTile(card) {
  const selected = state.selected.has(card.id);
  const tile = el("article", { class: selected ? "tile-card selected" : "tile-card", dataset: { code: String(card.id) } });

  const check = el("input", { type: "checkbox", class: "tile-select", "aria-label": `选择 ${cardLabel(card)}` });
  check.checked = selected;
  check.addEventListener("change", () => {
    check.checked ? state.selected.add(card.id) : state.selected.delete(card.id);
    tile.classList.toggle("selected", check.checked);
    renderBulk();
  });

  const art = el("button", { class: "tile-art", type: "button", "aria-label": `查看 ${card.character} (${cardLabel(card)}) 详情` },
    cardImage(card, `${card.character} · ${card.series}`) || placeholder(card));
  art.addEventListener("click", () => openCardDialog(card));

  const fav = el("button", { class: "fav", type: "button" });
  setFavButton(fav, card.favorite);
  fav.addEventListener("click", async () => {
    const updated = await saveCard(card, { favorite: !card.favorite });
    if (updated) setFavButton(fav, updated.favorite);
  });

  const dot = tagDot(card.tag);
  const tagText = STATIC ? el("span", { class: "tag-text" }, card.tag || "无 Tag") : null;
  const tagSelect = el("select", { "aria-label": `${cardLabel(card)} 的 Tag` }, tagOptions("无 Tag"));
  tagSelect.value = card.tag || "";
  tagSelect.addEventListener("change", async () => {
    const updated = await saveCard(card, { tag: tagSelect.value || null });
    if (updated) dot.style.background = `var(--tag-${updated.tag || "none"})`;
    else tagSelect.value = card.tag || "";
  });

  const meta = (card.source === "lumina"
    ? [`#${card.position}`, card.art_number == null ? null : `art #${card.art_number}`,
       card.rarity ? card.rarity.toUpperCase() : null]
    : [card.print_number == null ? null : `#${card.print_number.toLocaleString()}`,
       card.edition == null ? null : `◈${card.edition}`,
       CONDITION_STARS(card.condition_stars) || null]
  ).filter(Boolean).join(" · ");

  tile.append(
    check,
    // 复制按钮与图片按钮是兄弟元素（按钮里不能再嵌套按钮），用定位叠在占位图上
    el("div", { class: "tile-media" }, art, card.image_url ? null : copyViewButton(card)),
    el("div", { class: "tile-info" },
      el("div", { class: "tile-name", title: card.character }, card.character),
      el("div", { class: "tile-series", title: card.series }, card.series),
      el("div", { class: "tile-meta", title: conditionName(card.condition_stars) }, meta),
      limitedBadge(card),
      missingBadge(card),
      staleBadge(card),
      el("div", { class: "tile-actions" }, fav, dot, tagText, tagSelect)),
  );
  return tile;
}

// ------------------------------------------------------------ 卡片详情弹窗

let dialogCard = null;

function openCardDialog(card) {
  dialogCard = card;
  const dlg = $("#card-dialog");
  $(".dlg-image").replaceChildren(cardImage(card, `${card.character} · ${card.series}`) || placeholder(card));
  $("#dlg-character").textContent = card.character;
  $(".dlg-series").textContent = card.series;

  const common = [
    ["来源", SOURCE_LABEL[card.source] || card.source],
    ["卡主", card.owner_name || card.owner_discord_id],
    ["图片更新", card.image_updated_at ? new Date(card.image_updated_at).toLocaleString() : "还没有图片"],
  ];
  const rows = card.source === "lumina"
    ? [["收藏位置", `#${card.position}`],
       ["画作编号", card.art_number == null ? "—" : `#${card.art_number}`],
       ["稀有度", card.rarity ? card.rarity.toUpperCase() : "—"],
       ["限定", card.limited == null ? "未知" : card.limited ? "Limited" : "常驻"],
       ["Banner", card.banner || "—"],
       ["标记", card.markers || "—"],
       ...common]
    : [["卡号", card.card_code],
       ["Print", card.print_number == null ? "—" : `#${card.print_number.toLocaleString()}`],
       ["Edition", card.edition == null ? "—" : `◈${card.edition}`],
       ["品相", `${CONDITION_STARS(card.condition_stars)} ${conditionName(card.condition_stars)}`.trim() || "—"],
       ["Wishlist", card.wishlist == null ? "—" : card.wishlist.toLocaleString()],
       ["Effort", card.effort == null ? "—" : card.effort.toLocaleString()],
       ...common];
  $(".dlg-meta").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));

  const warn = $("#dlg-stale");
  if (warn) {
    warn.hidden = !card.annotation_stale;
    warn.textContent = card.annotation_stale
      ? "这个收藏位置上的卡换过，下面的 Tag / 收藏 / 备注可能不对；确认或修改一次即可消除提示" : "";
  }
  $("#dlg-tag").replaceChildren(...tagOptions("无 Tag"));
  $("#dlg-tag").value = card.tag || "";
  setFavButton($("#dlg-fav"), card.favorite, true);
  $("#dlg-copy").textContent = card.source === "lumina" ? "复制 LVIEW 命令" : "复制 k!view 命令";
  $("#dlg-notes").value = card.notes || "";
  if (!dlg.open) dlg.showModal();
}

async function saveDialogNotes(card, value) {
  if (!card) return;
  if ((value.trim() || null) === (card.notes || null)) return;
  const updated = await saveCard(card, { notes: value });
  if (updated && dialogCard === card) $("#dlg-notes").value = updated.notes || "";
}

function bindDialogEvents() {
  const dlg = $("#card-dialog");
  $("#dlg-tag").addEventListener("change", async () => {
    const card = dialogCard;
    if (!card) return;
    const updated = await saveCard(card, { tag: $("#dlg-tag").value || null });
    if (!updated && dialogCard === card) $("#dlg-tag").value = card.tag || "";
  });
  $("#dlg-fav").addEventListener("click", async () => {
    const card = dialogCard;
    if (!card) return;
    const updated = await saveCard(card, { favorite: !card.favorite });
    if (updated && dialogCard === card) setFavButton($("#dlg-fav"), updated.favorite, true);
  });
  $("#dlg-notes").addEventListener("change", () => saveDialogNotes(dialogCard, $("#dlg-notes").value));
  $("#dlg-copy").addEventListener("click", () => dialogCard && copyText(viewCommand(dialogCard)));

  // 点击遮罩关闭：按下和松开都必须在遮罩上。拖选文字时从弹窗内拖到遮罩、或从遮罩拖进弹窗，
  // 浏览器都会把 click 派发给两者的共同祖先 <dialog>，只看 click 的 target 会误关
  let pressedOnBackdrop = false;
  let releasedOnBackdrop = false;
  dlg.addEventListener("pointerdown", (e) => {
    pressedOnBackdrop = e.target === dlg;
  });
  dlg.addEventListener("pointerup", (e) => {
    releasedOnBackdrop = e.target === dlg;
  });
  dlg.addEventListener("click", (e) => {
    if (pressedOnBackdrop && releasedOnBackdrop && e.target === dlg) dlg.close();
    pressedOnBackdrop = releasedOnBackdrop = false;
  });

  dlg.addEventListener("close", () => {
    // 先取出当前卡片和备注再清空：备注保存期间用户可能已经打开了另一张卡
    const card = dialogCard;
    const notes = $("#dlg-notes").value;
    dialogCard = null;
    if (!card) return;
    const active = document.activeElement;
    // 浏览器会把焦点还给打开弹窗的卡片按钮；若列表在弹窗打开期间重新渲染过，那个按钮已被移除，
    // 焦点会留在（已关闭的）弹窗内部，这种情况同样要把焦点还给同一张卡
    const refocus = !active || active === document.body || !active.isConnected || dlg.contains(active)
      || active.closest?.(".tile-card")?.dataset.code === String(card.id);
    renderCards();  // 同步弹窗中修改的 Tag / 收藏到列表（备注不在卡片上显示）
    // 重新渲染会移除刚获得焦点的卡片按钮：把焦点还给同一张卡，键盘用户不会跳回列表开头
    if (refocus) document.querySelector(`.tile-card[data-code="${CSS.escape(String(card.id))}"] .tile-art`)?.focus();
    saveDialogNotes(card, notes);
  });
}

function conditionName(n) {
  return state.meta.conditions.find((c) => c.value === n)?.name || "";
}

async function saveCard(card, fields) {
  if (STATIC) {
    toast("这是只读的收藏快照，改动请在本地的管理页面进行", true);
    return null;
  }
  try {
    const { card: updated } = await api(`/api/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
    Object.assign(card, updated);
    // 请求期间列表可能已重新加载（state.cards 换成了新对象），同步更新当前列表里的同一张卡
    const live = state.cards.find((c) => c.id === updated.id);
    if (live && live !== card) Object.assign(live, updated);
    if (!updated.annotation_stale) {
      // 标注已被确认：立即去掉徽标，不用等整页重绘
      document.querySelectorAll(`[data-code="${CSS.escape(String(updated.id))}"] .stale`).forEach((n) => n.remove());
    }
    toast("已保存");
    return updated;
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
    return null;
  }
}

function renderChips() {
  const labels = {
    series: (v) => `系列：${v}`,
    character: (v) => `角色：${v}`,
    print_min: (v) => `Print ≥ ${Number(v).toLocaleString()}`,
    print_max: (v) => `Print ≤ ${Number(v).toLocaleString()}`,
  };
  const chips = Object.entries(state.filters).map(([k, v]) =>
    el("button", {
      class: "chip", type: "button", title: "移除这个筛选",
      onclick: () => {
        delete state.filters[k];
        state.page = 1;
        loadCards();
      },
    }, labels[k] ? labels[k](v) : `${k}: ${v}`),
  );
  $("#chips").replaceChildren(...chips);
  $("#chips").hidden = chips.length === 0;
}

function renderBulk() {
  const n = state.selected.size;
  $("#bulk").hidden = n === 0;
  $("#bulk-count").textContent = `已选 ${n} 张`;
  const pageCodes = state.cards.map((c) => c.id);
  const selectedOnPage = pageCodes.filter((c) => state.selected.has(c)).length;
  const allSelected = pageCodes.length > 0 && selectedOnPage === pageCodes.length;
  const all = $("#select-all");
  all.checked = allSelected;
  all.indeterminate = selectedOnPage > 0 && selectedOnPage < pageCodes.length;
  // 每次勾选变化都会调用 renderBulk，按钮文字始终与实际选择状态一致
  $("#select-page").textContent = allSelected ? "取消选择本页" : "选择本页";
  $("#select-page").disabled = pageCodes.length === 0;
}

async function bulkUpdate(fields) {
  if (STATIC) {
    toast("这是只读的收藏快照", true);
    return;
  }
  try {
    const { updated } = await api("/api/cards/bulk", {
      method: "POST",
      body: JSON.stringify({ card_ids: [...state.selected], fields }),
    });
    toast(`已更新 ${updated} 张`);
    await loadCards();
  } catch (err) {
    toast(`批量更新失败：${err.message}`, true);
  }
}

function resetFilters() {
  state.filters = {};
  $("#q").value = "";
  $("#f-edition").value = "";
  $("#f-condition").value = "";
  $("#f-tag").value = "";
  $("#f-image").value = "";
  $("#f-source").value = "";
  $("#f-rarity").value = "";
  $("#f-limited").value = "";
  $("#f-favorite").checked = false;
  $("#f-stale").checked = false;
  $("#f-missing").checked = false;
  state.page = 1;
}

function setSort(field, dir) {
  state.sort = field;
  // wishlist / effort / 最近扫描 默认从大到小更常用；print 等默认从小到大
  state.dir = dir || (["wishlist", "effort", "updated_at", "created_at"].includes(field) ? "desc" : "asc");
  state.page = 1;
  loadCards();
}

// ------------------------------------------------------------ 统计

async function loadStats() {
  let s;
  try {
    const params = new URLSearchParams();
    if (state.owner) params.set("owner", state.owner);
    if ($("#f-source").value) params.set("source", $("#f-source").value);
    s = await api(`/api/stats${params.size ? "?" + params : ""}`);
  } catch (err) {
    toast(`统计加载失败：${err.message}`, true);
    return;
  }
  const tile = (label, value, hero = false, suffix = null) =>
    el("div", { class: hero ? "tile hero" : "tile" },
      el("div", { class: "label" }, label),
      el("div", { class: "value" }, value.toLocaleString(),
        suffix ? el("span", { class: "value-suffix" }, ` ${suffix}`) : null));
  $("#tiles").replaceChildren(
    tile("卡牌总数", s.total, true),
    tile("系列", s.series),
    tile("角色", s.characters),
    tile("收藏", s.favorites),
    tile("未分类", s.untagged),
    tile("有图片", s.with_images, false, `/ ${s.total.toLocaleString()}`),
    ...s.by_source.map((d) => tile(SOURCE_LABEL[d.source] || d.source, d.count)),
    ...(s.stale_annotations ? [tile("标注待确认", s.stale_annotations)] : []),
  );

  renderBars("#chart-edition", s.by_edition.map((d) => ({
    label: `◈${d.edition}`, count: d.count, apply: () => ({ controls: { "#f-edition": d.edition } }),
  })), s.total);
  renderBars("#chart-condition", s.by_condition.map((d) => ({
    label: `${CONDITION_STARS(d.condition)} ${d.name}`, count: d.count,
    apply: () => ({ controls: { "#f-condition": d.condition } }),
  })), s.total);
  renderBars("#chart-banner", s.by_banner.map((d) => ({
    label: d.banner, count: d.count,
    apply: () => ({ controls: { "#f-source": "lumina", "#f-limited": d.limited ? "1" : "0" } }),
  })), s.total);
  renderBars("#chart-rarity", s.by_rarity.map((d) => ({
    label: d.rarity.toUpperCase(), count: d.count, apply: () => ({ controls: { "#f-rarity": d.rarity } }),
  })), s.total);
  renderBars("#chart-print", s.by_print_tier.map((d) => ({
    label: d.label, count: d.count,
    apply: () => ({ filters: { print_min: d.min, ...(d.max == null ? {} : { print_max: d.max }) } }),
  })), s.total);
  renderBars("#chart-tag", s.by_tag.map((d) => ({
    label: d.tag || "未分类", count: d.count, color: `var(--tag-${d.tag || "none"})`, swatch: true,
    apply: () => ({ controls: { "#f-tag": d.tag || "none" } }),
  })), s.total);
  renderBars("#chart-series", s.top_series.map((d) => ({
    label: d.series, count: d.count, apply: () => ({ filters: { series: d.series } }),
  })), s.total);
}

function renderBars(selector, items, total) {
  const container = $(selector);
  if (!items.length) {
    container.replaceChildren(el("p", { class: "empty" }, "暂无数据"));
    return;
  }
  const max = Math.max(...items.map((d) => d.count), 1);
  const tooltip = $("#tooltip");

  const rows = items.map((d) => {
    const pct = total ? Math.round((d.count / total) * 1000) / 10 : 0;
    const tip = `${d.label}：${d.count.toLocaleString()} 张（${pct}%）`;
    const row = el("div", { class: "bar-row", role: "button", tabindex: 0, "aria-label": `${tip}，点击查看这些卡` },
      el("div", { class: "bar-label" },
        d.swatch ? el("span", { class: "dot", style: `background:${d.color}` }) : null,
        el("span", { title: d.label }, d.label)),
      el("div", { class: "bar-track" },
        // 非零值至少 2px 可见；零值不画柱条，只显示数字 0
        el("div", { class: "bar", style: `width:${d.count ? `max(2px, ${(d.count / max) * 82}%)` : "0"}${d.color ? `;background:${d.color}` : ""}` }),
        el("span", { class: "bar-value" }, d.count.toLocaleString())),
    );
    row.addEventListener("mousemove", (e) => {
      tooltip.textContent = tip;
      tooltip.hidden = false;
      const x = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${e.clientY + 14}px`;
    });
    row.addEventListener("mouseleave", () => (tooltip.hidden = true));
    const go = () => {
      tooltip.hidden = true;
      resetFilters();
      const { controls = {}, filters = {} } = d.apply();
      for (const [sel, value] of Object.entries(controls)) $(sel).value = String(value);
      applySourceChange();
      for (const [sel, value] of Object.entries(controls)) $(sel).value = String(value);  // 清理后重新套用
      state.filters = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)]));
      switchView("cards");
    };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
    return row;
  });
  container.replaceChildren(el("div", { class: "bars" }, rows));
}

// ------------------------------------------------------------ 视图切换与事件

function switchView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  }
  $("#view-cards").hidden = view !== "cards";
  $("#view-stats").hidden = view !== "stats";
  history.replaceState(null, "", view === "stats" ? "#stats" : location.pathname + location.search);
  view === "cards" ? loadCards() : loadStats();
}

function bindEvents() {
  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
  $("#owner").addEventListener("change", (e) => {
    state.owner = e.target.value;
    state.page = 1;
    state.selected.clear();
    switchView(state.view);
  });

  const refilter = () => {
    state.page = 1;
    loadCards();
  };
  $("#q").addEventListener("input", debounce(refilter, 250));
  $("#f-source").addEventListener("change", applySourceChange);
  for (const id of ["#f-edition", "#f-condition", "#f-tag", "#f-image", "#f-favorite",
                    "#f-source", "#f-rarity", "#f-stale", "#f-limited", "#f-missing"]) {
    $(id).addEventListener("change", refilter);
  }
  $("#reset").addEventListener("click", () => {
    resetFilters();
    loadCards();
  });

  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.addEventListener("click", () => {
      // Lumina 的 card_code 是字符串（#1, #10, #100…），按位置排序才符合预期
      const field = th.dataset.sort === "card_code" && $("#f-source").value === "lumina"
        ? "position" : th.dataset.sort;
      if (state.sort === field) setSort(field, state.dir === "asc" ? "desc" : "asc");
      else setSort(field);
    });
  }
  $("#sort").addEventListener("change", (e) => setSort(e.target.value));
  $("#dir").addEventListener("click", () => setSort(state.sort, state.dir === "asc" ? "desc" : "asc"));

  for (const b of document.querySelectorAll(".segmented button")) {
    b.addEventListener("click", () => {
      state.layout = b.dataset.layout;
      storage.set("karuta.layout", state.layout);
      renderCards();
    });
  }
  $("#select-page").addEventListener("click", () => {
    const codes = state.cards.map((c) => c.id);
    const allSelected = codes.every((c) => state.selected.has(c));
    for (const c of codes) allSelected ? state.selected.delete(c) : state.selected.add(c);
    renderCards();
  });
  bindDialogEvents();

  $("#page-size").addEventListener("change", (e) => {
    state.pageSize = Number(e.target.value);
    state.page = 1;
    loadCards();
  });
  $("#prev").addEventListener("click", () => { state.page -= 1; loadCards(); });
  $("#next").addEventListener("click", () => { state.page += 1; loadCards(); });

  $("#select-all").addEventListener("change", (e) => {
    for (const card of state.cards) {
      e.target.checked ? state.selected.add(card.id) : state.selected.delete(card.id);
    }
    renderCards();
  });
  $("#bulk-tag").addEventListener("change", (e) => {
    if (e.target.value === "__") return;
    bulkUpdate({ tag: e.target.value || null });
    e.target.value = "__";
  });
  $("#bulk-fav").addEventListener("click", () => bulkUpdate({ favorite: true }));
  $("#bulk-unfav").addEventListener("click", () => bulkUpdate({ favorite: false }));
  $("#bulk-clear").addEventListener("click", () => {
    state.selected.clear();
    renderCards();
  });
}

async function loadStaticData() {
  const res = await fetch("data.json");
  if (!res.ok) throw new Error(`data.json HTTP ${res.status}`);
  const data = await res.json();
  staticData.cards = data.cards;
  staticData.meta = data.meta;
  staticData.generated_at = data.generated_at;
  document.body.classList.add("readonly");
  const note = $("#snapshot-note");
  if (note) {
    note.hidden = false;
    note.textContent = `只读快照 · 共 ${data.cards.length} 张卡 · 生成于 ${new Date(data.generated_at).toLocaleString()}`;
  }
}

(async function main() {
  bindEvents();
  try {
    if (STATIC) await loadStaticData();
    await loadMeta();
  } catch (err) {
    toast(`无法连接服务器：${err.message}`, true);
    return;
  }
  switchView(location.hash === "#stats" ? "stats" : "cards");
})();
