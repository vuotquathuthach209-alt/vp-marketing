// ====== State ======
let state = {
  pages: [],
  composeMediaId: null,
};

// ====== API helper ======
async function api(path, opts = {}) {
  const resp = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Lỗi không xác định' }));
    throw new Error(err.error || 'Lỗi');
  }
  return resp.json();
}

// ====== Auth ======
let currentUser = { hotelId: 1, role: 'superadmin', email: '', admin: false };

async function checkAuth() {
  const r = await api('/auth/me');
  if (r.authenticated) {
    currentUser = { hotelId: r.hotelId || 1, role: r.role || 'superadmin', email: r.email || '', admin: r.admin || false };
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  loadPages();
  switchTab('dashboard');

  // Show/hide admin-only elements
  const isAdmin = currentUser.role === 'superadmin';
  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('hidden', !isAdmin);
  });
}

// Login tab switcher
window.switchLoginTab = function(mode) {
  document.getElementById('login-mode').value = mode;
  document.getElementById('login-admin-fields').classList.toggle('hidden', mode !== 'admin');
  document.getElementById('login-hotel-fields').classList.toggle('hidden', mode !== 'hotel');
  document.getElementById('login-tab-admin').classList.toggle('border-blue-600', mode === 'admin');
  document.getElementById('login-tab-admin').classList.toggle('text-blue-600', mode === 'admin');
  document.getElementById('login-tab-admin').classList.toggle('text-slate-400', mode !== 'admin');
  document.getElementById('login-tab-hotel').classList.toggle('border-blue-600', mode === 'hotel');
  document.getElementById('login-tab-hotel').classList.toggle('text-blue-600', mode === 'hotel');
  document.getElementById('login-tab-hotel').classList.toggle('text-slate-400', mode !== 'hotel');
};

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = document.getElementById('login-mode').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  try {
    let body;
    if (mode === 'admin') {
      body = { password: document.getElementById('login-password').value };
    } else {
      body = {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-hotel-password').value,
      };
    }
    const r = await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      await checkAuth();
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  showLogin();
});

// ====== Tabs ======
function switchTab(tab) {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.panel !== tab);
  });
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'posts') loadPosts();
  if (tab === 'media') loadMedia();
  if (tab === 'settings') { loadSettings(); loadAllApiKeys(); loadSysConfig(); }
  if (tab === 'campaigns') loadCampaigns();
  if (tab === 'autoreply') loadAutoReply();
  if (tab === 'wiki') loadWiki();
  if (tab === 'analytics') loadAnalytics();
  if (tab === 'autopilot') loadAutopilotStatus();
}
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

