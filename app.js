/* ブラッピー — 画面制御（GitHub Pages で配る静的ページ）
   API は GAS（gas/api.js）。認証は LIFF の IDトークンを毎回送り、GAS が LINE に問い合わせて確かめる。
   index.html = マイページ（M-01〜M-10）、apply.html = フォーム1（F-01〜F-05）。
   状態は1つ（state）だけ持ち、view を差し替える。 */
'use strict';

const CFG = window.BRAPEE || {};
const PAGE = document.body.dataset.page;

const FLOW = ['申込', 'キット発送', 'キット到達', '集荷', '査定中', '承認待ち', '振込待ち', '入金済み'];
/* フロー帯の見出しは短くする（幅が狭いため） */
const FLOW_LABEL = {
  '申込': '申込', 'キット発送': 'キット', 'キット到達': '到達', '集荷': '集荷',
  '査定中': '査定', '承認待ち': '承認', '振込待ち': '振込', '入金済み': '完了'
};

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
const btnLogout = document.getElementById('btnLogout');

let state = { view: 'top', me: null, case: null, seg: '取引', hist: null };
let idToken = null;

/* ---------------------------------------------------------------- util */
const yen = n => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('ja-JP') + '円';
const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtDate(s, withTime) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d)) return s;
  const base = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  return withTime ? `${base} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : base;
}
function fmtMD(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d) ? s : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* GAS は text/plain で受ける（application/json はプリフライトになり GAS が応えられない） */
async function api(action, payload) {
  if (!CFG.GAS_URL) throw new Error('準備中です（API の URL が未設定です）');
  const body = Object.assign({ action, idToken }, payload || {});
  let j = null;
  if (CFG.DEV_API) {
    /* 画面確認用プレビューだけで使う（本番の config.js には無い） */
    j = await CFG.DEV_API(body);
  } else {
    let r;
    try {
      r = await fetch(CFG.GAS_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('通信できませんでした。電波の良いところでお試しください');
    }
    try { j = await r.json(); } catch (e) { /* 下で扱う */ }
  }
  if (!j) throw new Error('エラーが発生しました');
  if (!j.ok) {
    /* IDトークンの期限切れ。ログインし直して同じ画面へ戻る */
    if (j.status === 401 && window.liff && liff.isLoggedIn && liff.isLoggedIn() && !sessionStorage.getItem('relogin')) {
      sessionStorage.setItem('relogin', '1');
      liff.logout();
      liff.login({ redirectUri: location.href });
      return new Promise(() => {});
    }
    const e = new Error(j.detail || 'エラーが発生しました');
    e.status = j.status;
    throw e;
  }
  sessionStorage.removeItem('relogin');
  return j;
}

/** テンプレートを取り出し、data-f / data-if を値で埋める */
function render(tplId, data) {
  const node = document.getElementById(tplId).content.cloneNode(true);
  node.querySelectorAll('[data-f]').forEach(el => {
    const v = data[el.dataset.f];
    if (v !== undefined && v !== null && v !== '') el.textContent = v;
  });
  node.querySelectorAll('[data-if]').forEach(el => {
    if (!data[el.dataset.if]) el.remove();
  });
  return node;
}

function mount(node) {
  app.innerHTML = '';
  app.appendChild(node);
  window.scrollTo(0, 0);
}

function setTab(view) {
  if (!tabbar) return;
  tabbar.querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', b.dataset.view === view));
}

function showChrome(on) {
  if (tabbar) tabbar.hidden = !on;
  /* LINE アプリの中ではログアウトは要らない（閉じれば終わる）。外部ブラウザのときだけ出す */
  if (btnLogout) btnLogout.hidden = !(on && window.liff && liff.isInClient && !liff.isInClient());
}

/* テンプレートは2画面で共有するため別ファイルに置き、起動時に取り込む */
async function loadTemplates() {
  const r = await fetch('templates.html', { cache: 'no-cache' });
  if (!r.ok) throw new Error('画面を読み込めませんでした');
  const holder = document.createElement('div');
  holder.innerHTML = await r.text();
  holder.querySelectorAll('template').forEach(t => document.body.appendChild(t));
}

/* ---------------------------------------------------------------- LIFF
   🔴 LINEユーザーIDは画面で使わない。IDトークンを GAS へ送り、GAS が検証して引く。 */
async function initLiff(liffId, required) {
  if (CFG.DEV_ID_TOKEN !== undefined) {
    idToken = CFG.DEV_ID_TOKEN || null;
    return !!idToken;
  }
  if (!liffId || !window.liff) {
    if (required) throw new Error('準備中です（LIFF が未設定です）');
    return false;
  }
  try {
    await liff.init({ liffId });
  } catch (e) {
    console.warn('LIFF init failed', e);
    if (required) throw new Error('LINE との接続に失敗しました。LINE アプリから開き直してください');
    return false;
  }
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    return new Promise(() => {});      /* ログイン画面へ遷移する */
  }
  /* 🔴 LINE の外のブラウザでは、期限（1時間）の切れた IDトークンがそのまま返る。
        フォーム1はそれでも「未連携」として受け付けてしまう（前回の入力が出ず、LINE と紐づかない）ので、
        切れていたらログインし直す（261009 実機） */
  const dec = liff.getDecodedIDToken ? liff.getDecodedIDToken() : null;
  if (dec && dec.exp * 1000 < Date.now() + 60e3 && !sessionStorage.getItem('relogin')) {
    sessionStorage.setItem('relogin', '1');
    liff.logout();
    liff.login({ redirectUri: location.href });
    return new Promise(() => {});
  }
  idToken = liff.getIDToken();
  return !!idToken;
}

/* ---------------------------------------------------------------- 起動 */
async function boot() {
  await loadTemplates();
  if (PAGE === 'apply') return viewApply();

  await initLiff(CFG.LIFF_MYPAGE, true);
  const s = await api('state');
  if (!s['連携済']) return viewLogin();
  showChrome(true);
  go('top');
}

function go(view, arg) {
  state.view = view;
  setTab(view === 'pickup' ? 'top' : view);
  const p = view === 'top' ? viewTop() : view === 'case' ? viewCase(arg) : view === 'form2' ? viewForm2()
    : view === 'history' ? viewHistory() : view === 'pickup' ? viewPickup() : null;
  if (p && p.catch) p.catch(showError);
  return p;
}

function showError(e) {
  app.innerHTML = `<div class="card center"><p class="err">${esc(e.message)}</p>
    <button class="btn btn-primary" onclick="location.reload()">やり直す</button></div>`;
}

/* 公式アカウントのトークを開く（相談・問い合わせ）。LINE の中ならそのままトークへ移る */
function wireLineChat(node) {
  node.querySelectorAll('[data-line-chat]').forEach(a => {
    if (!CFG.OA_ID) { a.remove(); return; }
    a.href = 'https://line.me/R/oaMessage/' + encodeURIComponent(CFG.OA_ID) + '/';
  });
}

/* 申込フォームへのリンク。LINE の中でも外でも LIFF の URL で開く（LINE ユーザーIDを紐づけるため） */
function wireApplyLinks(node) {
  if (!CFG.LIFF_APPLY || CFG.DEV_API) return;
  node.querySelectorAll('[data-apply-link]').forEach(a => { a.href = 'https://liff.line.me/' + CFG.LIFF_APPLY; });
}

/* 入力の揺れを寄せる：全角英数→半角、ひらがな→カタカナ（カナ欄） */
const nfkc = s => String(s || '').normalize('NFKC').trim();
/* 時間帯の見せ方：「14-16」→「14〜16時」（値はそのまま送る） */
const slotLabel = v => /^\d{1,2}-\d{1,2}$/.test(v || '') ? v.replace('-', '〜') + '時' : (v || '');
const toKata = s => String(s || '').replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));

/** 入力欄の下にエラーを出す（F-02「入力漏れをその場で知らせる」）。ok なら消す */
function fieldError(el, msg) {
  const holder = el.closest('label') || el.parentElement;
  let p = holder.querySelector(':scope > .field-err');
  el.classList.toggle('invalid', !!msg);
  if (!msg) { if (p) p.remove(); return true; }
  if (!p) { p = document.createElement('p'); p.className = 'field-err'; holder.appendChild(p); }
  p.textContent = msg;
  return false;
}

const KYC_LABEL = { '未登録': ['未登録', 'st-ng'], '未確認': ['未登録', 'st-ng'], '確認中': ['確認中', 'st-wait'],
  '確認済': ['確認済み', 'st-ok'], '要再提出': ['撮り直しのお願い', 'st-ng'] };
const PICKUP_EDITABLE = ['申込', 'キット発送', 'キット到達'];

/* ---------------------------------------------------------------- M-10 初回の紐づけ */
function viewLogin() {
  showChrome(false);
  const node = render('tpl-login', {});
  wireApplyLinks(node);
  const form = node.querySelector('#formVerify');
  const err = node.querySelector('#verifyErr');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const fd = new FormData(form);
      await api('verify', { 受付番号: fd.get('受付番号'), 電話番号: fd.get('電話番号') });
      showChrome(true);
      go('top');
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
  mount(node);
}

/* ---------------------------------------------------------------- M-02 */
async function viewTop() {
  const me = state.me = await api('me');
  const a = me['案件'];
  const todo = me['未完了'] || [];
  const d = {
    '顧客名': me['顧客']['顧客名'],
    'ログイン手段': 'LINEアカウントでログイン中',
    '未完了あり': todo.length > 0,
    '未完了文': todo.join('と') + 'のご登録をお願いします。ご登録がないと査定額をお振込みできません。',
    '案件': !!a,
    '案件なし': !a,
    '完了': !!a && a['案件ステータス'] === '入金済み'
  };
  if (a) Object.assign(d, {
    '受付番号': a['受付番号'],
    '案件ステータス': a['案件ステータス'],
    '点数つき': (a['点数'] || 0) + '点',
    '集荷日表示': fmtMD(a['集荷希望日']) +
      (a['集荷希望時間帯'] ? ' ' + slotLabel(a['集荷希望時間帯']) : ''),
    '宅配キット種別': a['宅配キット種別'] || '—',
    '買取金額あり': a['買取金額'] !== null && a['買取金額'] !== undefined,
    '買取金額表示': yen(a['買取金額']),
    '承認できる': a['案件ステータス'] === '承認待ち',
    '変更できる': PICKUP_EDITABLE.indexOf(a['案件ステータス']) >= 0,
    '本人確認表示': (KYC_LABEL[me['本人確認状況']] || [me['本人確認状況']])[0],
    '口座表示': me['口座登録済'] ? '登録済み' : '未登録'
  });

  const node = render('tpl-top', d);
  if (a) {
    paintFlow(node.querySelector('[data-flow]'), a['案件ステータス']);
    const pill = node.querySelector('.pill');
    if (pill && a['ステータス配色']) pill.style.background = a['ステータス配色'];
    const b = node.querySelector('[data-go-case]');
    if (b) b.addEventListener('click', () => go('case', a['案件id']));
    /* お品物はスタッフがチャットの写真をもとに登録する。登録前はそう案内する */
    const items = me['商品'] || [];
    node.querySelector('[data-top-items]').innerHTML = items.length ? items.map(p => `
      <li><span class="nm"><b>${esc(p['品名'])}</b></span>
        <span class="amt">${p['査定額'] !== null && p['査定額'] !== undefined ? yen(p['査定額']) : (p['概算額'] ? '概算 ' + yen(p['概算額']) : '')}</span></li>`).join('')
      : '<li class="empty">チャットでお送りいただいた写真をもとに、スタッフが登録します</li>';
    const marks = node.querySelectorAll('.checks b');
    if (marks[0]) marks[0].className = (KYC_LABEL[me['本人確認状況']] || ['', 'st-wait'])[1];
    if (marks[1]) marks[1].className = me['口座登録済'] ? 'st-ok' : 'st-ng';
  }
  wireApplyLinks(node);
  wireLineChat(node);
  mount(node);
}

/* ---------------------------------------------------------------- M-06 集荷日時・キットの変更 */
async function viewPickup() {
  const r = await api('form2.get');
  const a = r['案件'];
  if (!a || PICKUP_EDITABLE.indexOf(a['案件ステータス']) < 0) return go('top');
  const kitOk = a['案件ステータス'] === '申込';
  const node = render('tpl-pickup', { '受付番号': a['受付番号'], 'キット変更可': kitOk, 'キット変更不可': !kitOk });
  const form = node.querySelector('#formPickup');
  if (kitOk) {
    node.querySelector('[data-kits]').innerHTML = (r['マスタ']['キット'] || []).map(k => `
      <label><input type="radio" name="宅配キット種別" value="${esc(k)}" ${k === a['宅配キット種別'] ? 'checked' : ''}>
        <span class="kb"><b>${esc(k)}</b></span></label>`).join('');
  }
  form.elements['集荷希望時間帯'].innerHTML = (r['マスタ']['時間帯'] || [])
    .map(v => `<option value="${esc(v)}" ${v === a['集荷希望時間帯'] ? 'selected' : ''}>${esc(slotLabel(v))}</option>`).join('');
  const dt = form.elements['集荷希望日'];
  dt.min = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  dt.value = a['集荷希望日'] || dt.min;
  const err = node.querySelector('#pickupErr');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const fd = new FormData(form);
      await api('pickup.update', { 案件id: a['案件id'], 集荷希望日: fd.get('集荷希望日'),
        集荷希望時間帯: fd.get('集荷希望時間帯'), 宅配キット種別: fd.get('宅配キット種別') || '' });
      go('top');
    } catch (e) {
      err.textContent = e.message; err.hidden = false; btn.disabled = false;
    }
  });
  mount(node);
}

function paintFlow(ol, status) {
  if (!ol) return;
  const i = FLOW.indexOf(status);
  ol.innerHTML = FLOW.map((s, n) => {
    const cls = n < i ? 'done' : (n === i ? 'now' : '');
    return `<li class="${cls}">${esc(FLOW_LABEL[s])}</li>`;
  }).join('');
}

/* ---------------------------------------------------------------- M-07 / M-08 */
async function viewCase(案件id) {
  const r = state.case = await api('case', { 案件id });
  const a = r['案件'], g = r['口座'];
  const d = {
    '受付番号': a['受付番号'],
    '案件ステータス': a['案件ステータス'],
    '買取金額あり': a['買取金額'] !== null && a['買取金額'] !== undefined,
    '買取金額表示': yen(a['買取金額']),
    '査定完了日': a['査定確定日時'] ? fmtDate(a['査定確定日時']) + ' 査定完了' : '',
    '客向けコメント': a['客向けコメント'] || '',
    '口座表示': g
      ? `${g['金融機関名'] || ''} ${g['支店名'] || ''} ${g['口座種別'] || ''} ${g['口座番号'] || ''}`.trim()
      : 'まだご登録がありません',
    '承認できる': a['案件ステータス'] === '承認待ち',
    '承認済み': !!a['承認日時']
  };
  const node = render('tpl-case', d);
  const pill = node.querySelector('.pill');
  if (pill && a['ステータス配色']) pill.style.background = a['ステータス配色'];
  const ul = node.querySelector('[data-items]');
  ul.innerHTML = (r['商品'] || []).map(p => `
    <li>
      <span class="nm"><b>${esc(p['品名'])}</b>
        <em>${p['ランク'] ? 'ランク ' + esc(p['ランク']) : (p['概算額'] ? '概算 ' + yen(p['概算額']) : '')}</em>
      </span>
      <span class="amt">${p['査定額'] === null || p['査定額'] === undefined ? '査定中' : yen(p['査定額'])}</span>
    </li>`).join('') || '<li class="empty">お品物がありません</li>';

  const btn = node.querySelector('#btnApprove');
  if (btn) btn.addEventListener('click', async () => {
    if (!confirm('この金額で承認します。よろしいですか。')) return;
    btn.disabled = true;
    try {
      await api('approve', { 案件id });
      alert('承認しました。お振込みの手続きに進みます。');
      go('top');
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
    }
  });
  wireLineChat(node);
  mount(node);
}

/* ---------------------------------------------------------------- M-04 / M-05 / M-06 */

/** 撮った写真を送れる大きさにする（長辺2000px の JPEG）。読めない形式はそのまま送る */
async function imagePayload(file) {
  if (!file) return null;
  const toB64 = blob => new Promise((ok, ng) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1]);
    fr.onerror = ng;
    fr.readAsDataURL(blob);
  });
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.85));
    if (blob) return { type: 'image/jpeg', data: await toB64(blob) };
  } catch (e) { /* HEIC など、ブラウザが描けない形式 */ }
  if (file.size > 8 * 1024 * 1024) throw new Error('画像が大きすぎます（8MBまで）');
  return { type: file.type || 'image/jpeg', data: await toB64(file) };
}

async function viewForm2() {
  const r = await api('form2.get');
  const k = r['本人確認'] || {}, g = r['口座'] || {}, a = r['案件'];
  const 修正可 = a && ['申込', 'キット発送', 'キット到達'].indexOf(a['案件ステータス']) >= 0;
  /* 要再提出のときは「登録済み」と見せない（撮り直しが要る） */
  const redo = k['確認状況'] === '要再提出';
  const node = render('tpl-form2', {
    '要再提出': k['確認状況'] === '要再提出',
    '確認済': k['確認状況'] === '確認済',
    '表面状態': redo ? '撮り直す' : (k['表面登録済'] ? '登録済み' : '撮影する'),
    '裏面状態': redo ? '撮り直す' : (k['裏面登録済'] ? '登録済み' : '撮影する'),
    '商品注記': 修正可 ? '品名は集荷までご修正いただけます。'
      : '集荷後のお品物は画面から変更できません。LINEでご連絡ください。'
  });

  /* マスタのプルダウン */
  node.querySelectorAll('[data-master]').forEach(sel => {
    const list = r['マスタ'][sel.dataset.master] || [];
    sel.innerHTML = '<option value="">選択してください</option>' +
      list.map(v => `<option>${esc(v)}</option>`).join('');
  });

  const form = node.querySelector('#formForm2');
  /* 既存値を戻す */
  const cur = { '書類種別': k['書類種別'], '職業': k['職業'], '年齢': k['年齢'],
    '金融機関名': g['金融機関名'], '支店名': g['支店名'], '口座種別': g['口座種別'],
    '口座番号': g['口座番号'], '口座名義カナ': g['口座名義カナ'] };
  Object.keys(cur).forEach(n => {
    const el = form.elements[n];
    if (el && cur[n] !== null && cur[n] !== undefined) el.value = cur[n];
  });
  if (k['表面登録済'] && !redo) form.querySelector('[name=表面]').closest('label').querySelector('.shot-box').classList.add('set');
  if (k['裏面登録済'] && !redo) form.querySelector('[name=裏面]').closest('label').querySelector('.shot-box').classList.add('set');

  /* 撮ったら見た目を変える */
  form.querySelectorAll('input[type=file]').forEach(inp => {
    inp.addEventListener('change', () => {
      const box = inp.closest('label').querySelector('.shot-box');
      if (inp.files && inp.files[0]) {
        box.classList.add('set');
        box.querySelector('em').textContent = '撮影しました';
      }
    });
  });

  /* お品物（M-06） */
  const ul = node.querySelector('[data-items2]');
  ul.innerHTML = (r['商品'] || []).map(p => `
    <li>${修正可
      ? `<input data-item="${esc(p['案件商品id'])}" value="${esc(p['品名'])}">`
      : `<span class="nm"><b>${esc(p['品名'])}</b></span>
         <span class="amt">${p['概算額'] ? '概算 ' + yen(p['概算額']) : ''}</span>`}
    </li>`).join('') || '<li class="empty">お品物がありません</li>';
  if (修正可) {
    ul.querySelectorAll('input[data-item]').forEach(inp => {
      inp.addEventListener('change', async () => {
        try {
          await api('item.update', { 案件id: a['案件id'], 案件商品id: inp.dataset.item, 品名: inp.value });
        } catch (e) { alert(e.message); }
      });
    });
  }

  const err = node.querySelector('#form2Err'), ok = node.querySelector('#form2Ok');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    err.hidden = true; ok.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '送信しています…';
    try {
      const fd = new FormData(form);
      const p = {};
      ['書類種別', '職業', '年齢', '金融機関名', '支店名', '口座種別', '口座番号', '口座名義カナ']
        .forEach(n => { p[n] = fd.get(n) || ''; });
      p['表面'] = await imagePayload(form.elements['表面'].files[0]);
      p['裏面'] = await imagePayload(form.elements['裏面'].files[0]);
      await api('form2.post', p);
      ok.hidden = false;
      setTimeout(() => go('top'), 1200);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  mount(node);
}

/* ---------------------------------------------------------------- M-03 / M-09 */
async function viewHistory() {
  const [cs, ps] = await Promise.all([api('cases'), api('payments')]);
  state.hist = { 案件: cs['案件'] || [], 入金: ps['入金'] || [] };
  paintHistory();
}

function paintHistory() {
  const h = state.hist;
  const rows = state.seg === '入金'
    ? h['入金']
    : (state.seg === '査定' ? h['案件'].filter(a => a['査定確定日時']) : h['案件']);
  const node = render('tpl-history', { '空': rows.length === 0 });
  node.querySelectorAll('.segs button').forEach(b => {
    b.classList.toggle('on', b.dataset.seg === state.seg);
    b.addEventListener('click', () => { state.seg = b.dataset.seg; paintHistory(); });
  });
  const ul = node.querySelector('[data-hist]');
  ul.innerHTML = rows.map(r => state.seg === '入金' ? `
    <li>
      <div class="r1"><span class="ttl">${esc(r['案件id'])}</span>
        <span class="amt">${yen(r['振込額'])}</span></div>
      <div class="r2"><span class="dt">${fmtDate(r['振込日'])} お振込み</span>
        <span class="dt">${esc(r['振込先金融機関'] || '')} ${esc(r['振込先支店'] || '')}</span></div>
    </li>` : `
    <li><button data-case="${esc(r['案件id'])}">
      <div class="r1"><span class="ttl">${esc(r['受付番号'])}</span>
        <span class="pill" style="background:${esc(r['ステータス配色'] || '#6b7280')}">${esc(r['案件ステータス'])}</span></div>
      <div class="r2"><span class="dt">${fmtDate(r['申込日時'])} 申し込み ／ ${r['点数'] || 0}点</span>
        <span class="amt">${r['買取金額'] !== null && r['買取金額'] !== undefined ? yen(r['買取金額']) : ''}</span></div>
    </button></li>`).join('');
  ul.querySelectorAll('button[data-case]').forEach(b =>
    b.addEventListener('click', () => go('case', b.dataset.case)));
  mount(node);
}

/* ---------------------------------------------------------------- F-01〜F-05 */
async function viewApply() {
  /* LIFF は「取れれば紐づける」。LINE の外や失敗でもフォームは使える
     （未連携で申し込み、あとからマイページの受付番号照合で紐づく）。
     🔴 IDトークンを先に取り、apply.init に渡す（2回目のお客様に前回の入力を返すため） */
  const line = await initLiff(CFG.LIFF_APPLY, false);
  const init = await api('apply.init');
  const prev = init['前回'];

  const node = render('tpl-apply', {
    '入口説明': line
      ? 'LINEアカウントと紐づけてお申し込みします。ID・パスワードは必要ありません。'
      : 'ID・パスワードは必要ありません。約2分で完了します。'
  });

  /* 宅配キット（M1 の3択カード） */
  node.querySelector('[data-kits]').innerHTML = (init['キット'] || []).map((k, i) => `
    <label>
      <input type="radio" name="宅配キット種別" value="${esc(k['宅配キット'])}" ${i === 1 ? 'checked' : ''} required>
      <span class="kb"><b>${esc(k['宅配キット'])}</b>
        <em>${k['目安点数'] ? '〜' + k['目安点数'] + '点' : ''}</em></span>
    </label>`).join('');

  /* 時間帯 */
  node.querySelector('[name=集荷希望時間帯]').innerHTML =
    '<option value="">選択してください</option>' +
    (init['時間帯'] || []).map(v => `<option value="${esc(v)}">${esc(slotLabel(v))}</option>`).join('');

  /* 同意事項（F-05） */
  node.querySelector('[data-consent]').innerHTML = (init['同意事項'] || []).map((t, i) =>
    `<li>${i === 0
      ? `<a href="${esc(init['規約url'])}" target="_blank" rel="noopener">利用規約</a>・` +
        `<a href="${esc(init['プライバシーurl'])}" target="_blank" rel="noopener">プライバシーポリシー</a>に同意します`
      : esc(t)}</li>`).join('');

  const form = node.querySelector('#formApply');
  const err = node.querySelector('#applyErr');
  const F = n => form.elements[n];

  /* 2回目以降：前回のお名前・ご住所を入れておく（変わっていれば直してもらう） */
  if (prev) {
    ['顧客名', '顧客名カナ', '電話番号', '郵便番号', '都道府県', '住所1', '住所2'].forEach(n => {
      if (prev[n] && F(n)) F(n).value = prev[n];
    });
    const note = document.createElement('p');
    note.className = 'prefill';
    note.textContent = '前回のお名前・ご住所を入れてあります。変わっていればお直しください。';
    form.insertBefore(note, form.firstChild);
  }

  /* 集荷希望日は翌々日を既定に、過去日は選べないようにする（日本時間で数える） */
  const dt = F('集荷希望日');
  const jst = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
  dt.min = jst(Date.now());
  dt.value = jst(Date.now() + 2 * 864e5);

  /* F-02 入力チェック。抜けた欄・形の違う欄をその場で知らせる */
  const RULES = {
    '顧客名': v => v ? '' : 'お名前をご入力ください',
    '顧客名カナ': v => !v || /^[ァ-ヶー\s]+$/.test(v) ? '' : 'カタカナでご入力ください',
    '電話番号': v => /^0\d{9,10}$/.test(v.replace(/\D/g, '')) ? '' : '市外局番からご入力ください（例 09012345678）',
    '郵便番号': v => !v || /^\d{3}-?\d{4}$/.test(v) ? '' : '7桁でご入力ください',
    '都道府県': v => v ? '' : '都道府県をご入力ください',
    '住所1': v => v ? '' : '市区町村・番地をご入力ください',
    '集荷希望日': v => v && v >= dt.min ? '' : '本日以降の日付をお選びください',
    '集荷希望時間帯': v => v ? '' : '時間帯をお選びください',
  };
  const clean = n => {
    const el = F(n);
    let v = nfkc(el.value);
    if (n === '顧客名カナ') v = toKata(v);
    if (el.value !== v && el.type !== 'date') el.value = v;
    return v;
  };
  const check = n => fieldError(F(n), RULES[n](clean(n)));
  Object.keys(RULES).forEach(n => {
    F(n).addEventListener('blur', () => { if (F(n).value || F(n).classList.contains('invalid')) check(n); });
    F(n).addEventListener('change', () => check(n));
  });

  /* F-02 郵便番号からの住所補完 */
  const zipMsg = node.querySelector('#zipMsg');
  node.querySelector('#btnZip').addEventListener('click', async () => {
    const z = nfkc(F('郵便番号').value).replace(/\D/g, '');
    zipMsg.hidden = true;
    if (z.length !== 7) { fieldError(F('郵便番号'), '7桁でご入力ください'); return; }
    fieldError(F('郵便番号'), '');
    try {
      const r = await api('zip', { code: z });
      if (r['見つかった']) {
        F('都道府県').value = r['都道府県'];
        F('住所1').value = r['住所1'];
        fieldError(F('都道府県'), '');
        fieldError(F('住所1'), '');
        F('住所2').focus();
      } else {
        zipMsg.textContent = r['理由']; zipMsg.hidden = false;
      }
    } catch (e) { zipMsg.textContent = e.message; zipMsg.hidden = false; }
  });

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    err.hidden = true;
    const bad = Object.keys(RULES).filter(n => !check(n));
    if (bad.length) {
      F(bad[0]).focus();
      err.textContent = '入力内容をご確認ください（' + bad.length + 'か所）';
      err.hidden = false;
      return;
    }
    if (!F('同意').checked) {
      err.textContent = 'ご確認事項への同意にチェックをお願いします';
      err.hidden = false; return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = '送信しています…';
    try {
      const fd = new FormData(form);
      const p = {};
      ['顧客名', '顧客名カナ', '電話番号', '郵便番号', '都道府県', '住所1', '住所2',
        '宅配キット種別', '集荷希望日', '集荷希望時間帯', '同意'].forEach(n => { p[n] = fd.get(n) || ''; });
      const r = await api('apply', p);
      viewDone(r);
    } catch (e) {
      err.textContent = e.message; err.hidden = false; btn.disabled = false;
      btn.textContent = 'この内容で申し込む';
    }
  });
  mount(node);
}

function viewDone(r) {
  const node = render('tpl-done', {
    '受付番号': r['受付番号'],
    'line注記': r['line送信']
      ? 'LINEのトークにも同じ番号をお送りしました。'
      : 'この番号はマイページを初めて開くときに使います。お控えください。'
  });
  node.querySelector('#btnToMypage').addEventListener('click', () => {
    location.href = CFG.LIFF_MYPAGE ? 'https://liff.line.me/' + CFG.LIFF_MYPAGE : './';
  });
  const back = node.querySelector('#btnToTalk');
  if (window.liff && liff.isInClient && liff.isInClient()) {
    back.hidden = false;
    back.addEventListener('click', () => liff.closeWindow());
  }
  mount(node);
}

/* ---------------------------------------------------------------- 配線 */
if (tabbar) tabbar.addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});
app.addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) go(b.dataset.view);
});
if (btnLogout) btnLogout.addEventListener('click', () => {
  if (window.liff && liff.isLoggedIn()) liff.logout();
  location.reload();
});

boot().catch(e => {
  app.innerHTML = `<div class="card center"><p class="err">${esc(e.message)}</p>
    <button class="btn btn-primary" onclick="location.reload()">やり直す</button></div>`;
});