// ====== Pages (select dropdown) ======
async function loadPages() {
  state.pages = await api('/settings/pages');
  const sel = document.getElementById('compose-page');
  sel.innerHTML = '';
  if (state.pages.length === 0) {
    sel.innerHTML = '<option>Chưa có Fanpage - vào Cấu hình để thêm</option>';
  } else {
    state.pages.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} (${p.fb_page_id})`;
      sel.appendChild(o);
    });
  }
}

// ====== Compose ======
const statusEl = () => document.getElementById('compose-status');
function setStatus(msg, type = 'info') {
  const colors = { info: 'text-blue-600', ok: 'text-green-600', err: 'text-red-600' };
  statusEl().className = `mt-4 text-sm ${colors[type] || ''}`;
  statusEl().textContent = msg;
}

document.getElementById('btn-gen-caption').addEventListener('click', async () => {
  const topic = document.getElementById('compose-topic').value.trim();
  if (!topic) return setStatus('Nhập chủ đề trước đã', 'err');
  setStatus('⏳ Claude đang viết caption...');
  try {
    const r = await api('/ai/caption', { method: 'POST', body: JSON.stringify({ topic }) });
    document.getElementById('compose-caption').value = r.caption;
    setStatus('✅ Đã tạo caption', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  }
});

function setMediaPreview(mediaId, mime, filename) {
  state.composeMediaId = mediaId;
  const box = document.getElementById('compose-media-preview');
  if (!mediaId) { box.innerHTML = ''; return; }
  const url = `/api/media/file/${filename}`;
  if (mime.startsWith('video/')) {
    box.innerHTML = `<video src="${url}" controls class="max-h-64 rounded-lg border"></video>
      <button onclick="clearMedia()" class="block mt-1 text-xs text-red-600">✕ Xóa media</button>`;
  } else {
    box.innerHTML = `<img src="${url}" class="max-h-64 rounded-lg border" />
      <button onclick="clearMedia()" class="block mt-1 text-xs text-red-600">✕ Xóa media</button>`;
  }
}
window.clearMedia = () => {
  state.composeMediaId = null;
  document.getElementById('compose-media-preview').innerHTML = '';
};

document.getElementById('btn-gen-image').addEventListener('click', async () => {
  const caption = document.getElementById('compose-caption').value.trim();
  if (!caption) return setStatus('Viết caption trước (hoặc bấm AI viết caption)', 'err');
  setStatus('⏳ Đang tạo ảnh AI (Flux)... ~15s');
  try {
    const r = await api('/ai/image', { method: 'POST', body: JSON.stringify({ caption }) });
    // Lấy thông tin media vừa tạo
    const list = await api('/media');
    const m = list.find((x) => x.id === r.mediaId);
    if (m) setMediaPreview(m.id, m.mime_type, m.filename);
    setStatus('✅ Đã tạo ảnh', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  }
});

document.getElementById('btn-gen-video').addEventListener('click', async () => {
  const caption = document.getElementById('compose-caption').value.trim();
  if (!caption) return setStatus('Viết caption trước đã', 'err');
  if (!confirm('Tạo video 5s bằng Kling, mất ~2 phút và tốn ~$0.35. Tiếp tục?')) return;
  setStatus('⏳ Đang tạo video AI... 1-3 phút, vui lòng chờ');
  try {
    const r = await api('/ai/video', { method: 'POST', body: JSON.stringify({ caption }) });
    const list = await api('/media');
    const m = list.find((x) => x.id === r.mediaId);
    if (m) setMediaPreview(m.id, m.mime_type, m.filename);
    setStatus('✅ Đã tạo video', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  }
});

document.getElementById('compose-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('⏳ Đang upload...');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
    const r = await resp.json();
    if (!resp.ok) throw new Error(r.error);
    setMediaPreview(r.id, file.type, r.filename);
    setStatus('✅ Upload xong', 'ok');
  } catch (err) {
    setStatus('❌ ' + err.message, 'err');
  }
});

async function createPost(mode) {
  const page_id = parseInt(document.getElementById('compose-page').value, 10);
  const caption = document.getElementById('compose-caption').value.trim();
  const schedInput = document.getElementById('compose-schedule').value;

  if (!page_id) return setStatus('Chọn Fanpage', 'err');
  if (!caption) return setStatus('Thiếu caption', 'err');

  const body = {
    page_id,
    caption,
    media_id: state.composeMediaId,
  };

  if (mode === 'now') body.publish_now = true;
  else if (mode === 'schedule') {
    if (!schedInput) return setStatus('Chọn thời gian lên lịch', 'err');
    body.scheduled_at = new Date(schedInput).getTime();
  }

  setStatus('⏳ Đang xử lý...');
  try {
    const r = await api('/posts', { method: 'POST', body: JSON.stringify(body) });
    if (mode === 'now') {
      setStatus('⏳ Đang đăng lên Facebook...');
      await api(`/posts/${r.id}/publish-now`, { method: 'POST' });
      setStatus('✅ Đã đăng lên Facebook!', 'ok');
    } else if (mode === 'schedule') {
      setStatus('✅ Đã lên lịch - scheduler sẽ đăng đúng giờ', 'ok');
    } else {
      setStatus('✅ Đã lưu nháp', 'ok');
    }
    // Reset form
    state.composeMediaId = null;
    document.getElementById('compose-media-preview').innerHTML = '';
    document.getElementById('compose-caption').value = '';
    document.getElementById('compose-topic').value = '';
    document.getElementById('compose-schedule').value = '';
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  }
}

document.getElementById('btn-publish-now').addEventListener('click', () => createPost('now'));
document.getElementById('btn-schedule').addEventListener('click', () => createPost('schedule'));
document.getElementById('btn-draft').addEventListener('click', () => createPost('draft'));

// ====== Posts list ======
async function loadPosts() {
  const items = await api('/posts');
  const el = document.getElementById('posts-list');
  if (items.length === 0) {
    el.innerHTML = '<p class="text-slate-500">Chưa có bài đăng nào</p>';
    return;
  }
  el.innerHTML = items.map((p) => {
    const statusColors = {
      draft: 'bg-slate-200 text-slate-700',
      scheduled: 'bg-blue-100 text-blue-700',
      publishing: 'bg-yellow-100 text-yellow-700',
      published: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
    };
    const statusLabel = {
      draft: 'Nháp', scheduled: 'Đã lên lịch', publishing: 'Đang đăng',
      published: 'Đã đăng', failed: 'Thất bại',
    };
    const sched = p.scheduled_at ? new Date(p.scheduled_at).toLocaleString('vi-VN') : '-';
    const pub = p.published_at ? new Date(p.published_at).toLocaleString('vi-VN') : '';
    return `
      <div class="bg-white rounded-xl shadow p-4">
        <div class="flex justify-between mb-2">
          <div>
            <span class="font-semibold">${p.page_name || 'N/A'}</span>
            <span class="ml-2 text-xs px-2 py-1 rounded ${statusColors[p.status] || ''}">${statusLabel[p.status] || p.status}</span>
          </div>
          <button onclick="delPost(${p.id})" class="text-red-500 text-sm">Xóa</button>
        </div>
        <p class="text-sm whitespace-pre-wrap">${p.caption.slice(0, 300)}${p.caption.length > 300 ? '...' : ''}</p>
        ${p.media_filename ? `<p class="text-xs text-slate-500 mt-1">📎 ${p.media_filename}</p>` : ''}
        <div class="text-xs text-slate-500 mt-2">
          Lên lịch: ${sched} ${pub ? `• Đã đăng: ${pub}` : ''}
          ${p.error_message ? `<div class="text-red-600 mt-1">Lỗi: ${p.error_message}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
window.delPost = async (id) => {
  if (!confirm('Xóa bài này?')) return;
  await api(`/posts/${id}`, { method: 'DELETE' });
  loadPosts();
};

// ====== Media library ======
async function loadMedia() {
  const items = await api('/media');
  const el = document.getElementById('media-grid');
  if (items.length === 0) {
    el.innerHTML = '<p class="text-slate-500 col-span-4">Thư viện trống</p>';
    return;
  }
  el.innerHTML = items.map((m) => {
    const url = `/api/media/file/${m.filename}`;
    const isVideo = m.mime_type.startsWith('video/');
    return `
      <div class="bg-white rounded-xl shadow p-2">
        ${isVideo
          ? `<video src="${url}" class="media-thumb" controls></video>`
          : `<img src="${url}" class="media-thumb" />`}
        <div class="text-xs p-2">
          <div class="truncate">${m.filename}</div>
          <div class="text-slate-500">${m.source} • ${(m.size/1024).toFixed(0)}KB</div>
          <button onclick="delMedia(${m.id})" class="text-red-500 mt-1">Xóa</button>
        </div>
      </div>
    `;
  }).join('');
}
window.delMedia = async (id) => {
  if (!confirm('Xóa media này?')) return;
  await api(`/media/${id}`, { method: 'DELETE' });
  loadMedia();
};

// ====== Settings ======
async function loadSettings() {
  const s = await api('/settings');
  const render = (elId, summary) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const c = summary?.count || 0;
    el.textContent = c > 0
      ? `(${c} key: ${summary.masked.replace(/\n/g, ', ')})`
      : '(chưa có)';
    el.className = 'ml-2 text-xs font-normal ' + (c > 0 ? 'text-green-600' : 'text-slate-400');
  };
  render('anthropic-count', s.anthropic);
  render('google-count', s.google);
  render('groq-count', s.groq);
  render('fal-count', s.fal);

  ['key-anthropic', 'key-google', 'key-groq', 'key-fal'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  loadRouterStatus();
  loadTelegramStatus();
  loadPagesInSettings();
  loadBookingConfig();
  loadPendingBookings();
}

async function loadRouterStatus() {
  const el = document.getElementById('router-status');
  if (!el) return;
  try {
    const r = await api('/settings/router');
    const PROVIDER_COLOR = {
      anthropic: 'bg-purple-100 text-purple-700',
      google:    'bg-blue-100 text-blue-700',
      groq:      'bg-green-100 text-green-700',
    };
    const TASK_LABEL = {
      caption:       '✍️ Viết caption chính',
      image_prompt:  '🎨 Tạo prompt ảnh (EN)',
      classify:      '🏷️ Phân loại comment/intent',
      reply_simple:  '💬 Reply comment đơn giản',
      reply_complex: '💭 Reply inbox/khiếu nại phức tạp',
    };
    const rows = Object.entries(r.tasks).map(([task, info]) => {
      if (info.error) {
        return `<div class="flex justify-between border-b pb-1"><span>${TASK_LABEL[task] || task}</span><span class="text-red-500 text-xs">${info.error}</span></div>`;
      }
      const badge = PROVIDER_COLOR[info.provider] || 'bg-slate-100';
      const note = info.default ? '' : '<span class="text-orange-500 text-xs ml-1">(fallback)</span>';
      return `<div class="flex justify-between items-center border-b pb-1">
        <span>${TASK_LABEL[task] || task}</span>
        <span><span class="${badge} px-2 py-0.5 rounded text-xs font-mono">${info.provider} / ${info.model}</span>${note}</span>
      </div>`;
    }).join('');
    const prov = r.providers;
    const availRow = `<div class="text-xs text-slate-500 mt-3 pt-3 border-t">
      Providers:
      <span class="${prov.anthropic.configured ? 'text-green-600' : 'text-slate-400'}">Anthropic (${prov.anthropic.count})</span> •
      <span class="${prov.google.configured ? 'text-green-600' : 'text-slate-400'}">Google (${prov.google.count})</span> •
      <span class="${prov.groq.configured ? 'text-green-600' : 'text-slate-400'}">Groq (${prov.groq.count})</span>
    </div>`;
    el.innerHTML = rows + availRow;
  } catch (e) {
    el.innerHTML = `<div class="text-red-500 text-xs">${e.message}</div>`;
  }
}

async function loadPagesInSettings() {
  const pages = await api('/settings/pages');
  const el = document.getElementById('pages-list');
  if (pages.length === 0) {
    el.innerHTML = '<p class="text-sm text-slate-500">Chưa có Fanpage nào</p>';
    return;
  }
  el.innerHTML = pages.map((p) => `
    <div class="flex justify-between items-center border rounded-lg p-3">
      <div>
        <div class="font-semibold">${p.name}</div>
        <div class="text-xs text-slate-500">ID: ${p.fb_page_id}</div>
      </div>
      <button onclick="delPage(${p.id})" class="text-red-500 text-sm">Xóa</button>
    </div>
  `).join('');
}
window.delPage = async (id) => {
  if (!confirm('Xóa Fanpage này?')) return;
  await api(`/settings/pages/${id}`, { method: 'DELETE' });
  loadPagesInSettings();
  loadPages();
};

document.getElementById('btn-save-keys').addEventListener('click', async () => {
  const body = {
    anthropic_api_key: document.getElementById('key-anthropic').value,
    google_api_key: document.getElementById('key-google').value,
    groq_api_key: document.getElementById('key-groq').value,
    fal_api_key: document.getElementById('key-fal').value,
  };
  try {
    const r = await api('/settings/keys', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('keys-status').textContent =
      `✅ Đã lưu (${r.anthropic_count}A / ${r.google_count}G / ${r.groq_count}Gr / ${r.fal_count}F)`;
    await loadSettings();
    setTimeout(() => document.getElementById('keys-status').textContent = '', 4000);
  } catch (e) {
    alert(e.message);
  }
});

// Load + save image provider
(async () => {
  try {
    const r = await api('/settings/image-provider');
    const sel = document.getElementById('image-provider');
    if (sel && r.provider) sel.value = r.provider;
  } catch {}
})();
document.getElementById('btn-save-image-provider')?.addEventListener('click', async () => {
  const provider = document.getElementById('image-provider').value;
  try {
    await api('/settings/image-provider', { method: 'POST', body: JSON.stringify({ provider }) });
    const el = document.getElementById('image-provider-status');
    el.textContent = '✅ Đã lưu';
    setTimeout(() => (el.textContent = ''), 3000);
  } catch (e) {
    alert(e.message);
  }
});

// ====== Autopilot ======
const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const DAY_FULL = ['Chu Nhat', 'Thu Hai', 'Thu Ba', 'Thu Tu', 'Thu Nam', 'Thu Sau', 'Thu Bay'];
const SOURCE_ICONS = { gdrive: '📁', ai: '🤖', web: '🌐', unsplash: '📷' };
const HOOK_LABELS = { question: '❓ Cau hoi', fomo: '🔥 FOMO', story: '📖 Ke chuyen', stats: '📊 So lieu', tips: '💡 Meo', controversial: '⚡ Tranh cai' };

async function loadAutopilotStatus() {
  try {
    const r = await api('/autopilot/status');
    const badge = document.getElementById('autopilot-status-badge');
    badge.innerHTML = r.enabled
      ? '<span class="text-green-600">🟢 DANG CHAY</span>'
      : '<span class="text-slate-500">⚪ TAT</span>';
    const info = document.getElementById('autopilot-info');
    const p = r.currentPillar;
    info.innerHTML = `
      <div>📋 Hom nay: <b>${p.emoji} ${p.name}</b> — ${p.description}</div>
      <div>📝 Noi dung: <b>${p.content_type}</b> | Anh: <b>${SOURCE_ICONS[p.image_source] || '🤖'} ${p.image_source}</b> | Hook: <b>${HOOK_LABELS[p.hook_style] || p.hook_style}</b></div>
      <div>⏰ Gio dang: <b>${r.postTimes.join(', ')}</b> | Bai/ngay: <b>${r.postsPerDay}</b></div>
      ${r.gdriveFolder ? `<div>📁 GDrive: <b>${r.gdriveImageCount} anh</b> da sync</div>` : '<div class="text-amber-600">⚠️ Chua ket noi Google Drive — anh khach san se dung AI gen</div>'}
    `;

    // Render calendar
    renderCalendar(r.calendar || []);

    // Load GDrive settings
    const gd = await api('/autopilot/gdrive').catch(() => ({}));
    if (gd.folderId) document.getElementById('gdrive-folder-id').value = gd.folderId;
    const gdKeyEl = document.getElementById('gdrive-api-key');
    if (gd.apiKey && gdKeyEl) gdKeyEl.placeholder = `✅ Da co key (${gd.keySource || ''})`;
    const keyStatus = document.getElementById('gdrive-key-status');
    if (keyStatus) {
      if (gd.apiKey) {
        keyStatus.innerHTML = `✅ <b>API Key:</b> <span class="text-green-600">${gd.keySource || 'configured'}</span>`;
      } else {
        keyStatus.innerHTML = `⚠️ Nhap Google API Key (phai bat Drive API tren Cloud Console)`;
      }
    }
  } catch {}
}
loadAutopilotStatus();

function renderCalendar(calendar) {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  const today = new Date().getDay();
  grid.innerHTML = calendar.map((day, i) => {
    const isToday = day.day_of_week === today;
    const src = SOURCE_ICONS[day.image_source] || '🤖';
    return `
      <div class="p-3 rounded-lg border ${isToday ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-300' : 'border-slate-200 bg-slate-50'} cursor-pointer hover:shadow-md transition" onclick="editCalendarDay(${day.day_of_week})">
        <div class="font-bold ${isToday ? 'text-indigo-700' : 'text-slate-700'}">${DAY_NAMES[day.day_of_week]}</div>
        <div class="text-lg my-1">${day.pillar_emoji}</div>
        <div class="font-semibold text-[11px]">${day.pillar_name}</div>
        <div class="text-[10px] text-slate-500 mt-1">${src} ${day.image_source}</div>
        <div class="text-[10px] text-slate-400">${day.hook_style}</div>
      </div>`;
  }).join('');
}

window.editCalendarDay = function(dow) {
  const types = ['product','news_brand','tips','behind_scenes','lifestyle','community'];
  const sources = ['gdrive','ai','web','unsplash'];
  const hooks = ['question','fomo','story','stats','tips','controversial'];
  const html = `
    <div class="fixed inset-0 bg-black/40 flex items-center justify-center z-50" id="cal-modal">
      <div class="bg-white rounded-xl p-6 w-96 shadow-2xl">
        <h3 class="font-bold text-lg mb-4">📅 ${DAY_FULL[dow]}</h3>
        <label class="block text-xs font-semibold mb-1">Loai noi dung</label>
        <select id="cal-type" class="w-full border rounded px-3 py-2 text-sm mb-3">
          ${types.map(t => `<option value="${t}">${t}</option>`).join('')}
        </select>
        <label class="block text-xs font-semibold mb-1">Nguon anh</label>
        <select id="cal-source" class="w-full border rounded px-3 py-2 text-sm mb-3">
          ${sources.map(s => `<option value="${s}">${SOURCE_ICONS[s]||''} ${s}</option>`).join('')}
        </select>
        <label class="block text-xs font-semibold mb-1">Hook style</label>
        <select id="cal-hook" class="w-full border rounded px-3 py-2 text-sm mb-3">
          ${hooks.map(h => `<option value="${h}">${HOOK_LABELS[h]||h}</option>`).join('')}
        </select>
        <label class="block text-xs font-semibold mb-1">Ten pillar</label>
        <input id="cal-name" class="w-full border rounded px-3 py-2 text-sm mb-3" placeholder="VD: Product" />
        <label class="block text-xs font-semibold mb-1">Emoji</label>
        <input id="cal-emoji" class="w-full border rounded px-3 py-2 text-sm mb-3" placeholder="🏨" maxlength="4" />
        <label class="block text-xs font-semibold mb-1">Mo ta</label>
        <input id="cal-desc" class="w-full border rounded px-3 py-2 text-sm mb-4" placeholder="Gioi thieu phong..." />
        <div class="flex gap-2">
          <button onclick="saveCalendarDay(${dow})" class="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-semibold">Luu</button>
          <button onclick="document.getElementById('cal-modal').remove()" class="flex-1 bg-slate-200 py-2 rounded-lg text-sm">Huy</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
};

window.saveCalendarDay = async function(dow) {
  try {
    await api('/autopilot/calendar', { method: 'POST', body: JSON.stringify({
      day_of_week: dow,
      content_type: document.getElementById('cal-type').value,
      image_source: document.getElementById('cal-source').value,
      hook_style: document.getElementById('cal-hook').value,
      pillar_name: document.getElementById('cal-name').value || 'Custom',
      pillar_emoji: document.getElementById('cal-emoji').value || '📝',
      pillar_desc: document.getElementById('cal-desc').value || '',
    })});
    document.getElementById('cal-modal')?.remove();
    loadAutopilotStatus();
  } catch (e) { alert('Loi: ' + e.message); }
};

document.getElementById('btn-autopilot-on')?.addEventListener('click', async () => {
  await api('/autopilot/enable', { method: 'POST' });
  loadAutopilotStatus();
});
document.getElementById('btn-autopilot-off')?.addEventListener('click', async () => {
  await api('/autopilot/disable', { method: 'POST' });
  loadAutopilotStatus();
});
document.getElementById('btn-autopilot-run')?.addEventListener('click', async () => {
  const pre = document.getElementById('autopilot-report');
  pre.classList.remove('hidden');
  pre.textContent = '⏳ Dang chay autopilot (nghien cuu → viet caption → tao anh)...';
  try {
    const pageId = state.pages?.[0]?.id;
    if (!pageId) { pre.textContent = '❌ Chua co Fanpage nao. Them Fanpage truoc.'; return; }
    const r = await api('/autopilot/run-now', { method: 'POST', body: JSON.stringify({ pageId }) });
    if (!r.ok) { pre.textContent = '❌ ' + (r.error || 'Khong tao duoc bai'); return; }
    pre.textContent = `✅ Da tao post #${r.postId}\n📝 Chu de: ${r.topic}\n🖼️ Anh: ${r.mediaId ? 'Co (ID ' + r.mediaId + ')' : 'Khong'} [${r.imageSource || 'ai'}]\n🎯 Hook: ${r.hookStyle || '?'} | Content: ${r.contentType || '?'}\n⏰ Len lich: ${new Date(r.scheduledAt).toLocaleString('vi-VN')}\n\n${r.caption}`;
  } catch (e) {
    pre.textContent = '❌ Loi: ' + e.message;
  }
});
document.getElementById('btn-autopilot-morning')?.addEventListener('click', async () => {
  const pre = document.getElementById('autopilot-report');
  pre.classList.remove('hidden');
  pre.textContent = '⏳ Dang nghien cuu chu de...';
  try {
    const r = await api('/autopilot/morning-report');
    pre.textContent = r.report;
  } catch (e) { pre.textContent = '❌ ' + e.message; }
});
document.getElementById('btn-autopilot-evening')?.addEventListener('click', async () => {
  const pre = document.getElementById('autopilot-report');
  pre.classList.remove('hidden');
  pre.textContent = '⏳ Dang tong hop...';
  try {
    const r = await api('/autopilot/evening-report');
    pre.textContent = r.report;
  } catch (e) { pre.textContent = '❌ ' + e.message; }
});

// Google Drive
document.getElementById('btn-gdrive-save')?.addEventListener('click', async () => {
  const st = document.getElementById('gdrive-status');
  try {
    const apiKeyVal = document.getElementById('gdrive-api-key').value.trim();
    await api('/autopilot/gdrive', { method: 'POST', body: JSON.stringify({
      folderId: document.getElementById('gdrive-folder-id').value,
      apiKey: apiKeyVal || undefined,
      clearKey: !apiKeyVal, // Clear bad key if field is empty
    })});
    st.textContent = '✅ Da luu';
    st.className = 'text-sm text-green-600';
    loadAutopilotStatus();
  } catch (e) { st.textContent = '❌ ' + e.message; st.className = 'text-sm text-red-600'; }
});
document.getElementById('btn-gdrive-sync')?.addEventListener('click', async () => {
  const st = document.getElementById('gdrive-status');
  st.textContent = '⏳ Dang sync...';
  st.className = 'text-sm text-blue-600';
  try {
    const r = await api('/autopilot/gdrive/sync', { method: 'POST' });
    st.textContent = `✅ Sync xong: ${r.count} anh`;
    st.className = 'text-sm text-green-600';
    loadAutopilotStatus();
  } catch (e) { st.textContent = '❌ ' + e.message; st.className = 'text-sm text-red-600'; }
});

// Nút 🗑️ xoá toàn bộ key của 1 provider
document.querySelectorAll('.btn-wipe').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const provider = btn.getAttribute('data-wipe');
    if (!confirm(`Xoá TẤT CẢ key của ${provider}? Hành động không thể hoàn tác.`)) return;
    try {
      await api(`/settings/keys/${provider}`, { method: 'DELETE' });
      document.getElementById('keys-status').textContent = `🗑️ Đã xoá toàn bộ key ${provider}`;
      await loadSettings();
      setTimeout(() => document.getElementById('keys-status').textContent = '', 4000);
    } catch (err) {
      alert(err.message);
    }
  });
});

document.getElementById('btn-add-page').addEventListener('click', async () => {
  const body = {
    fb_page_id: document.getElementById('page-fbid').value.trim(),
    access_token: document.getElementById('page-token').value.trim(),
    name: document.getElementById('page-name').value.trim(),
  };
  const el = document.getElementById('page-status');
  el.className = 'text-sm mt-2 text-blue-600';
  el.textContent = '⏳ Đang verify token...';
  try {
    const r = await api('/settings/pages', { method: 'POST', body: JSON.stringify(body) });
    el.className = 'text-sm mt-2 text-green-600';
    el.textContent = `✅ Đã thêm: ${r.name}`;
    document.getElementById('page-fbid').value = '';
    document.getElementById('page-token').value = '';
    document.getElementById('page-name').value = '';
    loadPagesInSettings();
    loadPages();
  } catch (e) {
    el.className = 'text-sm mt-2 text-red-600';
    el.textContent = '❌ ' + e.message;
  }
});

// ====== Facebook Connect ======
let fbConnectPages = []; // Pages returned from FB

// CÁCH 1: Paste User Token → Lấy Pages
document.getElementById('btn-fb-fetch-pages').addEventListener('click', async () => {
  const userToken = document.getElementById('fb-user-token').value.trim();
  const statusEl = document.getElementById('fb-connect-status');
  if (!userToken) {
    statusEl.className = 'text-sm mt-2 text-red-600';
    statusEl.textContent = '❌ Paste User Access Token vào ô trên';
    return;
  }
  statusEl.className = 'text-sm mt-2 text-blue-600';
  statusEl.textContent = '⏳ Đang lấy danh sách Pages...';
  await fetchFBPages(userToken);
});

// CÁCH 2: FB SDK Login (backup)
document.getElementById('btn-fb-connect').addEventListener('click', async () => {
  const statusEl = document.getElementById('fb-connect-status');
  statusEl.className = 'text-sm mt-2 text-blue-600';
  statusEl.textContent = '⏳ Đang kết nối Facebook...';

  // Get FB App ID from server
  let appId = '';
  try {
    const r = await api('/settings/fb-app-id');
    appId = r.app_id;
  } catch {}

  if (!appId) {
    statusEl.className = 'text-sm mt-2 text-red-600';
    statusEl.textContent = '❌ Chưa cấu hình FB App ID. Admin vào Hệ thống → Facebook App để nhập.';
    return;
  }

  // Load FB SDK dynamically
  if (!window.FB) {
    await new Promise((resolve) => {
      window.fbAsyncInit = function() {
        FB.init({ appId, cookie: true, xfbml: false, version: 'v21.0' });
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://connect.facebook.net/vi_VN/sdk.js';
      s.async = true;
      document.head.appendChild(s);
    });
  }

  // Login with required permissions
  FB.login(function(response) {
    if (response.authResponse) {
      const userToken = response.authResponse.accessToken;
      statusEl.textContent = '⏳ Đang lấy danh sách Pages...';
      fetchFBPages(userToken);
    } else {
      statusEl.className = 'text-sm mt-2 text-red-600';
      statusEl.textContent = '❌ Bạn đã huỷ đăng nhập Facebook';
    }
  }, {
    scope: 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_messaging,pages_read_user_content',
    auth_type: 'rerequest'
  });
});

async function fetchFBPages(userToken) {
  const statusEl = document.getElementById('fb-connect-status');
  try {
    const r = await api('/settings/fb-connect', {
      method: 'POST',
      body: JSON.stringify({ user_access_token: userToken }),
    });
    fbConnectPages = r.pages || [];

    if (fbConnectPages.length === 0) {
      statusEl.className = 'text-sm mt-2 text-orange-600';
      statusEl.textContent = '⚠️ Không tìm thấy Page nào. Bạn cần là Admin của Page.';
      return;
    }

    // Show page picker
    const pickerEl = document.getElementById('fb-pages-picker');
    const listEl = document.getElementById('fb-pages-list');
    pickerEl.classList.remove('hidden');

    listEl.innerHTML = fbConnectPages.map((p, i) => `
      <label class="flex items-center gap-3 border rounded-lg p-3 cursor-pointer hover:bg-blue-50">
        <input type="checkbox" class="fb-page-check" data-idx="${i}" checked class="w-4 h-4" />
        ${p.picture ? `<img src="${p.picture}" class="w-10 h-10 rounded-full" />` : ''}
        <div>
          <div class="font-semibold text-sm">${p.name}</div>
          <div class="text-xs text-slate-500">ID: ${p.fb_page_id} ${p.category ? '• ' + p.category : ''} ${p.fan_count ? '• ' + p.fan_count.toLocaleString() + ' likes' : ''}</div>
        </div>
      </label>
    `).join('');

    statusEl.className = 'text-sm mt-2 text-green-600';
    statusEl.textContent = `✅ Tìm thấy ${fbConnectPages.length} Page. Chọn và bấm "Thêm Pages đã chọn"`;
  } catch (e) {
    statusEl.className = 'text-sm mt-2 text-red-600';
    statusEl.textContent = '❌ ' + e.message;
  }
}

document.getElementById('btn-fb-add-selected')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('fb-connect-status');
  const checks = document.querySelectorAll('.fb-page-check:checked');
  const selected = Array.from(checks).map(cb => fbConnectPages[parseInt(cb.dataset.idx)]);

  if (selected.length === 0) {
    statusEl.className = 'text-sm mt-2 text-orange-600';
    statusEl.textContent = '⚠️ Chọn ít nhất 1 Page';
    return;
  }

  statusEl.className = 'text-sm mt-2 text-blue-600';
  statusEl.textContent = `⏳ Đang thêm ${selected.length} Page...`;

  try {
    const r = await api('/settings/pages/bulk-add', {
      method: 'POST',
      body: JSON.stringify({ pages: selected }),
    });
    const added = r.results.filter(x => x.status === 'added').length;
    const updated = r.results.filter(x => x.status === 'updated').length;
    const errors = r.results.filter(x => x.status === 'error');

    let msg = `✅ Thành công! ${added} page mới`;
    if (updated > 0) msg += `, ${updated} page cập nhật token`;
    if (errors.length > 0) msg += `, ${errors.length} lỗi`;

    statusEl.className = 'text-sm mt-2 text-green-600';
    statusEl.textContent = msg;
    document.getElementById('fb-pages-picker').classList.add('hidden');
    loadPagesInSettings();
    loadPages();
  } catch (e) {
    statusEl.className = 'text-sm mt-2 text-red-600';
    statusEl.textContent = '❌ ' + e.message;
  }
});

// ====== Campaigns ======
async function loadCampaigns() {
  // Populate page dropdown
  if (state.pages.length === 0) await loadPages();
  const sel = document.getElementById('camp-page');
  sel.innerHTML = '';
  state.pages.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  });

  const items = await api('/campaigns');
  const el = document.getElementById('campaigns-list');
  if (items.length === 0) {
    el.innerHTML = '<p class="text-slate-500 text-sm">Chưa có chiến dịch nào</p>';
    return;
  }
  el.innerHTML = items.map((c) => `
    <div class="bg-white rounded-xl shadow p-4">
      <div class="flex justify-between items-start mb-2">
        <div>
          <div class="font-bold text-lg">${c.name}</div>
          <div class="text-sm text-slate-500">Fanpage: ${c.page_name || 'N/A'}</div>
        </div>
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1 text-sm">
            <input type="checkbox" ${c.active ? 'checked' : ''} onchange="toggleCampaign(${c.id}, this.checked)" class="w-4 h-4" />
            ${c.active ? 'Đang chạy' : 'Tạm dừng'}
          </label>
          <button onclick="delCampaign(${c.id})" class="text-red-500 text-sm ml-2">Xóa</button>
        </div>
      </div>
      <div class="text-sm">
        <div><span class="font-semibold">Giờ đăng:</span> ${c.times.join(', ')}</div>
        <div class="mt-1"><span class="font-semibold">Chủ đề (${c.topics.length}):</span></div>
        <ul class="list-disc ml-5 text-slate-600 text-xs mt-1">
          ${c.topics.slice(0, 5).map((t) => `<li>${t}</li>`).join('')}
          ${c.topics.length > 5 ? `<li class="italic">...và ${c.topics.length - 5} chủ đề khác</li>` : ''}
        </ul>
        <div class="text-xs text-slate-500 mt-2">
          ${c.with_image ? '🎨 Có ảnh AI' : '📝 Chỉ text'}
        </div>
      </div>
    </div>
  `).join('');
}

window.toggleCampaign = async (id, active) => {
  await api(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
  loadCampaigns();
};
window.delCampaign = async (id) => {
  if (!confirm('Xóa chiến dịch này?')) return;
  await api(`/campaigns/${id}`, { method: 'DELETE' });
  loadCampaigns();
};

document.getElementById('btn-create-campaign').addEventListener('click', async () => {
  const name = document.getElementById('camp-name').value.trim();
  const page_id = parseInt(document.getElementById('camp-page').value, 10);
  const topics = document.getElementById('camp-topics').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const times = document.getElementById('camp-times').value.split(',').map((s) => s.trim()).filter(Boolean);
  const with_image = document.getElementById('camp-with-image').checked;

  const statusEl = document.getElementById('camp-status');
  if (!name) { statusEl.className = 'text-sm mt-3 text-red-600'; statusEl.textContent = 'Thiếu tên chiến dịch'; return; }
  if (topics.length === 0) { statusEl.className = 'text-sm mt-3 text-red-600'; statusEl.textContent = 'Thiếu chủ đề'; return; }
  if (times.length === 0) { statusEl.className = 'text-sm mt-3 text-red-600'; statusEl.textContent = 'Thiếu giờ đăng'; return; }

  try {
    await api('/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name, page_id, topics, times, with_image, active: true }),
    });
    statusEl.className = 'text-sm mt-3 text-green-600';
    statusEl.textContent = '✅ Đã tạo chiến dịch';
    document.getElementById('camp-name').value = '';
    document.getElementById('camp-topics').value = '';
    loadCampaigns();
  } catch (e) {
    statusEl.className = 'text-sm mt-3 text-red-600';
    statusEl.textContent = '❌ ' + e.message;
  }
});

// ====== Auto Reply ======
async function loadAutoReply() {
  const configs = await api('/auto-reply/config');
  const el = document.getElementById('autoreply-config');
  if (configs.length === 0) {
    el.innerHTML = '<p class="text-slate-500">Chưa có Fanpage nào. Thêm ở tab Cấu hình trước.</p>';
  } else {
    el.innerHTML = configs.map((c) => `
      <div class="bg-white rounded-xl shadow p-5">
        <h3 class="font-bold text-lg mb-3">${c.name}</h3>
        <div class="space-y-2 mb-3">
          <label class="flex items-center gap-2">
            <input type="checkbox" id="ar-comments-${c.page_id}" ${c.reply_comments ? 'checked' : ''} class="w-4 h-4" />
            <span>Tự trả lời <strong>comment</strong> (cần quyền pages_manage_engagement)</span>
          </label>
          <label class="flex items-center gap-2">
            <input type="checkbox" id="ar-messages-${c.page_id}" ${c.reply_messages ? 'checked' : ''} class="w-4 h-4" />
            <span>Tự trả lời <strong>tin nhắn inbox</strong> (cần quyền pages_messaging)</span>
          </label>
        </div>
        <label class="block text-sm font-semibold mb-1">Cá tính/giọng trả lời (để trống = mặc định CSKH du lịch)</label>
        <textarea id="ar-prompt-${c.page_id}" rows="4" class="w-full border rounded-lg px-3 py-2 text-sm">${c.system_prompt || ''}</textarea>
        <button onclick="saveAutoReply(${c.page_id})" class="mt-3 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">
          💾 Lưu cho page này
        </button>
        <span id="ar-status-${c.page_id}" class="ml-3 text-sm"></span>
      </div>
    `).join('');
  }

  // Load log
  const logs = await api('/auto-reply/log');
  const logEl = document.getElementById('autoreply-log');
  if (logs.length === 0) {
    logEl.innerHTML = '<p class="text-slate-500 text-sm">Chưa có reply nào</p>';
  } else {
    logEl.innerHTML = logs.map((l) => {
      const time = new Date(l.created_at).toLocaleString('vi-VN');
      const kind = l.kind === 'comment' ? '💬 Comment' : '✉️ Inbox';
      const statusColor = l.status === 'sent' ? 'text-green-600' : 'text-red-600';
      return `
        <div class="bg-white rounded-lg shadow p-3 text-sm">
          <div class="flex justify-between">
            <span class="font-semibold">${kind} • ${l.page_name || 'N/A'}</span>
            <span class="${statusColor}">${l.status === 'sent' ? '✓ Đã gửi' : '✗ Lỗi'} • ${time}</span>
          </div>
          <div class="mt-1"><span class="text-slate-500">Khách:</span> "${(l.original_text || '').slice(0, 150)}"</div>
          <div class="mt-1"><span class="text-slate-500">Trả lời:</span> ${l.reply_text || ''}</div>
          ${l.error ? `<div class="text-red-600 text-xs mt-1">Lỗi: ${l.error}</div>` : ''}
        </div>
      `;
    }).join('');
  }
}

window.saveAutoReply = async (pageId) => {
  const body = {
    page_id: pageId,
    reply_comments: document.getElementById(`ar-comments-${pageId}`).checked,
    reply_messages: document.getElementById(`ar-messages-${pageId}`).checked,
    system_prompt: document.getElementById(`ar-prompt-${pageId}`).value,
  };
  const st = document.getElementById(`ar-status-${pageId}`);
  try {
    await api('/auto-reply/config', { method: 'POST', body: JSON.stringify(body) });
    st.className = 'ml-3 text-sm text-green-600';
    st.textContent = '✅ Đã lưu';
    setTimeout(() => st.textContent = '', 3000);
  } catch (e) {
    st.className = 'ml-3 text-sm text-red-600';
    st.textContent = '❌ ' + e.message;
  }
};

// ====== Wiki (Knowledge Base) ======
const WIKI_NS_LABELS = {
  business: '🏢 business',
  product: '🏨 product',
  campaign: '🎯 campaign',
  faq: '❓ faq',
  lesson: '📚 lesson',
};

async function loadWiki() {
  await loadWikiStats();
  await loadWikiList();
}

async function loadWikiStats() {
  const stats = await api('/wiki/stats');
  const counts = { business: 0, product: 0, campaign: 0, faq: 0, lesson: 0 };
  for (const s of stats) counts[s.namespace] = s.count;
  const el = document.getElementById('wiki-stats');
  el.innerHTML = Object.entries(WIKI_NS_LABELS).map(([ns, label]) => `
    <div class="bg-white border rounded-lg p-4 text-center">
      <div class="text-2xl font-bold text-blue-600">${counts[ns] || 0}</div>
      <div class="text-xs text-slate-600 mt-1">${label}</div>
    </div>
  `).join('');
}

async function loadWikiList() {
  const ns = document.getElementById('wiki-filter-ns').value;
  const url = ns ? `/wiki?namespace=${ns}` : '/wiki';
  const items = await api(url);
  const el = document.getElementById('wiki-list');
  if (items.length === 0) {
    el.innerHTML = '<p class="text-sm text-slate-500">Chưa có bài viết nào. Thêm bài đầu tiên ở form phía trên.</p>';
    return;
  }
  el.innerHTML = items.map((w) => {
    let tags = [];
    try { tags = JSON.parse(w.tags || '[]'); } catch {}
    const tagBadges = tags.map((t) => `<span class="bg-slate-200 text-xs px-2 py-0.5 rounded">${t}</span>`).join(' ');
    const star = w.always_inject ? '<span class="text-yellow-500" title="Luôn inject">⭐</span>' : '';
    return `
      <div class="bg-white border rounded-lg p-4 flex justify-between items-start gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">${WIKI_NS_LABELS[w.namespace] || w.namespace}</span>
            <span class="font-mono">${w.slug}</span>
            ${star}
          </div>
          <div class="font-semibold">${escapeHtml(w.title)}</div>
          <div class="text-sm text-slate-600 mt-1 line-clamp-2">${escapeHtml(w.content.slice(0, 200))}${w.content.length > 200 ? '...' : ''}</div>
          ${tagBadges ? `<div class="mt-2 flex flex-wrap gap-1">${tagBadges}</div>` : ''}
        </div>
        <div class="flex flex-col gap-1">
          <button onclick="editWiki(${w.id})" class="text-blue-600 text-sm hover:underline">Sửa</button>
          <button onclick="delWiki(${w.id})" class="text-red-500 text-sm hover:underline">Xóa</button>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resetWikiForm() {
  document.getElementById('wiki-id').value = '';
  document.getElementById('wiki-namespace').value = 'business';
  document.getElementById('wiki-title').value = '';
  document.getElementById('wiki-content').value = '';
  document.getElementById('wiki-tags').value = '';
  document.getElementById('wiki-always-inject').checked = false;
  document.getElementById('wiki-status').textContent = '';
}

window.editWiki = async (id) => {
  const items = await api('/wiki');
  const w = items.find((x) => x.id === id);
  if (!w) return;
  document.getElementById('wiki-id').value = w.id;
  document.getElementById('wiki-namespace').value = w.namespace;
  document.getElementById('wiki-title').value = w.title;
  document.getElementById('wiki-content').value = w.content;
  let tags = [];
  try { tags = JSON.parse(w.tags || '[]'); } catch {}
  document.getElementById('wiki-tags').value = tags.join(', ');
  document.getElementById('wiki-always-inject').checked = !!w.always_inject;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.delWiki = async (id) => {
  if (!confirm('Xóa bài Wiki này?')) return;
  await api(`/wiki/${id}`, { method: 'DELETE' });
  loadWiki();
};

document.getElementById('btn-wiki-save').addEventListener('click', async () => {
  const id = document.getElementById('wiki-id').value;
  const body = {
    namespace: document.getElementById('wiki-namespace').value,
    title: document.getElementById('wiki-title').value.trim(),
    content: document.getElementById('wiki-content').value.trim(),
    tags: document.getElementById('wiki-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
    always_inject: document.getElementById('wiki-always-inject').checked,
  };
  if (!body.title || !body.content) {
    document.getElementById('wiki-status').textContent = '❌ Thiếu tiêu đề hoặc nội dung';
    return;
  }
  try {
    if (id) {
      await api(`/wiki/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/wiki', { method: 'POST', body: JSON.stringify(body) });
    }
    document.getElementById('wiki-status').textContent = '✅ Đã lưu';
    resetWikiForm();
    loadWiki();
    setTimeout(() => document.getElementById('wiki-status').textContent = '', 3000);
  } catch (e) {
    document.getElementById('wiki-status').textContent = '❌ ' + e.message;
  }
});

document.getElementById('btn-wiki-reset').addEventListener('click', resetWikiForm);
document.getElementById('wiki-filter-ns').addEventListener('change', loadWikiList);

document.getElementById('btn-wiki-preview').addEventListener('click', async () => {
  const topic = document.getElementById('wiki-preview-topic').value.trim();
  if (!topic) return;
  const el = document.getElementById('wiki-preview-result');
  el.classList.remove('hidden');
  el.textContent = 'Đang tra cứu...';
  try {
    const r = await api('/wiki/preview', { method: 'POST', body: JSON.stringify({ topic }) });
    el.textContent = r.context
      ? `[${r.length} ký tự sẽ inject vào prompt của Claude]\n\n${r.context}`
      : '(Không có Wiki entry nào match — AI sẽ viết caption chung chung. Hãy thêm Wiki entries.)';
  } catch (e) {
    el.textContent = '❌ ' + e.message;
  }
});

// ====== Analytics ======
async function loadAnalytics() {
  await loadOverview();
  await loadTopPosts();
  await loadABList();
  await loadBestTime();
  await loadBookingLatest();
  await loadCostOverview();
  await loadContentCalendar();
  // Populate page dropdown
  const sel = document.getElementById('ab-page');
  sel.innerHTML = state.pages.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function loadBestTime() {
  const el = document.getElementById('best-time');
  if (!el) return;
  try {
    const r = await api('/analytics/best-time?days=60');
    if (!r.total_samples) {
      el.innerHTML = '<div class="text-slate-500">Chưa đủ dữ liệu (cần ít nhất 5-10 post có metric).</div>';
      return;
    }
    const dowNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const bh = r.best_hour;
    const bd = r.best_dow;
    const topHours = [...r.hours].sort((a, b) => b.avg_score - a.avg_score).slice(0, 3)
      .map(h => `${String(h.hour).padStart(2, '0')}:00 (${(h.avg_score * 100).toFixed(2)}%)`).join(', ');
    const topDows = [...r.dows].sort((a, b) => b.avg_score - a.avg_score).slice(0, 3)
      .map(d => `${dowNames[d.dow]} (${(d.avg_score * 100).toFixed(2)}%)`).join(', ');
    el.innerHTML = `
      <div class="mb-2"><b>Khung giờ vàng:</b> ${String(bh.hour).padStart(2, '0')}:00 — engagement ${(bh.avg_score * 100).toFixed(2)}%</div>
      <div class="mb-2"><b>Ngày vàng:</b> ${dowNames[bd.dow]} — engagement ${(bd.avg_score * 100).toFixed(2)}%</div>
      <div class="text-xs text-slate-500 mt-3">Top 3 giờ: ${topHours}</div>
      <div class="text-xs text-slate-500">Top 3 ngày: ${topDows}</div>
      <div class="text-xs text-slate-400 mt-2">Dựa trên ${r.total_samples} bài đăng.</div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="text-red-500 text-xs">Lỗi: ${e.message}</div>`;
  }
}

async function loadBookingLatest() {
  const el = document.getElementById('booking-latest');
  if (!el) return;
  try {
    const r = await api('/analytics/booking');
    if (!r) {
      el.innerHTML = '<div class="text-slate-500">Chưa có dữ liệu booking.</div>';
      return;
    }
    el.innerHTML = `
      <div class="border-t pt-3 mt-3">
        <b>Snapshot hiện tại</b> (cập nhật ${new Date(r.updated_at).toLocaleString('vi-VN')}):
        <pre class="bg-slate-50 p-2 rounded mt-1 whitespace-pre-wrap">${escapeHtml(r.content)}</pre>
      </div>
    `;
  } catch {}
}

async function loadOverview() {
  const r = await api('/analytics/overview?days=30');
  const el = document.getElementById('analytics-overview');
  const rate = ((r.avg_engagement_rate || 0) * 100).toFixed(2);
  el.innerHTML = `
    <div class="bg-white border rounded-lg p-4">
      <div class="text-xs text-slate-500">Tổng bài (30d)</div>
      <div class="text-2xl font-bold text-blue-600 mt-1">${r.total_posts || 0}</div>
    </div>
    <div class="bg-white border rounded-lg p-4">
      <div class="text-xs text-slate-500">Tổng Reach</div>
      <div class="text-2xl font-bold text-green-600 mt-1">${(r.total_reach || 0).toLocaleString()}</div>
    </div>
    <div class="bg-white border rounded-lg p-4">
      <div class="text-xs text-slate-500">Tổng tương tác</div>
      <div class="text-2xl font-bold text-purple-600 mt-1">${(r.total_engagement || 0).toLocaleString()}</div>
    </div>
    <div class="bg-white border rounded-lg p-4">
      <div class="text-xs text-slate-500">Engagement rate TB</div>
      <div class="text-2xl font-bold text-orange-600 mt-1">${rate}%</div>
    </div>
  `;
}

async function loadTopPosts() {
  const r = await api('/analytics/overview?days=30');
  const el = document.getElementById('top-posts');
  const list = r.top_posts || [];
  if (list.length === 0) {
    el.innerHTML = '<p class="text-sm text-slate-500">Chưa có data. Bấm "Pull metrics ngay" sau khi đã đăng bài.</p>';
    return;
  }
  el.innerHTML = list.map((p, i) => `
    <div class="bg-white border rounded-lg p-4 flex justify-between items-start gap-4">
      <div class="flex-1 min-w-0">
        <div class="text-xs text-slate-500 mb-1">#${i + 1} • Post ${p.id}</div>
        <div class="text-sm line-clamp-2">${escapeHtml(p.caption.slice(0, 200))}</div>
      </div>
      <div class="text-right text-sm whitespace-nowrap">
        <div>👁️ ${(p.reach || 0).toLocaleString()}</div>
        <div>❤️ ${p.reactions || 0} • 💬 ${p.comments || 0} • 🔁 ${p.shares || 0}</div>
        <div class="font-bold text-blue-600 mt-1">Score: ${p.engagement || 0}</div>
      </div>
    </div>
  `).join('');
}

document.getElementById('btn-refresh-metrics').addEventListener('click', async () => {
  const st = document.getElementById('refresh-status');
  st.textContent = 'Đang pull từ Facebook...';
  st.className = 'ml-3 text-sm text-slate-500';
  try {
    const r = await api('/analytics/refresh', { method: 'POST' });
    st.textContent = `✅ OK: ${r.ok}, lỗi: ${r.fail}`;
    st.className = 'ml-3 text-sm text-green-600';
    loadOverview();
    loadTopPosts();
  } catch (e) {
    st.textContent = '❌ ' + e.message;
    st.className = 'ml-3 text-sm text-red-600';
  }
});

// ===== A/B =====
async function loadABList() {
  const list = await api('/analytics/ab');
  const el = document.getElementById('ab-list');
  if (list.length === 0) {
    el.innerHTML = '<p class="text-xs text-slate-500">Chưa có experiment nào.</p>';
    return;
  }
  el.innerHTML = list.map((e) => {
    const status = e.winner
      ? `<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs">Winner: ${e.winner} (${(e.winner_score || 0).toFixed(3)})</span>`
      : `<span class="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded text-xs">Đang chờ data...</span>`;
    return `
      <div class="border rounded-lg p-3 text-sm">
        <div class="flex justify-between items-start">
          <div class="font-semibold">${escapeHtml(e.topic)}</div>
          ${status}
        </div>
        <div class="text-xs text-slate-500 mt-1">${e.page_name || ''} • ${new Date(e.created_at).toLocaleString('vi-VN')}</div>
      </div>
    `;
  }).join('');
}

document.getElementById('btn-ab-create').addEventListener('click', async () => {
  const topic = document.getElementById('ab-topic').value.trim();
  const pageId = parseInt(document.getElementById('ab-page').value, 10);
  if (!topic || !pageId) return alert('Điền chủ đề và chọn page');
  const preview = document.getElementById('ab-preview');
  preview.classList.remove('hidden');
  preview.innerHTML = '<p class="text-sm text-slate-500">Đang gen 2 variant...</p>';
  try {
    const r = await api('/analytics/ab/create', { method: 'POST', body: JSON.stringify({ topic, page_id: pageId }) });
    preview.innerHTML = `
      <div class="grid grid-cols-2 gap-3">
        <div class="border rounded-lg p-3 bg-blue-50">
          <div class="text-xs font-bold text-blue-700 mb-2">VARIANT A — Hook: Câu hỏi</div>
          <pre class="text-xs whitespace-pre-wrap font-sans">${escapeHtml(r.variantA)}</pre>
        </div>
        <div class="border rounded-lg p-3 bg-purple-50">
          <div class="text-xs font-bold text-purple-700 mb-2">VARIANT B — Hook: Con số/Insight</div>
          <pre class="text-xs whitespace-pre-wrap font-sans">${escapeHtml(r.variantB)}</pre>
        </div>
      </div>
      <p class="text-xs text-slate-500 mt-3">Experiment #${r.experimentId} đã lưu. Tạo 2 post từ 2 variant trong tab Tạo bài đăng, app sẽ tự quyết định winner sau 24h.</p>
    `;
    loadABList();
  } catch (e) {
    preview.innerHTML = `<p class="text-red-500 text-sm">❌ ${e.message}</p>`;
  }
});

// ===== FAQ auto-learn =====
document.getElementById('btn-faq-analyze').addEventListener('click', async () => {
  const el = document.getElementById('faq-suggestions');
  el.innerHTML = '<p class="text-sm text-slate-500">Đang phân tích comment...</p>';
  try {
    const r = await api('/analytics/faq/analyze', { method: 'POST' });
    if (!r.suggestions || r.suggestions.length === 0) {
      el.innerHTML = `<p class="text-sm text-slate-500">Không tìm thấy nhóm câu hỏi lặp lại (đã scan ${r.analyzed} comment).</p>`;
      return;
    }
    el.innerHTML = `<p class="text-xs text-slate-500 mb-3">Đã scan ${r.analyzed} comment, tìm thấy ${r.suggestions.length} nhóm câu hỏi:</p>` +
      r.suggestions.map((s, i) => `
        <div class="border rounded-lg p-3 mb-2">
          <div class="flex justify-between items-start gap-3">
            <div class="flex-1">
              <div class="font-semibold text-sm">${escapeHtml(s.question)}</div>
              <div class="text-xs text-slate-500 mt-1">Gặp ${s.count} lần</div>
              ${s.examples.map((ex) => `<div class="text-xs text-slate-600 mt-1 italic">"${escapeHtml(ex)}"</div>`).join('')}
            </div>
            <button onclick="addFaqFromSuggestion(${i}, '${encodeURIComponent(s.question)}')" class="bg-green-600 text-white text-xs px-3 py-1 rounded whitespace-nowrap">+ Thêm FAQ</button>
          </div>
        </div>
      `).join('');
  } catch (e) {
    el.innerHTML = `<p class="text-red-500 text-sm">❌ ${e.message}</p>`;
  }
});

window.addFaqFromSuggestion = (i, encodedQ) => {
  const q = decodeURIComponent(encodedQ);
  switchTab('wiki');
  setTimeout(() => {
    document.getElementById('wiki-namespace').value = 'faq';
    document.getElementById('wiki-title').value = q;
    document.getElementById('wiki-content').value = `**Câu hỏi:** ${q}\n\n**Trả lời:** (bạn điền câu trả lời chuẩn ở đây)`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, 100);
};

async function loadCostOverview() {
  const el = document.getElementById('cost-overview');
  if (!el) return;
  try {
    const r = await api('/analytics/cost?days=30');
    if (!r.calls) {
      el.innerHTML = '<div class="text-slate-500">Chưa có AI call nào trong 30 ngày.</div>';
      return;
    }
    const provRows = (r.by_provider || []).map(p =>
      `<tr><td class="py-1 pr-4">${p.provider}</td><td class="text-right">${p.calls}</td><td class="text-right">${(p.tokens || 0).toLocaleString()}</td><td class="text-right text-green-700">$${(p.cost_usd || 0).toFixed(4)}</td></tr>`
    ).join('');
    const taskRows = (r.by_task || []).map(t =>
      `<tr><td class="py-1 pr-4">${t.task}</td><td class="text-right">${t.calls}</td><td class="text-right text-green-700">$${(t.cost_usd || 0).toFixed(4)}</td></tr>`
    ).join('');
    el.innerHTML = `
      <div class="grid grid-cols-4 gap-3 mb-4">
        <div class="border rounded-lg p-3"><div class="text-xs text-slate-500">Tổng call</div><div class="text-xl font-bold">${r.calls}</div></div>
        <div class="border rounded-lg p-3"><div class="text-xs text-slate-500">Fail</div><div class="text-xl font-bold text-red-600">${r.fails}</div></div>
        <div class="border rounded-lg p-3"><div class="text-xs text-slate-500">Tokens (in+out)</div><div class="text-xl font-bold">${(r.input_tokens + r.output_tokens).toLocaleString()}</div></div>
        <div class="border rounded-lg p-3"><div class="text-xs text-slate-500">Tổng chi phí</div><div class="text-xl font-bold text-green-700">$${(r.total_usd || 0).toFixed(4)}</div></div>
      </div>
      <div class="grid grid-cols-2 gap-6">
        <div>
          <div class="font-semibold mb-1">Theo provider</div>
          <table class="w-full text-xs"><thead><tr class="border-b"><th class="text-left">Provider</th><th class="text-right">Calls</th><th class="text-right">Tokens</th><th class="text-right">USD</th></tr></thead><tbody>${provRows}</tbody></table>
        </div>
        <div>
          <div class="font-semibold mb-1">Theo task</div>
          <table class="w-full text-xs"><thead><tr class="border-b"><th class="text-left">Task</th><th class="text-right">Calls</th><th class="text-right">USD</th></tr></thead><tbody>${taskRows}</tbody></table>
        </div>
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="text-red-500 text-xs">Lỗi: ${e.message}</div>`;
  }
}

async function loadContentCalendar() {
  const el = document.getElementById('content-calendar');
  if (!el) return;
  try {
    const posts = await api('/posts');
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const byDay = {};
    for (const p of posts) {
      const t = p.scheduled_at || p.published_at;
      if (!t) continue;
      const d = new Date(t);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push(p);
    }
    const statusColor = {
      scheduled: 'bg-blue-100 text-blue-700',
      published: 'bg-green-100 text-green-700',
      publishing: 'bg-yellow-100 text-yellow-700',
      failed: 'bg-red-100 text-red-700',
      draft: 'bg-slate-100 text-slate-600',
    };
    el.innerHTML = days.map(d => {
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const dayPosts = byDay[key] || [];
      const isToday = d.toDateString() === new Date().toDateString();
      const items = dayPosts.slice(0, 3).map(p => {
        const hhmm = new Date(p.scheduled_at || p.published_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const cls = statusColor[p.status] || 'bg-slate-100';
        return `<div class="${cls} rounded px-1 py-0.5 mb-1 truncate" title="${escapeHtml(p.caption || '')}">${hhmm} ${escapeHtml((p.caption || '').slice(0, 20))}</div>`;
      }).join('');
      const more = dayPosts.length > 3 ? `<div class="text-slate-400">+${dayPosts.length - 3} khác</div>` : '';
      return `
        <div class="border rounded-lg p-2 min-h-24 ${isToday ? 'ring-2 ring-blue-500' : ''}">
          <div class="font-semibold text-slate-600">${dayNames[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}</div>
          ${items}${more}
        </div>
      `;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="text-red-500 text-xs col-span-7">Lỗi: ${e.message}</div>`;
  }
}

// Smart schedule button
const btnSmartSlot = document.getElementById('btn-smart-slot');
if (btnSmartSlot) {
  btnSmartSlot.addEventListener('click', async () => {
    const hint = document.getElementById('smart-slot-hint');
    hint.textContent = 'Đang tính...';
    try {
      const r = await api('/analytics/smart-slot');
      const d = new Date(r.slot_epoch);
      // Format to datetime-local: YYYY-MM-DDTHH:MM
      const pad = (n) => String(n).padStart(2, '0');
      const val = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      document.getElementById('compose-schedule').value = val;
      hint.textContent = r.reason;
    } catch (e) {
      hint.innerHTML = `<span class="text-red-500">${e.message}</span>`;
    }
  });
}

// ===== Sprint 6: Telegram =====
async function loadTelegramStatus() {
  const statusEl = document.getElementById('tg-status');
  const chatsEl = document.getElementById('tg-chats');
  if (!statusEl) return;
  try {
    const r = await api('/settings/telegram');
    const dot = r.running ? '🟢' : (r.configured ? '🟡' : '⚪');
    statusEl.innerHTML = `
      <div class="border rounded p-3 bg-slate-50 text-xs">
        <div>${dot} <b>Bot:</b> ${r.running ? 'đang chạy' : (r.configured ? 'đã cấu hình, chưa chạy' : 'chưa có token')}</div>
        ${r.token_masked ? `<div>Token: <code>${r.token_masked}</code></div>` : ''}
        <div>Unlock code: ${r.unlock_code ? `<code>${escapeHtml(r.unlock_code)}</code>` : '<i>(chưa set)</i>'}</div>
      </div>
    `;
    if (r.unlock_code) document.getElementById('tg-unlock').value = r.unlock_code;

    if (r.chats && r.chats.length) {
      chatsEl.innerHTML = `
        <div class="text-sm font-semibold mt-3 mb-2">Chats đã tương tác (${r.chats.length}):</div>
        ${r.chats.map(c => `
          <div class="flex items-center justify-between border rounded p-2 mb-1 text-xs">
            <div>
              <b>${escapeHtml(c.first_name || '(ẩn)')}</b>
              ${c.username ? `<span class="text-slate-500">@${escapeHtml(c.username)}</span>` : ''}
              <span class="text-slate-400">ID: ${c.chat_id}</span>
              ${c.authorized ? '<span class="text-green-600 ml-2">✅ authorized</span>' : '<span class="text-slate-400 ml-2">🔒 locked</span>'}
            </div>
            <div>
              ${c.authorized
                ? `<button onclick="tgRevoke('${c.chat_id}')" class="bg-red-500 text-white px-2 py-1 rounded text-xs">Revoke</button>`
                : `<button onclick="tgAuthorize('${c.chat_id}')" class="bg-green-600 text-white px-2 py-1 rounded text-xs">Authorize</button>`}
            </div>
          </div>
        `).join('')}
      `;
    } else {
      chatsEl.innerHTML = '<div class="text-xs text-slate-500 mt-3">Chưa có chat nào. Chat với bot và gõ /start.</div>';
    }
  } catch (e) {
    statusEl.innerHTML = `<div class="text-red-500 text-xs">Lỗi: ${e.message}</div>`;
  }
}

window.tgAuthorize = async (id) => {
  await api(`/settings/telegram/authorize/${id}`, { method: 'POST' });
  loadTelegramStatus();
};
window.tgRevoke = async (id) => {
  await api(`/settings/telegram/revoke/${id}`, { method: 'POST' });
  loadTelegramStatus();
};

const btnTgSave = document.getElementById('btn-tg-save');
if (btnTgSave) {
  btnTgSave.addEventListener('click', async () => {
    const bot_token = document.getElementById('tg-token').value.trim();
    const unlock_code = document.getElementById('tg-unlock').value.trim();
    try {
      await api('/settings/telegram', {
        method: 'POST',
        body: JSON.stringify({ bot_token: bot_token || undefined, unlock_code }),
      });
      document.getElementById('tg-token').value = '';
      alert('Đã lưu. Bot đang khởi động lại (xem status sau vài giây).');
      setTimeout(loadTelegramStatus, 2000);
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });
}

const btnTgTest = document.getElementById('btn-tg-test');
if (btnTgTest) {
  btnTgTest.addEventListener('click', async () => {
    try {
      await api('/settings/telegram/test', { method: 'POST' });
      alert('Đã gửi test message tới các chat đã authorized.');
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });
}

// Booking sync button
const btnBookingSync = document.getElementById('btn-booking-sync');
if (btnBookingSync) {
  btnBookingSync.addEventListener('click', async () => {
    const content = document.getElementById('booking-content').value.trim();
    const status = document.getElementById('booking-status');
    if (!content) {
      status.innerHTML = '<span class="text-red-500">Nhập nội dung trước</span>';
      return;
    }
    status.innerHTML = '<span class="text-slate-500">Đang lưu...</span>';
    try {
      const r = await api('/analytics/booking/sync', {
        method: 'POST',
        body: JSON.stringify({ content, source: 'manual' }),
      });
      status.innerHTML = `<span class="text-green-600">✓ Đã lưu (${r.content_length} ký tự)</span>`;
      await loadBookingLatest();
    } catch (e) {
      status.innerHTML = `<span class="text-red-500">❌ ${e.message}</span>`;
    }
  });
}

// ====== Sprint 8: Booking Config ======
async function loadBookingConfig() {
  try {
    const cfg = await api('/booking/config');
    document.getElementById('bk-hotel-name').value = cfg.hotel_name || '';
    document.getElementById('bk-hotline').value = cfg.hotline || '';
    document.getElementById('bk-address').value = cfg.address || '';
    document.getElementById('bk-maps').value = cfg.google_maps_link || '';
    document.getElementById('bk-checkin-time').value = cfg.checkin_time || '14:00';
    document.getElementById('bk-checkout-time').value = cfg.checkout_time || '12:00';
    document.getElementById('bk-deposit').value = cfg.deposit_percent || 50;
    document.getElementById('bk-cancel-policy').value = cfg.cancellation_policy || '';
    document.getElementById('bk-room-types').value = JSON.stringify(cfg.room_types || {}, null, 2);
    const qrStatus = document.getElementById('bk-qr-status');
    if (cfg.bank_qr_image_id) {
      qrStatus.textContent = `Media ID: ${cfg.bank_qr_image_id}`;
    }
  } catch {}
}

async function loadPendingBookings() {
  const el = document.getElementById('bk-pending-list');
  if (!el) return;
  try {
    const list = await api('/booking/pending');
    if (list.length === 0) {
      el.innerHTML = '<p class="text-slate-500 text-xs">Không có booking nào đang chờ.</p>';
      return;
    }
    const statusLabels = {
      collecting: '📝 Thu thập',
      quoting: '💰 Báo giá',
      awaiting_transfer: '⏳ Chờ CK',
      awaiting_confirm: '🔔 Chờ xác nhận',
    };
    el.innerHTML = list.map((b) => `
      <div class="border rounded-lg p-3">
        <div class="flex justify-between items-start">
          <div>
            <span class="font-semibold">#${b.id}</span>
            <span class="ml-2 text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-700">${statusLabels[b.status] || b.status}</span>
          </div>
          <div class="flex gap-1">
            ${b.status === 'awaiting_confirm' ? `
              <button onclick="confirmBookingUI(${b.id})" class="bg-green-600 text-white text-xs px-2 py-1 rounded">Confirm</button>
              <button onclick="rejectBookingUI(${b.id})" class="bg-red-500 text-white text-xs px-2 py-1 rounded">Reject</button>
            ` : ''}
          </div>
        </div>
        <div class="text-xs text-slate-600 mt-1">
          Khách: ${escapeHtml(b.fb_sender_name || b.fb_sender_id)} |
          Phòng: ${b.room_type || '?'} |
          ${b.checkin_date || '?'} → ${b.checkout_date || '?'} |
          ${b.nights} đêm |
          ${(b.total_price || 0).toLocaleString()}₫
        </div>
      </div>
    `).join('');
  } catch {}
}

window.confirmBookingUI = async (id) => {
  const room = prompt('Số phòng:');
  if (room === null) return;
  try {
    await api(`/booking/${id}/confirm`, { method: 'POST', body: JSON.stringify({ room: room || 'N/A' }) });
    alert('Đã xác nhận!');
    loadPendingBookings();
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
};

window.rejectBookingUI = async (id) => {
  const reason = prompt('Lý do từ chối (tùy chọn):');
  if (reason === null) return;
  try {
    await api(`/booking/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    alert('Đã từ chối.');
    loadPendingBookings();
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
};

const btnBkSave = document.getElementById('btn-bk-save');
if (btnBkSave) {
  btnBkSave.addEventListener('click', async () => {
    const st = document.getElementById('bk-save-status');
    let room_types;
    try {
      room_types = JSON.parse(document.getElementById('bk-room-types').value);
    } catch {
      st.textContent = '❌ JSON loại phòng không hợp lệ';
      st.className = 'text-sm text-red-600';
      return;
    }
    const body = {
      hotel_name: document.getElementById('bk-hotel-name').value.trim(),
      hotline: document.getElementById('bk-hotline').value.trim(),
      address: document.getElementById('bk-address').value.trim(),
      google_maps_link: document.getElementById('bk-maps').value.trim(),
      checkin_time: document.getElementById('bk-checkin-time').value.trim(),
      checkout_time: document.getElementById('bk-checkout-time').value.trim(),
      deposit_percent: parseInt(document.getElementById('bk-deposit').value, 10) || 50,
      cancellation_policy: document.getElementById('bk-cancel-policy').value.trim(),
      room_types,
    };
    try {
      await api('/booking/config', { method: 'POST', body: JSON.stringify(body) });
      st.textContent = '✅ Đã lưu';
      st.className = 'text-sm text-green-600';
      setTimeout(() => (st.textContent = ''), 3000);
    } catch (e) {
      st.textContent = '❌ ' + e.message;
      st.className = 'text-sm text-red-600';
    }
  });
}

const bkQrUpload = document.getElementById('bk-qr-upload');
if (bkQrUpload) {
  bkQrUpload.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const st = document.getElementById('bk-qr-status');
    st.textContent = 'Đang upload...';
    try {
      const resp = await fetch('/api/booking/bank-image', { method: 'POST', body: fd, credentials: 'include' });
      const r = await resp.json();
      if (!resp.ok) throw new Error(r.error);
      st.textContent = `✅ Media ID: ${r.mediaId}`;
    } catch (err) {
      st.textContent = '❌ ' + err.message;
    }
  });
}

// ====== FB Token Status ======
async function checkTokenStatus() {
  const el = document.getElementById('token-status-list');
  el.innerHTML = '<p class="text-slate-400">Dang kiem tra...</p>';
  try {
    const r = await api('/api/settings/pages/token-status');
    const data = await r.json();
    el.innerHTML = data.length === 0 ? '<p class="text-slate-400">Chua co page nao</p>' :
      data.map(p => `
        <div class="flex justify-between items-center bg-slate-50 rounded p-2">
          <span class="font-semibold">${p.name}</span>
          <span>${p.status}</span>
          <span class="text-xs text-slate-400">${p.days_left >= 0 ? p.days_left + ' ngay' : 'N/A'}</span>
          ${p.is_valid ? `<button onclick="refreshPageToken(${p.page_id})" class="text-xs bg-blue-500 text-white px-2 py-1 rounded">Gia han</button>` : ''}
        </div>`).join('');
  } catch(e) {
    el.innerHTML = '<p class="text-red-500">Loi kiem tra. Kiem tra FB_APP_ID va FB_APP_SECRET.</p>';
  }
}

async function refreshPageToken(pageId) {
  const r = await api('/api/settings/pages/' + pageId + '/refresh-token', 'POST');
  const d = await r.json();
  alert(d.ok ? d.message : 'Loi: ' + d.error);
  checkTokenStatus();
}

async function refreshAllTokens() {
  const r = await api('/api/settings/pages/refresh-all', 'POST');
  const d = await r.json();
  alert(`Gia han: ${d.refreshed} ok, ${d.failed} loi`);
  if (d.errors?.length) alert('Loi:\n' + d.errors.join('\n'));
  checkTokenStatus();
}

// ====== API Keys — All Providers ======
const API_KEY_MAP = {
  'key-anthropic': 'anthropic_api_key',
  'key-deepseek': 'deepseek_api_key',
  'key-openai': 'openai_api_key',
  'key-google': 'google_api_key',
  'key-groq': 'groq_api_key',
  'key-mistral': 'mistral_api_key',
  'key-fal': 'fal_api_key',
  'key-unsplash': 'unsplash_access_key',
};

async function loadAllApiKeys() {
  try {
    for (const [elemId, settingKey] of Object.entries(API_KEY_MAP)) {
      const r = await api('/api/settings/get?key=' + settingKey);
      const d = await r.json();
      const el = document.getElementById(elemId);
      if (el && d.value) el.value = d.value;
    }
    document.getElementById('api-keys-status').textContent = '✅ Da tai keys';
  } catch(e) {
    document.getElementById('api-keys-status').textContent = '❌ Loi tai keys';
  }
}

async function saveAllApiKeys() {
  let saved = 0;
  for (const [elemId, settingKey] of Object.entries(API_KEY_MAP)) {
    const el = document.getElementById(elemId);
    const val = el ? el.value.trim() : '';
    if (val) {
      await api('/api/settings/set', 'POST', { key: settingKey, value: val });
      saved++;
    }
  }
  document.getElementById('api-keys-status').textContent = `✅ Da luu ${saved} keys! Router se tu dong su dung.`;
  // Reload router status
  setTimeout(loadRouterStatus, 500);
}

// ====== Sprint 9: OTA Database Config ======
async function loadOtaConfig() {
  try {
    const cfg = await api('/ota/config');
    if (cfg.configured) {
      document.getElementById('ota-host').value = cfg.host || '';
      document.getElementById('ota-port').value = cfg.port || 5432;
      document.getElementById('ota-database').value = cfg.database || '';
      document.getElementById('ota-user').value = cfg.user || '';
      document.getElementById('ota-password').placeholder = '(đã lưu)';
      document.getElementById('ota-ssl').checked = cfg.ssl !== false;
      document.getElementById('ota-status').innerHTML = '🟢 Đã cấu hình';
    }
  } catch (e) { console.warn('loadOtaConfig:', e); }
}

document.getElementById('btn-ota-save')?.addEventListener('click', async () => {
  const st = document.getElementById('ota-status');
  const pw = document.getElementById('ota-password').value;
  if (!pw && !document.getElementById('ota-password').placeholder.includes('đã lưu')) {
    st.textContent = '❌ Cần nhập password'; return;
  }
  st.textContent = '⏳ Đang lưu...';
  try {
    const body = {
      host: document.getElementById('ota-host').value,
      port: document.getElementById('ota-port').value,
      database: document.getElementById('ota-database').value,
      user: document.getElementById('ota-user').value,
      password: pw || undefined,
      ssl: document.getElementById('ota-ssl').checked,
    };
    // Only send password if user typed one
    if (!pw) delete body.password;
    await api('/ota/config', { method: 'POST', body: JSON.stringify(body) });
    st.innerHTML = '✅ Đã lưu!';
  } catch (e) { st.textContent = '❌ ' + e.message; }
});

document.getElementById('btn-ota-test')?.addEventListener('click', async () => {
  const st = document.getElementById('ota-status');
  st.textContent = '⏳ Đang test kết nối...';
  try {
    const r = await api('/ota/test', { method: 'POST' });
    st.innerHTML = r.ok ? `✅ ${r.message}` : `❌ ${r.message}`;
  } catch (e) { st.textContent = '❌ ' + e.message; }
});

document.getElementById('btn-ota-hotels')?.addEventListener('click', async () => {
  const container = document.getElementById('ota-hotels-list');
  container.textContent = '⏳ Đang tải...';
  try {
    const hotels = await api('/ota/hotels');
    if (!hotels.length) { container.textContent = 'Không có hotel nào.'; return; }
    container.innerHTML = `<table class="w-full text-xs border-collapse mt-2">
      <tr class="bg-slate-100"><th class="p-2 text-left">ID</th><th class="p-2 text-left">Tên</th><th class="p-2 text-left">Thành phố</th><th class="p-2 text-left">⭐</th><th class="p-2 text-left">SĐT</th><th class="p-2">Trạng thái</th></tr>
      ${hotels.map(h => `<tr class="border-t">
        <td class="p-2 font-mono">${h.id}</td>
        <td class="p-2 font-semibold">${h.name}</td>
        <td class="p-2">${h.city || '-'}</td>
        <td class="p-2">${h.star_rating || '-'}</td>
        <td class="p-2">${h.phone || '-'}</td>
        <td class="p-2 text-center"><span class="px-2 py-0.5 rounded text-xs ${h.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100'}">${h.status}</span></td>
      </tr>`).join('')}
    </table>`;
  } catch (e) { container.textContent = '❌ ' + e.message; }
});

// ====== Sprint 9: Hotel Telegram Config ======
async function loadHotelTelegramList() {
  try {
    const configs = await api('/hotel-telegram');
    const container = document.getElementById('hotel-tg-list');
    if (!container) return;
    if (!configs.length) {
      container.innerHTML = '<p class="text-xs text-slate-400">Chưa có khách sạn nào setup Telegram riêng.</p>';
      return;
    }
    container.innerHTML = configs.map(c => `
      <div class="flex items-center justify-between bg-slate-50 rounded-lg p-3 border">
        <div>
          <span class="font-semibold text-sm">${c.page_name}</span>
          <span class="text-xs ml-2 ${c.enabled ? 'text-green-600' : 'text-red-500'}">${c.enabled ? '🟢 ON' : '🔴 OFF'}</span>
          ${c.bot_username ? `<span class="text-xs text-blue-600 ml-2">@${c.bot_username}</span>` : ''}
          ${c.telegram_group_id ? `<span class="text-xs text-slate-400 ml-2">Group: ${c.telegram_group_id}</span>` : ''}
        </div>
        <div class="flex gap-1">
          <button onclick="testHotelTg(${c.page_id})" class="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">🧪 Test</button>
          <button onclick="toggleHotelTg(${c.page_id}, ${c.enabled ? 0 : 1})" class="text-xs ${c.enabled ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'} px-2 py-1 rounded">${c.enabled ? 'Tắt' : 'Bật'}</button>
          <button onclick="deleteHotelTg(${c.page_id})" class="text-xs bg-red-100 text-red-700 px-2 py-1 rounded">🗑️</button>
        </div>
      </div>
    `).join('');
  } catch (e) { console.warn('loadHotelTelegramList:', e); }
}

async function loadHotelTgPageSelect() {
  const sel = document.getElementById('htg-page-select');
  if (!sel || !state.pages.length) return;
  sel.innerHTML = state.pages.map(p => `<option value="${p.id}">${p.name} (ID: ${p.id})</option>`).join('');
}

document.getElementById('btn-htg-save')?.addEventListener('click', async () => {
  const st = document.getElementById('htg-status');
  const pageId = document.getElementById('htg-page-select')?.value;
  const token = document.getElementById('htg-token')?.value?.trim();
  const groupId = document.getElementById('htg-group-id')?.value?.trim();
  if (!pageId || !token) { st.textContent = '❌ Cần chọn page và nhập token'; return; }
  st.textContent = '⏳ Đang kết nối...';
  try {
    const r = await api(`/hotel-telegram/${pageId}`, {
      method: 'POST',
      body: JSON.stringify({ telegram_bot_token: token, telegram_group_id: groupId }),
    });
    st.innerHTML = `✅ Kết nối @${r.bot_username}` + (r.warning ? ` ⚠️ ${r.warning}` : '');
    document.getElementById('htg-token').value = '';
    document.getElementById('htg-group-id').value = '';
    loadHotelTelegramList();
  } catch (e) { st.textContent = '❌ ' + e.message; }
});

document.getElementById('btn-htg-test')?.addEventListener('click', async () => {
  const pageId = document.getElementById('htg-page-select')?.value;
  if (!pageId) return;
  const st = document.getElementById('htg-status');
  try {
    const r = await api(`/hotel-telegram/${pageId}/test`, { method: 'POST' });
    st.textContent = r.ok ? '✅ Đã gửi test!' : '❌ ' + r.message;
  } catch (e) { st.textContent = '❌ ' + e.message; }
});

async function testHotelTg(pageId) {
  try {
    const r = await api(`/hotel-telegram/${pageId}/test`, { method: 'POST' });
    alert(r.ok ? 'Đã gửi test!' : r.message);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function toggleHotelTg(pageId, enabled) {
  try {
    await api(`/hotel-telegram/${pageId}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
    loadHotelTelegramList();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function deleteHotelTg(pageId) {
  if (!confirm('Xoá cấu hình Telegram cho page này?')) return;
  try {
    await api(`/hotel-telegram/${pageId}`, { method: 'DELETE' });
    loadHotelTelegramList();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

// Load hotel telegram when settings tab opens
const origShowTab = window.showTab;
if (typeof origShowTab === 'function') {
  window.showTab = function(tab) {
    origShowTab(tab);
    if (tab === 'settings') { loadHotelTelegramList(); loadHotelTgPageSelect(); }
  };
} else {
  // Hook into tab switching via nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'settings') {
        setTimeout(() => { loadOtaConfig(); loadHotelTelegramList(); loadHotelTgPageSelect(); loadAllApiKeys(); }, 100);
      }
    });
  });
}

// ====== DASHBOARD ======
async function loadDashboard() {
  try {
    // Load stats, onboarding, plan in parallel
    const [statsRes, obRes, planRes] = await Promise.all([
      api('/api/monitoring/overview?days=7').catch(() => null),
      api('/api/onboarding/status').catch(() => null),
      api('/api/subscription/current').catch(() => null),
    ]);

    // Stats cards
    if (statsRes) {
      const s = await statsRes.json();
      document.getElementById('dash-stats').innerHTML = `
        <div class="bg-white rounded-xl shadow p-4 text-center">
          <div class="text-2xl font-bold">${s.posts?.published || 0}</div>
          <div class="text-xs text-slate-500">Bai da dang</div>
        </div>
        <div class="bg-white rounded-xl shadow p-4 text-center">
          <div class="text-2xl font-bold">${s.replies?.total || 0}</div>
          <div class="text-xs text-slate-500">Tin da tra loi</div>
        </div>
        <div class="bg-white rounded-xl shadow p-4 text-center">
          <div class="text-2xl font-bold">${s.ai?.total_calls || 0}</div>
          <div class="text-xs text-slate-500">AI calls</div>
        </div>
        <div class="bg-white rounded-xl shadow p-4 text-center">
          <div class="text-2xl font-bold">$${s.ai?.estimated_cost_usd || 0}</div>
          <div class="text-xs text-slate-500">Chi phi AI</div>
        </div>`;
    }

    // Onboarding
    if (obRes) {
      const ob = await obRes.json();
      const obEl = document.getElementById('dash-onboarding');
      if (ob.progress >= 100) {
        obEl.classList.add('hidden');
      } else {
        obEl.classList.remove('hidden');
        document.getElementById('dash-ob-pct').textContent = ob.progress + '%';
        document.getElementById('dash-ob-bar').style.width = ob.progress + '%';
        const labels = { hotel_info: '🏨 Hotel', fb_page: '📘 FB Page', telegram: '📱 Telegram', chatbot: '🤖 Chatbot', autopilot: '🚀 Autopilot', wiki: '📚 Wiki' };
        document.getElementById('dash-ob-steps').innerHTML = Object.entries(ob.steps).map(([k, v]) =>
          `<span class="${v ? 'text-green-600' : 'text-slate-400'}">${v ? '✅' : '⬜'} ${labels[k] || k}</span>`
        ).join('');
      }
    }

    // Plan
    if (planRes) {
      const p = await planRes.json();
      document.getElementById('dash-plan').innerHTML = `
        <div class="flex justify-between items-center">
          <div>
            <span class="text-sm text-slate-500">Goi hien tai</span>
            <span class="ml-2 font-bold text-blue-600 uppercase">${p.plan}</span>
          </div>
          <div class="text-sm text-right text-slate-500">
            Bai: ${p.usage?.posts_today || 0}/${p.limits?.max_posts_per_day || 0} |
            AI: ${p.usage?.ai_calls_today || 0}/${p.limits?.ai_calls_per_day || 0} |
            Pages: ${p.usage?.pages || 0}/${p.limits?.max_pages || 0}
          </div>
        </div>`;
    }

    // Recent posts
    try {
      const postsRes = await api('/api/posts');
      const posts = await postsRes.json();
      document.getElementById('dash-recent-posts').innerHTML = posts.slice(0, 8).map(p =>
        `<div class="flex justify-between border-b pb-1">
          <span class="truncate flex-1">${(p.content || '').slice(0, 50)}...</span>
          <span class="${p.status === 'published' ? 'text-green-600' : p.status === 'failed' ? 'text-red-500' : 'text-yellow-600'} text-xs">${p.status}</span>
        </div>`).join('') || '<p class="text-slate-400">Chua co bai dang</p>';
    } catch(e) {}

    // Recent replies
    try {
      const repliesRes = await api('/api/auto-reply/log');
      const replies = await repliesRes.json();
      document.getElementById('dash-recent-replies').innerHTML = replies.slice(0, 8).map(r =>
        `<div class="border-b pb-1 truncate">${r.sender_name || 'User'}: ${(r.message || '').slice(0, 40)}</div>`
      ).join('') || '<p class="text-slate-400">Chua co tin nhan</p>';
    } catch(e) {}

    // Errors (admin)
    try {
      const errRes = await api('/api/monitoring/errors?limit=5');
      const errs = await errRes.json();
      if (errs.length > 0) {
        document.getElementById('dash-errors').classList.remove('hidden');
        document.getElementById('dash-error-list').innerHTML = errs.map(e =>
          `<div class="text-red-600">${new Date(e.created_at).toLocaleDateString()}: ${e.error || 'Unknown'}</div>`
        ).join('');
      }
    } catch(e) {}
  } catch(e) {
    console.error('Dashboard load error:', e);
  }
}

// ====== ONBOARDING ======
async function loadOnboarding() {
  try {
    const res = await api('/api/onboarding/status');
    const data = await res.json();
    document.getElementById('ob-progress-text').textContent = data.progress + '%';
    document.getElementById('ob-progress-bar').style.width = data.progress + '%';

    const stepLabels = {
      hotel_info: '🏨 Thong tin khach san',
      fb_page: '📘 Ket noi Facebook Page',
      telegram: '📱 Thiet lap Telegram',
      chatbot: '🤖 Cau hinh Chatbot',
      autopilot: '🚀 Bat Autopilot',
      wiki: '📚 Tao kien thuc AI',
    };

    const stepsHtml = Object.entries(data.steps).map(([key, done]) => `
      <div class="bg-white rounded-xl shadow p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50"
           onclick="showObStep('${key}', ${done})">
        <span>${stepLabels[key] || key}</span>
        <span class="${done ? 'text-green-600' : 'text-slate-400'}">${done ? '✅' : '⬜'}</span>
      </div>
    `).join('');
    document.getElementById('ob-steps').innerHTML = stepsHtml;

    if (data.progress === 100) {
      document.getElementById('ob-steps').innerHTML += `
        <button onclick="completeOnboarding()" class="w-full bg-green-600 text-white py-3 rounded-xl font-bold text-lg mt-4">
          ✅ Kich hoat khach san
        </button>`;
    }
  } catch(e) {
    document.getElementById('ob-steps').innerHTML = '<p class="text-red-500">Loi tai onboarding</p>';
  }
}

function showObStep(step, done) {
  const container = document.getElementById('ob-actions');
  const title = document.getElementById('ob-action-title');
  const form = document.getElementById('ob-action-form');
  container.classList.remove('hidden');

  const forms = {
    fb_page: `
      <input id="ob-fb-page-id" placeholder="Page ID" class="w-full border rounded px-3 py-2 mb-2 text-sm" />
      <input id="ob-fb-token" type="password" placeholder="Access Token" class="w-full border rounded px-3 py-2 mb-2 text-sm" />
      <input id="ob-fb-name" placeholder="Ten Page (tuy chon)" class="w-full border rounded px-3 py-2 mb-2 text-sm" />
      <button onclick="obConnectFB()" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">Ket noi</button>
      <span id="ob-fb-status" class="text-sm ml-2"></span>`,
    telegram: `
      <input id="ob-tg-token" placeholder="Bot Token (tu @BotFather)" class="w-full border rounded px-3 py-2 mb-2 text-sm" />
      <input id="ob-tg-group" placeholder="Group ID (tuy chon)" class="w-full border rounded px-3 py-2 mb-2 text-sm" />
      <button onclick="obConnectTG()" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">Ket noi</button>
      <span id="ob-tg-status" class="text-sm ml-2"></span>`,
    chatbot: `
      <label class="flex items-center gap-2">
        <input type="checkbox" id="ob-chatbot-on" ${done ? 'checked' : ''} />
        <span>Bat tu dong tra loi tin nhan</span>
      </label>
      <button onclick="obSetChatbot()" class="mt-3 bg-blue-600 text-white px-4 py-2 rounded text-sm">Luu</button>`,
    autopilot: `
      <label class="flex items-center gap-2 mb-2">
        <input type="checkbox" id="ob-autopilot-on" ${done ? 'checked' : ''} />
        <span>Bat autopilot dang bai tu dong</span>
      </label>
      <input id="ob-ap-times" placeholder="Gio dang (VD: 08:00,12:00,18:00)" class="w-full border rounded px-3 py-2 mb-2 text-sm" />
      <button onclick="obSetAutopilot()" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">Luu</button>`,
    wiki: `
      <p class="text-sm mb-3">Tu dong tao kien thuc AI tu du lieu OTA (phong, gia, tien ich...)</p>
      <button onclick="obInitWiki()" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">Tao kien thuc</button>
      <span id="ob-wiki-status" class="text-sm ml-2"></span>`,
    hotel_info: `<p class="text-green-600">Thong tin khach san da duoc tu dong lay tu OTA.</p>`,
  };

  title.textContent = step;
  form.innerHTML = forms[step] || '<p>Khong co form cho buoc nay</p>';
}

async function obConnectFB() {
  const r = await api('/api/onboarding/step/fb-page', 'POST', {
    fb_page_id: document.getElementById('ob-fb-page-id').value,
    access_token: document.getElementById('ob-fb-token').value,
    name: document.getElementById('ob-fb-name').value,
  });
  const d = await r.json();
  document.getElementById('ob-fb-status').textContent = d.ok ? '✅ ' + d.pageName : '❌ ' + d.error;
  if (d.ok) loadOnboarding();
}

async function obConnectTG() {
  const r = await api('/api/onboarding/step/telegram', 'POST', {
    telegram_bot_token: document.getElementById('ob-tg-token').value,
    telegram_group_id: document.getElementById('ob-tg-group').value,
  });
  const d = await r.json();
  document.getElementById('ob-tg-status').textContent = d.ok ? '✅ @' + d.bot_username : '❌ ' + d.error;
  if (d.ok) loadOnboarding();
}

async function obSetChatbot() {
  await api('/api/onboarding/step/chatbot', 'POST', { enabled: document.getElementById('ob-chatbot-on').checked });
  loadOnboarding();
}

async function obSetAutopilot() {
  const times = document.getElementById('ob-ap-times').value.split(',').map(t => t.trim()).filter(Boolean);
  await api('/api/onboarding/step/autopilot', 'POST', {
    enabled: document.getElementById('ob-autopilot-on').checked,
    post_times: times,
  });
  loadOnboarding();
}

async function obInitWiki() {
  document.getElementById('ob-wiki-status').textContent = 'Dang tao...';
  const r = await api('/api/onboarding/step/wiki-init', 'POST');
  const d = await r.json();
  document.getElementById('ob-wiki-status').textContent = d.ok ? `✅ Tao ${d.wiki_entries} muc` : '❌ ' + d.error;
  if (d.ok) loadOnboarding();
}

async function completeOnboarding() {
  await api('/api/onboarding/complete', 'POST');
  alert('Khach san da duoc kich hoat!');
  loadOnboarding();
}

// ====== MONITORING ======
async function loadMonitoring(days = 7) {
  try {
    const [overviewRes, dailyRes, errorsRes] = await Promise.all([
      api('/api/monitoring/overview?days=' + days),
      api('/api/monitoring/ai-daily?days=' + days),
      api('/api/monitoring/errors?limit=20'),
    ]);
    const overview = await overviewRes.json();
    const daily = await dailyRes.json();
    const errors = await errorsRes.json();

    document.getElementById('monitoring-cards').innerHTML = `
      <div class="bg-white rounded-xl shadow p-5">
        <div class="text-sm text-slate-500">AI Calls</div>
        <div class="text-2xl font-bold">${overview.ai.total_calls}</div>
        <div class="text-xs text-slate-400">${overview.ai.total_tokens.toLocaleString()} tokens | $${overview.ai.estimated_cost_usd}</div>
      </div>
      <div class="bg-white rounded-xl shadow p-5">
        <div class="text-sm text-slate-500">Bai dang</div>
        <div class="text-2xl font-bold">${overview.posts.published} / ${overview.posts.total}</div>
        <div class="text-xs text-slate-400">Thanh cong ${overview.posts.success_rate}%</div>
      </div>
      <div class="bg-white rounded-xl shadow p-5">
        <div class="text-sm text-slate-500">Auto Reply</div>
        <div class="text-2xl font-bold">${overview.replies.total}</div>
        <div class="text-xs text-slate-400">Tin nhan: ${overview.replies.messages} | Comment: ${overview.replies.comments}</div>
      </div>
    `;

    document.getElementById('ai-daily-chart').innerHTML = daily.length === 0
      ? '<p class="text-slate-400">Chua co du lieu</p>'
      : daily.map(d => `
        <div class="flex items-center gap-2">
          <span class="w-24">${d.day}</span>
          <div class="flex-1 bg-slate-100 rounded h-4">
            <div class="bg-blue-500 h-4 rounded" style="width:${Math.min(100, (d.calls / Math.max(...daily.map(x=>x.calls))) * 100)}%"></div>
          </div>
          <span class="w-20 text-right">${d.calls} calls</span>
        </div>`).join('');

    document.getElementById('errors-list').innerHTML = errors.length === 0
      ? '<p class="text-green-600">Khong co loi!</p>'
      : errors.map(e => `
        <div class="bg-red-50 border border-red-200 rounded p-2">
          <span class="text-xs text-slate-400">${new Date(e.created_at).toLocaleString()}</span>
          ${e.hotel_name ? ' | ' + e.hotel_name : ''}
          <div class="text-red-700">${e.error || 'Unknown error'}</div>
        </div>`).join('');
  } catch(e) {
    document.getElementById('monitoring-cards').innerHTML = '<p class="text-red-500">Loi tai monitoring</p>';
  }
}

// ====== SUBSCRIPTION ======
async function loadSubscription() {
  try {
    const [plansRes, currentRes] = await Promise.all([
      api('/api/subscription/plans'),
      api('/api/subscription/current'),
    ]);
    const plans = await plansRes.json();
    const current = await currentRes.json();

    document.getElementById('current-plan-card').innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <h3 class="font-bold text-lg">${current.hotel_name}</h3>
          <p class="text-sm text-slate-500">Plan hien tai: <span class="font-bold text-blue-600 uppercase">${current.plan}</span></p>
        </div>
        <div class="text-right text-sm">
          <div>Bai dang hom nay: ${current.usage.posts_today} / ${current.limits.max_posts_per_day}</div>
          <div>AI calls: ${current.usage.ai_calls_today} / ${current.limits.ai_calls_per_day}</div>
          <div>Pages: ${current.usage.pages} / ${current.limits.max_pages}</div>
        </div>
      </div>
    `;

    // Payment history
    try {
      const histRes = await api('/api/payment/history');
      const history = await histRes.json();
      document.getElementById('payment-history').innerHTML = history.length === 0
        ? '<p class="text-slate-400">Chua co giao dich</p>'
        : history.map(h => `
          <div class="flex justify-between items-center border-b pb-1">
            <span>${h.plan.toUpperCase()} - ${h.method}</span>
            <span>${h.amount.toLocaleString()}d</span>
            <span class="${h.status === 'success' ? 'text-green-600' : h.status === 'failed' ? 'text-red-500' : 'text-yellow-600'}">${h.status}</span>
            <span class="text-xs text-slate-400">${new Date(h.created_at).toLocaleDateString()}</span>
          </div>`).join('');
    } catch(e) {}

    document.getElementById('plans-grid').innerHTML = plans.plans.map(p => `
      <div class="bg-white rounded-xl shadow p-6 ${p.id === current.plan ? 'ring-2 ring-blue-600' : ''}">
        <h3 class="font-bold text-lg">${p.name}</h3>
        <div class="text-2xl font-bold my-2">${p.price_vnd === 0 ? 'Mien phi' : p.price_vnd.toLocaleString() + 'đ/thang'}</div>
        <ul class="text-sm space-y-1 mb-4">
          <li>📝 ${p.max_posts_per_day} bai/ngay</li>
          <li>📘 ${p.max_pages} FB Page</li>
          <li>${p.autopilot ? '✅' : '❌'} Autopilot</li>
          <li>🔁 ${p.campaigns} campaigns</li>
          <li>📚 ${p.wiki} wiki entries</li>
          <li>🤖 ${p.ai_calls_per_day} AI calls/ngay</li>
        </ul>
        ${p.id === current.plan
          ? '<span class="text-green-600 font-semibold">Dang su dung</span>'
          : `<button onclick="requestUpgrade('${p.id}')" class="w-full bg-blue-600 text-white py-2 rounded font-semibold">Nang cap</button>`
        }
      </div>
    `).join('');
  } catch(e) {
    document.getElementById('current-plan-card').innerHTML = '<p class="text-red-500">Loi tai subscription</p>';
  }
}

async function requestUpgrade(plan) {
  if (!confirm('Ban muon nang cap len plan ' + plan.toUpperCase() + '?')) return;

  if (plan === 'free') {
    const r = await api('/api/subscription/upgrade', 'POST', { plan });
    const d = await r.json();
    if (d.ok) { alert('Da chuyen plan thanh cong!'); loadSubscription(); }
    else alert(d.error);
    return;
  }

  // Cho chon phuong thuc thanh toan
  const method = prompt('Chon phuong thuc thanh toan:\n1 = VNPay\n2 = MoMo\n3 = Chuyen khoan ngan hang');
  if (!method) return;

  let endpoint = '';
  if (method === '1') endpoint = '/api/payment/create-vnpay';
  else if (method === '2') endpoint = '/api/payment/create-momo';
  else if (method === '3') endpoint = '/api/payment/bank-transfer';
  else { alert('Lua chon khong hop le'); return; }

  const r = await api(endpoint, 'POST', { plan });
  const d = await r.json();

  if (d.paymentUrl) {
    window.open(d.paymentUrl, '_blank');
  } else if (d.payUrl) {
    window.open(d.payUrl, '_blank');
  } else if (d.bank_info) {
    alert(`Chuyen khoan:\nNgan hang: ${d.bank_info.bank}\nSTK: ${d.bank_info.account}\nTen: ${d.bank_info.name}\nSo tien: ${d.bank_info.amount.toLocaleString()}d\nNoi dung: ${d.bank_info.content}`);
  } else if (d.error) {
    alert(d.error);
  }
  loadSubscription();
}

// ====== ADMIN: Email & Payments ======
async function adminInviteAll() {
  if (!confirm('Gui email moi toi TAT CA khach san chua duoc moi?')) return;
  const r = await api('/api/admin/invite-all', 'POST');
  const d = await r.json();
  alert(`Da gui: ${d.sent}, That bai: ${d.failed}`);
  adminLoadEmails();
}

async function adminInviteSingle() {
  const hotel_id = document.getElementById('invite-hotel-id').value;
  const email = document.getElementById('invite-email').value;
  if (!hotel_id || !email) return alert('Nhap Hotel ID va Email');
  const r = await api('/api/admin/invite-hotel', 'POST', { hotel_id: parseInt(hotel_id), email });
  const d = await r.json();
  alert(d.ok ? 'Da gui!' : 'Loi: ' + (d.error || 'unknown'));
  adminLoadEmails();
}

async function adminTestAlert() {
  await api('/api/admin/test-alert', 'POST');
  alert('Da gui test alert');
}

async function adminLoadEmails() {
  const r = await api('/api/admin/email-log');
  const data = await r.json();
  document.getElementById('email-log-list').innerHTML = data.length === 0
    ? '<p class="text-slate-400">Chua co email</p>'
    : data.slice(0, 50).map(e => `
      <div class="flex justify-between border-b pb-1">
        <span class="truncate flex-1">${e.to_email}</span>
        <span class="truncate flex-1 mx-2">${e.subject}</span>
        <span class="${e.status === 'sent' ? 'text-green-600' : 'text-red-500'}">${e.status}</span>
        <span class="text-xs text-slate-400 ml-2">${new Date(e.created_at).toLocaleDateString()}</span>
      </div>`).join('');
}

async function adminLoadPayments() {
  const r = await api('/api/admin/payments');
  const data = await r.json();
  document.getElementById('admin-payments-list').innerHTML = data.length === 0
    ? '<p class="text-slate-400">Chua co giao dich</p>'
    : data.map(p => `
      <div class="flex justify-between items-center border-b pb-2">
        <div>
          <span class="font-semibold">${p.hotel_name || 'Hotel #' + p.hotel_id}</span>
          <span class="text-xs ml-2">${p.plan.toUpperCase()} - ${p.method}</span>
        </div>
        <span>${p.amount.toLocaleString()}d</span>
        <span class="${p.status === 'success' ? 'text-green-600' : p.status === 'pending_verify' ? 'text-yellow-600' : p.status === 'failed' ? 'text-red-500' : 'text-slate-500'}">${p.status}</span>
        ${p.status === 'pending_verify' ? `<button onclick="adminConfirmPayment('${p.order_id}')" class="bg-green-600 text-white px-2 py-1 rounded text-xs">Xac nhan</button>` : ''}
      </div>`).join('');
}

async function adminConfirmPayment(orderId) {
  if (!confirm('Xac nhan thanh toan cho order: ' + orderId + '?')) return;
  const r = await api('/api/admin/confirm-bank-transfer', 'POST', { order_id: orderId });
  const d = await r.json();
  alert(d.ok ? 'Da xac nhan! Plan: ' + d.plan : 'Loi: ' + d.error);
  adminLoadPayments();
}

// ====== SYSTEM CONFIG (Admin only) ======
const SYS_KEYS = [
  'fb_app_id', 'fb_app_secret',
  'anthropic_api_key', 'deepseek_api_key', 'openai_api_key',
  'google_api_key', 'groq_api_key', 'mistral_api_key', 'fal_api_key',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from',
  'vnp_tmn_code', 'vnp_hash_secret', 'vnp_return_url',
  'momo_partner_code', 'momo_access_key', 'momo_secret_key', 'momo_return_url',
];

async function loadSysConfig() {
  try {
    const r = await api('/api/admin/system-config');
    const data = await r.json();
    for (const key of SYS_KEYS) {
      const el = document.getElementById('sys-' + key);
      if (!el) continue;
      const info = data[key];
      if (info && info.has_value) {
        el.value = info.value; // masked for secrets
      }
    }
    document.getElementById('sys-config-status').textContent = '✅ Da tai cau hinh';
  } catch(e) {
    document.getElementById('sys-config-status').textContent = '❌ Loi tai config (chi admin moi xem duoc)';
  }
}

async function saveSysConfig() {
  const updates = {};
  let count = 0;
  for (const key of SYS_KEYS) {
    const el = document.getElementById('sys-' + key);
    if (!el) continue;
    const val = el.value.trim();
    if (val && !val.startsWith('***')) {
      updates[key] = val;
      count++;
    }
  }
  if (count === 0) { alert('Khong co gi de luu'); return; }
  const r = await api('/api/admin/system-config', 'POST', updates);
  const d = await r.json();
  document.getElementById('sys-config-status').textContent = d.ok
    ? `✅ Da luu ${d.saved} cau hinh. Co hieu luc ngay, khong can restart!`
    : '❌ Loi luu';
}

// ====== Tab hooks for new tabs ======
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'dashboard') setTimeout(loadDashboard, 100);
  });
});

// ====== Init ======
checkAuth();
