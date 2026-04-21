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
  document.querySelectorAll('.admin-only, .nav-admin').forEach(el => {
    el.classList.toggle('hidden', !isAdmin);
  });

  // Topbar user + plan
  const ub = document.getElementById('topbar-user');
  if (ub) ub.textContent = (isAdmin ? '👑 Admin' : '🏨 ') + (currentUser.email || '');
  api('/settings/profile').then(p => {
    const pb = document.getElementById('topbar-plan');
    if (pb && p?.plan) { pb.textContent = String(p.plan).toUpperCase(); pb.classList.remove('hidden'); }
  }).catch(()=>{});
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
  if (tab === 'dashboard') { loadDashboard(); loadStatusBanner && loadStatusBanner(); }
  if (tab === 'posts') loadPosts();
  if (tab === 'media') loadMedia();
  if (tab === 'settings') { loadSettings(); loadAllProviderKeys(); loadAiTier(); loadSysConfig(); }
  if (tab === 'campaigns') loadCampaigns();
  if (tab === 'autoreply') loadAutoReply();
  if (tab === 'wiki') loadWiki();
  if (tab === 'analytics') loadAnalytics();
  if (tab === 'autopilot') loadAutopilotStatus();
  if (tab === 'room-images') loadRoomImages();
  if (tab === 'monitoring') { loadMonitoring(7); loadLearningStats(); }
  if (tab === 'appointments') loadAppointments();
  if (tab === 'agent-audit') { loadAgentAudit(); loadAgentToggle(); }
  if (tab === 'bot-control') loadBotStatus();
  if (tab === 'funnel') loadFunnel();
  if (tab === 'intents') loadIntents();
  if (tab === 'revenue') loadRevenue();
  if (tab === 'knowledge-sync') loadKnowledgeSync();
  if (tab === 'training') loadTraining();
  if (tab === 'news') loadNews();
  if (tab === 'playground') loadPlayground();
  if (tab === 'hotels') loadHotelsEditor();
  if (tab === 'conversations') loadConversations();
  if (tab === 'otadb') loadOtaConfig();
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

// ═══ Video gen modal (3 tiers + image-to-video) ═══
let _vidSelectedImageId = null;

async function openVideoModal() {
  const caption = document.getElementById('compose-caption').value.trim();
  if (!caption) return setStatus('Viết caption trước đã', 'err');
  _vidSelectedImageId = null;
  document.getElementById('vid-image-sel').textContent = '—';
  document.getElementById('video-modal').classList.remove('hidden');

  // Load ảnh gần đây
  const grid = document.getElementById('vid-image-grid');
  grid.innerHTML = '<div class="col-span-4 text-xs text-slate-500 text-center py-4">Đang tải...</div>';
  try {
    const list = await api('/media');
    const imgs = list.filter(m => (m.mime_type || '').startsWith('image/')).slice(0, 40);
    if (imgs.length === 0) {
      grid.innerHTML = '<div class="col-span-4 text-xs text-slate-500 text-center py-4">Chưa có ảnh. Upload hoặc tạo ảnh AI trước.</div>';
      return;
    }
    grid.innerHTML = imgs.map(m =>
      `<img data-id="${m.id}" data-name="${m.filename}" src="/media/${m.filename}" class="vid-pick w-full h-20 object-cover rounded cursor-pointer border-2 border-transparent hover:border-indigo-400"/>`
    ).join('');
    grid.querySelectorAll('.vid-pick').forEach(el => {
      el.addEventListener('click', () => {
        grid.querySelectorAll('.vid-pick').forEach(x => x.classList.remove('border-indigo-500'));
        el.classList.add('border-indigo-500');
        _vidSelectedImageId = Number(el.dataset.id);
        document.getElementById('vid-image-sel').textContent = el.dataset.name;
      });
    });
  } catch (e) {
    grid.innerHTML = `<div class="col-span-4 text-xs text-red-600 text-center py-4">Lỗi: ${e.message}</div>`;
  }
}

function closeVideoModal() {
  document.getElementById('video-modal').classList.add('hidden');
}

document.getElementById('btn-gen-video').addEventListener('click', openVideoModal);
document.getElementById('video-modal-close').addEventListener('click', closeVideoModal);
document.getElementById('video-modal-cancel').addEventListener('click', closeVideoModal);

// Ẩn/hiện khung chọn ảnh theo mode
document.querySelectorAll('input[name="vid-mode"]').forEach(r => {
  r.addEventListener('change', () => {
    const isI2v = document.querySelector('input[name="vid-mode"]:checked').value === 'i2v';
    document.getElementById('vid-image-picker').style.display = isI2v ? '' : 'none';
  });
});

document.getElementById('video-modal-submit').addEventListener('click', async () => {
  const caption = document.getElementById('compose-caption').value.trim();
  const mode = document.querySelector('input[name="vid-mode"]:checked').value;
  const tier = document.querySelector('input[name="vid-tier"]:checked').value;
  const tierLabel = { standard: 'Kling Std $0.35', pro: 'Kling Pro $0.95', veo3: 'Veo 3 $2.50' }[tier];

  if (mode === 'i2v' && !_vidSelectedImageId) {
    return alert('Chọn 1 ảnh làm frame đầu (hoặc đổi sang mode Text-only)');
  }
  if (!confirm(`Tạo video bằng ${tierLabel}. Mất 2-4 phút. Tiếp tục?`)) return;

  closeVideoModal();
  setStatus(`⏳ Đang tạo video ${tierLabel}... 2-4 phút, đừng đóng tab`);
  try {
    const body = { caption, tier };
    if (mode === 'i2v') body.imageMediaId = _vidSelectedImageId;
    const r = await api('/ai/video', { method: 'POST', body: JSON.stringify(body) });
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

// ═══════════════════════════════════════════════════════════════
// AI Providers — redesigned settings UI
// Per-card handlers: Save / Test / Wipe / Toggle visibility
// Plus: AI tier selector (free/balanced/premium)
// ═══════════════════════════════════════════════════════════════

const PROVIDER_SETTING_KEY = {
  google: 'google_api_key',
  anthropic: 'anthropic_api_key',
  deepseek: 'deepseek_api_key',
  openai: 'openai_api_key',
};

function setProviderMsg(provider, text, kind) {
  const el = document.querySelector(`[data-msg="${provider}"]`);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'provider-msg text-xs mt-2' + (kind ? ' ' + kind : '');
  if (text && kind === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
}

function updateBadge(provider, count) {
  const el = document.querySelector(`[data-badge="${provider}"]`);
  if (!el) return;
  if (count > 0) {
    el.textContent = `✓ ${count} key${count > 1 ? 's' : ''}`;
    el.className = 'provider-badge text-xs px-2 py-1 rounded ok';
  } else {
    el.textContent = '⚠ Chưa có';
    el.className = 'provider-badge text-xs px-2 py-1 rounded muted';
  }
}

async function loadAllProviderKeys() {
  try {
    const r = await api('/settings');
    for (const p of ['google','anthropic','deepseek','openai','groq','fal']) {
      const info = r[p];
      if (!info) continue;
      const ta = document.querySelector(`[data-key="${p}"]`);
      if (ta) ta.value = info.masked || '';
      updateBadge(p, info.count || 0);
    }
  } catch (e) { console.warn('loadAllProviderKeys:', e); }
}

// Save one provider's key (APPEND mode — preserves existing keys)
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.btn-save-key');
  if (!btn) return;
  const provider = btn.dataset.provider;
  const ta = document.querySelector(`[data-key="${provider}"]`);
  const val = ta ? ta.value.trim() : '';
  if (!val) { setProviderMsg(provider, 'Chưa nhập key', 'err'); return; }

  try {
    const body = {};
    body[`${provider}_api_key`] = val;
    const r = await api('/settings/keys', { method: 'POST', body: JSON.stringify(body) });
    setProviderMsg(provider, `✅ Đã lưu · tổng ${r[`${provider}_count`] || '?'} key`, 'ok');
    // Clear input & reload masked view
    ta.value = '';
    await loadAllProviderKeys();
  } catch (e) {
    setProviderMsg(provider, '❌ ' + e.message, 'err');
  }
});

// Test key (live API call)
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.btn-test-key');
  if (!btn) return;
  const provider = btn.dataset.provider;
  const ta = document.querySelector(`[data-key="${provider}"]`);
  const rawKey = ta ? ta.value.trim() : '';
  // If user typed a new key that isn't masked, test that one; else test stored
  const payload = { provider };
  if (rawKey && !rawKey.startsWith('***')) payload.key = rawKey;

  setProviderMsg(provider, '⏳ Đang test...', 'info');
  btn.disabled = true;
  try {
    const r = await api('/settings/test-key', { method: 'POST', body: JSON.stringify(payload) });
    if (r.ok) {
      const extra = r.info ? ` · ${r.info}` : (r.models ? ` · ${r.models.length} model` : '');
      setProviderMsg(provider, `✅ Key sống${extra}`, 'ok');
    } else {
      setProviderMsg(provider, '❌ ' + (r.error || 'Key không hợp lệ'), 'err');
    }
  } catch (e) {
    setProviderMsg(provider, '❌ ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// Wipe all keys of a provider
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.btn-wipe-key');
  if (!btn) return;
  const provider = btn.dataset.provider;
  if (!confirm(`Xoá TẤT CẢ key của ${provider}?`)) return;
  try {
    await api(`/settings/keys/${provider}`, { method: 'DELETE' });
    setProviderMsg(provider, '🗑 Đã xoá', 'ok');
    const ta = document.querySelector(`[data-key="${provider}"]`);
    if (ta) ta.value = '';
    await loadAllProviderKeys();
  } catch (e) {
    setProviderMsg(provider, '❌ ' + e.message, 'err');
  }
});

// Toggle show/hide key
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.btn-toggle-vis');
  if (!btn) return;
  const ta = document.querySelector(`[data-key="${btn.dataset.key}"]`);
  if (!ta) return;
  ta.classList.toggle('visible');
  btn.textContent = ta.classList.contains('visible') ? '🙈 Ẩn' : '👁 Hiện';
});

// AI Tier selector
async function loadAiTier() {
  try {
    const r = await api('/settings/ai-tier');
    const tier = r.tier || 'balanced';
    document.querySelectorAll('#ai-tier-selector .tier-card').forEach(card => {
      const isSel = card.dataset.tier === tier;
      card.classList.toggle('selected', isSel);
      const radio = card.querySelector('input[type="radio"]');
      if (radio) radio.checked = isSel;
    });
  } catch (e) { console.warn('loadAiTier:', e); }
}
document.addEventListener('click', async (ev) => {
  const card = ev.target.closest('#ai-tier-selector .tier-card');
  if (!card) return;
  const tier = card.dataset.tier;
  try {
    await api('/settings/ai-tier', { method: 'POST', body: JSON.stringify({ tier }) });
    document.querySelectorAll('#ai-tier-selector .tier-card').forEach(c => c.classList.toggle('selected', c === card));
    const st = document.getElementById('ai-tier-status');
    st.textContent = `✅ Đã chuyển sang chế độ "${tier}"`;
    st.className = 'text-xs mt-2 text-green-600';
    setTimeout(() => { st.textContent = ''; }, 3000);
    // Refresh router status to reflect new tier
    setTimeout(() => { if (window.loadRouterStatus) window.loadRouterStatus(); }, 300);
  } catch (e) {
    const st = document.getElementById('ai-tier-status');
    st.textContent = '❌ ' + e.message;
    st.className = 'text-xs mt-2 text-red-600';
  }
});

// Load on settings tab open
window.addEventListener('DOMContentLoaded', () => {
  loadAiTier();
  loadAllProviderKeys();
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
  document.getElementById('wiki-namespace').value = 'hotel_info';
  document.getElementById('wiki-title').value = '';
  document.getElementById('wiki-content').value = '';
  document.getElementById('wiki-tags').value = '';
  document.getElementById('wiki-always-inject').checked = false;
  document.getElementById('wiki-status').textContent = '';
  updateWikiPlaceholders();
}

// Placeholder gợi ý theo namespace được chọn
const WIKI_PLACEHOLDERS = {
  hotel_info: {
    title: 'VD: Sonder Airport — Căn hộ dịch vụ gần Tân Sơn Nhất',
    content: 'VD:\n- Tên: Sonder Airport\n- Địa chỉ: 123 Trường Sơn, P.2, Tân Bình\n- Hotline: 0909...\n- Lễ tân: 24/7\n- Số phòng: 30\n- Khoảng cách sân bay: 800m (đi bộ 10p, taxi 5p)',
    tags: 'địa chỉ, hotline, overview',
    alwaysInject: true,
  },
  room: {
    title: 'VD: Studio Deluxe 25m² — giường queen',
    content: 'VD:\n- Diện tích: 25m²\n- Giường: 1 queen (1.6m)\n- Giá: 650k/đêm (T2-T5), 780k (T6-CN)\n- Tiện nghi: máy lạnh, TV, bếp mini, tủ lạnh, bồn tắm đứng\n- Sức chứa: 2 người lớn + 1 trẻ <6t\n- View: hướng sân bay (ngắm máy bay cất cánh)',
    tags: 'studio, queen, 2 người',
    alwaysInject: false,
  },
  amenity: {
    title: 'VD: Wifi & Internet',
    content: 'VD:\n- Wifi miễn phí tốc độ 200Mbps phủ toàn khu\n- Có router riêng mỗi tầng\n- Hỗ trợ work-from-hotel\n- Mật khẩu ghi trong phòng',
    tags: 'wifi, internet',
    alwaysInject: false,
  },
  directions: {
    title: 'VD: Hướng dẫn đi từ sân bay Tân Sơn Nhất',
    content: 'VD:\n- **Đi bộ**: ra khỏi ga đến, rẽ phải đi Trường Sơn ~800m (10 phút)\n- **Taxi/Grab**: 5 phút, 30-50k\n- **Xe buýt 109**: xuống trạm Công viên Hoàng Văn Thụ, đi bộ 5p\n- **Shuttle miễn phí**: hotel có xe đưa đón, báo trước 1h qua hotline',
    tags: 'sân bay, grab, taxi, shuttle',
    alwaysInject: false,
  },
  policy: {
    title: 'VD: Chính sách check-in / check-out',
    content: 'VD:\n- **Check-in**: 14:00\n- **Check-out**: 12:00\n- **Early check-in**: trước 12:00 tính 50% đêm\n- **Late check-out**: sau 14:00 tính 50% đêm\n- **Giấy tờ**: CCCD/passport bản gốc\n- **Đặt cọc**: 200k, hoàn khi trả phòng',
    tags: 'check-in, check-out, cọc',
    alwaysInject: false,
  },
  nearby: {
    title: 'VD: Ăn uống xung quanh',
    content: 'VD:\n- **Phở Hoàng** (đối diện): phở bò truyền thống, 55k, mở 6-22h\n- **Cơm tấm Ba Ghiền** (300m): cơm sườn nướng 70k, rất đông giờ trưa\n- **Trà sữa Gong Cha** (500m): trong AEON Tân Phú\n- **The Coffee House** (200m): wifi mạnh, ổ cắm nhiều',
    tags: 'ăn uống, cafe, quanh đây',
    alwaysInject: false,
  },
  promotion: {
    title: 'VD: Combo cuối tuần T10/2026',
    content: 'VD:\n- **Tên**: "2 đêm 1 đêm FREE"\n- **Điều kiện**: đặt từ T6 đến CN\n- **Hiệu lực**: 01/10 - 31/10/2026\n- **Code**: WEEKEND24\n- **Giảm**: đêm thứ 2 miễn phí (áp dụng Studio Deluxe trở lên)\n- **Lưu ý**: không cộng dồn với KM khác',
    tags: 'cuối tuần, combo, code',
    alwaysInject: false,
  },
  brand_voice: {
    title: 'VD: Giọng văn Sonder Airport',
    content: 'VD:\n- Xưng "mình" với khách, không dùng "chúng tôi"\n- Tone: trẻ trung, kể chuyện như bạn bè, pha chút hài\n- Tránh: sáo rỗng ("tuyệt vời", "đỉnh cao"), sales-y ("book ngay")\n- Hashtag ưu tiên: #SonderAirport #NgủGầnSânBay',
    tags: 'tone, brand',
    alwaysInject: true,
  },
  faq: {
    title: 'VD: Có cho phép mang thú cưng không?',
    content: '**Câu hỏi:** Mang chó/mèo được không?\n\n**Trả lời:** Mình chưa nhận pet nhé ạ — có bạn khách dị ứng lông nên hotel giữ policy no-pet. Rất tiếc!',
    tags: 'pet, thú cưng',
    alwaysInject: false,
  },
};

function updateWikiPlaceholders() {
  const ns = document.getElementById('wiki-namespace').value;
  const tpl = WIKI_PLACEHOLDERS[ns];
  if (!tpl) return;
  const titleEl = document.getElementById('wiki-title');
  const contentEl = document.getElementById('wiki-content');
  const tagsEl = document.getElementById('wiki-tags');
  if (!titleEl.value) titleEl.placeholder = tpl.title;
  if (!contentEl.value) contentEl.placeholder = tpl.content;
  if (!tagsEl.value) tagsEl.placeholder = tpl.tags;
}

document.addEventListener('DOMContentLoaded', () => {
  const nsSel = document.getElementById('wiki-namespace');
  if (nsSel) nsSel.addEventListener('change', updateWikiPlaceholders);
});

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

// Legacy functions kept as no-op shims for backward compat (removed UI)
async function loadAllApiKeys() { /* replaced by loadAllProviderKeys */ }
async function saveAllApiKeys() { /* replaced by per-card btn-save-key handlers */ }

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
    st.innerHTML = r.ok ? `✅ ${r.message} <span class="text-xs text-slate-500">(${escapeHtml((r.version || '').slice(0, 50))})</span>` : `❌ ${r.message}`;
  } catch (e) { st.textContent = '❌ ' + e.message; }
});

// Đợt 4: Enumerate schema
document.getElementById('btn-ota-enum')?.addEventListener('click', async () => {
  const st = document.getElementById('ota-status');
  st.textContent = '⏳ Đang liệt kê schema...';
  try {
    const r = await api('/ota/schema');
    if (!r.ok) { st.textContent = '❌ ' + (r.error || 'lỗi'); return; }
    renderOtaSchema(r.tables, r.views);
    st.innerHTML = `✅ ${r.tables.length} tables + ${r.views.length} views`;
  } catch (e) { st.textContent = '❌ ' + e.message; }
});

function isLikelyBotView(name, cols) {
  const n = (name || '').toLowerCase();
  const colJoin = (cols || []).join(' ').toLowerCase();
  if (/bot|marketing|mkt|sonder|public|v_|preview/.test(n)) return true;
  if (/summary|description|usp|brand|ai_|profile/.test(colJoin)) return true;
  return false;
}

function renderOtaSchema(tables, views) {
  document.getElementById('ota-tables-count').textContent = '(' + tables.length + ')';
  document.getElementById('ota-views-count').textContent = '(' + views.length + ')';

  // Views rendered FIRST with highlighting for marketing candidates
  const vBox = document.getElementById('ota-views');
  if (!views.length) {
    vBox.innerHTML = '<div class="text-slate-400">Không có view nào.</div>';
  } else {
    vBox.innerHTML = views.map(v => {
      const botLike = isLikelyBotView(v.name, v.columns);
      const bg = botLike ? 'bg-emerald-50 border-emerald-300' : 'bg-slate-50 border-slate-200';
      const badge = botLike ? '<span class="text-[10px] bg-emerald-600 text-white px-1 rounded">BOT?</span>' : '';
      return `<div class="${bg} border rounded p-2 cursor-pointer hover:shadow-sm ota-view-item" data-schema="${escapeHtml(v.schema)}" data-name="${escapeHtml(v.name)}">
        <div class="flex items-center gap-1 font-semibold text-slate-800">${badge} ${escapeHtml(v.schema)}.${escapeHtml(v.name)}</div>
        <div class="text-[10px] text-slate-500 mt-0.5">${(v.columns || []).length} cols: ${escapeHtml((v.columns || []).slice(0, 8).join(', '))}${(v.columns || []).length > 8 ? '...' : ''}</div>
      </div>`;
    }).join('');
  }

  const tBox = document.getElementById('ota-tables');
  if (!tables.length) {
    tBox.innerHTML = '<div class="text-slate-400">Không có table nào.</div>';
  } else {
    tBox.innerHTML = tables.map(t => `<div class="bg-slate-50 border border-slate-200 rounded p-2 cursor-pointer hover:shadow-sm ota-view-item" data-schema="${escapeHtml(t.schema)}" data-name="${escapeHtml(t.name)}">
      <div class="font-semibold text-slate-800">${escapeHtml(t.schema)}.${escapeHtml(t.name)} <span class="text-slate-500 text-[10px] font-normal">${t.row_count ? (+t.row_count).toLocaleString() + ' rows' : ''}</span></div>
      <div class="text-[10px] text-slate-500 mt-0.5">${(t.columns || []).length} cols: ${escapeHtml((t.columns || []).slice(0, 6).join(', '))}${(t.columns || []).length > 6 ? '...' : ''}</div>
    </div>`).join('');
  }

  // Wire click to sample
  document.querySelectorAll('.ota-view-item').forEach(el => {
    el.addEventListener('click', () => otaSample(el.dataset.schema, el.dataset.name));
  });
}

async function otaSample(schema, name) {
  const box = document.getElementById('ota-sample');
  const nameEl = document.getElementById('ota-sample-name');
  const dataEl = document.getElementById('ota-sample-data');
  box.classList.remove('hidden');
  nameEl.textContent = schema + '.' + name;
  dataEl.textContent = '⏳ Đang lấy mẫu...';
  try {
    const r = await api('/ota/sample', { method: 'POST', body: JSON.stringify({ schema, name, limit: 3 }) });
    if (r.ok) dataEl.textContent = JSON.stringify(r.rows, null, 2);
    else dataEl.textContent = '❌ ' + (r.error || 'lỗi');
  } catch (e) { dataEl.textContent = '❌ ' + e.message; }
}

document.getElementById('ota-sample-close')?.addEventListener('click', () => {
  document.getElementById('ota-sample').classList.add('hidden');
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
      room_images: '📸 Import anh phong tu OTA',
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
    room_images: `
      <p class="text-sm mb-3">Tu dong tai ve toan bo anh phong tu OTA DB → luu vao Media → bot gui khach khi can.</p>
      <button onclick="obImportRoomImages()" class="bg-blue-600 text-white px-4 py-2 rounded text-sm">📥 Import ngay</button>
      <span id="ob-rooms-status" class="text-sm ml-2"></span>`,
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

async function obImportRoomImages() {
  const el = document.getElementById('ob-rooms-status');
  el.textContent = 'Dang tai anh...';
  const r = await api('/api/onboarding/step/import-room-images', 'POST');
  const d = await r.json();
  el.textContent = d.ok
    ? `✅ Import ${d.imported} anh (bo qua ${d.skipped}, loi ${d.failed})`
    : '❌ ' + (d.error || 'Loi');
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
  'bank_bin', 'bank_account', 'bank_holder', 'bank_name',
  'admin_zalo', 'admin_hotline', 'admin_telegram_chat_id',
  'price_starter', 'price_pro', 'price_enterprise',
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

// ====== SUBSCRIPTION REQUESTS (Admin duyet don) ======
async function loadSubRequests() {
  const box = document.getElementById('sub-requests-list');
  if (!box) return;
  box.innerHTML = '<div class="text-slate-500">Dang tai...</div>';
  try {
    const r = await api('/api/subscription/admin/requests');
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      box.innerHTML = '<div class="text-slate-500">Chua co don nao</div>';
      return;
    }
    box.innerHTML = rows.map(r => {
      const d = new Date(r.created_at).toLocaleString('vi-VN');
      const amt = (r.amount || 0).toLocaleString('vi');
      const statusColor = {
        awaiting_proof: 'bg-yellow-100 text-yellow-800',
        proof_submitted: 'bg-blue-100 text-blue-800',
        approved: 'bg-green-100 text-green-800',
        rejected: 'bg-red-100 text-red-800',
        pending: 'bg-slate-100 text-slate-700',
      }[r.status] || 'bg-slate-100';
      const proofLink = r.proof_url ? `<a href="${r.proof_url}" target="_blank" class="text-blue-600 underline">Xem bill</a>` : '<span class="text-slate-400">chua co bill</span>';
      const actions = (r.status === 'proof_submitted' || r.status === 'awaiting_proof') ? `
        <button onclick="approveSubRequest(${r.id})" class="bg-green-600 text-white px-3 py-1 rounded text-xs">✓ Duyet</button>
        <button onclick="rejectSubRequest(${r.id})" class="bg-red-600 text-white px-3 py-1 rounded text-xs">✗ Tu choi</button>
      ` : '';
      return `
        <div class="border rounded p-3">
          <div class="flex justify-between items-start">
            <div>
              <div class="font-semibold">#${r.id} · ${r.hotel_name || 'Hotel #' + r.hotel_id}</div>
              <div class="text-xs text-slate-500">${d} · ${r.current_plan || '—'} → <b>${r.requested_plan}</b> · ${amt}đ</div>
              <div class="text-xs mt-1">${proofLink} ${r.admin_note ? '· <i>' + r.admin_note + '</i>' : ''}</div>
            </div>
            <div class="flex flex-col gap-1 items-end">
              <span class="px-2 py-0.5 rounded text-xs ${statusColor}">${r.status}</span>
              <div class="flex gap-1 mt-1">${actions}</div>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    box.innerHTML = '<div class="text-red-600">Loi tai don (chi admin xem duoc)</div>';
  }
}

async function approveSubRequest(id) {
  const note = prompt('Ghi chu duyet (tuy chon):') || '';
  const r = await api('/api/subscription/admin/approve', 'POST', { request_id: id, note });
  const d = await r.json();
  if (d.ok) { alert('✅ Da duyet. Plan active, het han: ' + new Date(d.expires_at).toLocaleDateString('vi-VN')); loadSubRequests(); }
  else alert('❌ ' + (d.error || 'Loi'));
}

async function rejectSubRequest(id) {
  const reason = prompt('Ly do tu choi:') || 'Tu choi';
  const r = await api('/api/subscription/admin/reject', 'POST', { request_id: id, reason });
  const d = await r.json();
  if (d.ok) { alert('Da tu choi'); loadSubRequests(); }
  else alert('❌ ' + (d.error || 'Loi'));
}

// ====== STATUS BANNER (dashboard) ======
async function loadStatusBanner() {
  const el = document.getElementById('dash-banner');
  if (!el) return;
  try {
    const r = await api('/api/subscription/current');
    const d = await r.json();
    if (!d || d.error) { el.classList.add('hidden'); return; }

    let html = '', cls = '';
    if (d.banner === 'expired') {
      cls = 'bg-red-50 border-red-400 text-red-800';
      html = `⚠️ <b>Goi ${d.plan} da het han</b> (${new Date(d.plan_expires_at).toLocaleDateString('vi-VN')}). <a href="/pricing.html" class="underline font-bold">Gia han ngay</a>`;
    } else if (d.banner === 'trial_expired') {
      cls = 'bg-orange-50 border-orange-400 text-orange-800';
      html = `⏰ <b>Thoi gian dung thu da ket thuc.</b> <a href="/pricing.html" class="underline font-bold">Chon goi de tiep tuc</a>`;
    } else if (d.pending_request) {
      const pr = d.pending_request;
      cls = 'bg-blue-50 border-blue-400 text-blue-800';
      const statusTxt = { awaiting_proof: 'Cho ban chuyen khoan + gui bill', proof_submitted: 'Da nhan bill, admin dang duyet', pending: 'Dang cho xu ly' }[pr.status] || pr.status;
      html = `⏳ Don nang cap len <b>${pr.requested_plan}</b>: ${statusTxt}. ${pr.status === 'awaiting_proof' ? '<a href="/pricing.html" class="underline font-bold">Hoan tat thanh toan</a>' : ''}`;
    } else if (d.plan_expires_at) {
      const days = Math.ceil((d.plan_expires_at - Date.now()) / 86400000);
      if (days <= 7) {
        cls = 'bg-yellow-50 border-yellow-400 text-yellow-800';
        html = `🔔 Goi <b>${d.plan}</b> con ${days} ngay. <a href="/pricing.html" class="underline font-bold">Gia han</a>`;
      }
    }

    if (html) {
      el.className = 'rounded-xl p-4 border-2 ' + cls;
      el.innerHTML = html;
    } else {
      el.classList.add('hidden');
    }
  } catch {
    el.classList.add('hidden');
  }
}

// ====== FEEDBACK (staff cham bot) ======
async function loadFeedbackList() {
  const box = document.getElementById('feedback-list');
  if (!box) return;
  box.innerHTML = '<div class="text-slate-500">Dang tai...</div>';
  try {
    const [lst, st] = await Promise.all([
      api('/api/feedback/recent-replies').then(r => r.json()),
      api('/api/feedback/stats').then(r => r.json()),
    ]);
    document.getElementById('feedback-stats').textContent =
      `Tong: ${st.total||0} · 👍 ${st.good||0} · 👎 ${st.bad||0} · Sua: ${st.corrected||0}`;
    if (!lst.length) { box.innerHTML = '<div class="text-slate-500">Chua co tin nhan nao</div>'; return; }
    box.innerHTML = lst.map(r => {
      const d = new Date(r.created_at).toLocaleString('vi-VN');
      const rated = r.existing_rating;
      const goodCls = rated === 1 ? 'bg-green-600 text-white' : 'bg-white border';
      const badCls  = rated === -1 ? 'bg-red-600 text-white' : 'bg-white border';
      return `
        <div class="bg-white rounded-xl shadow p-4">
          <div class="text-xs text-slate-400">${d} · ${r.kind || ''} · fb_id: ${r.fb_id || '—'}</div>
          <div class="mt-2"><b>Khach:</b> ${escapeHtml(r.user_message || '').slice(0, 300)}</div>
          <div class="mt-1 text-blue-900"><b>Bot:</b> ${escapeHtml(r.bot_reply || '').slice(0, 500)}</div>
          <div class="flex items-center gap-2 mt-3">
            <button onclick="rateReply(${r.id}, 1, \`${encodeURIComponent(r.user_message||'')}\`, \`${encodeURIComponent(r.bot_reply||'')}\`)" class="${goodCls} px-3 py-1 rounded text-sm">👍 Dung</button>
            <button onclick="openCorrect(${r.id}, \`${encodeURIComponent(r.user_message||'')}\`, \`${encodeURIComponent(r.bot_reply||'')}\`)" class="${badCls} px-3 py-1 rounded text-sm">👎 Sai / Sua</button>
            <span class="text-xs text-slate-400">${rated === 1 ? '(da cham: dung)' : rated === -1 ? '(da cham: sai)' : ''}</span>
          </div>
        </div>`;
    }).join('');
  } catch(e) {
    box.innerHTML = '<div class="text-red-600">Loi: ' + e.message + '</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function rateReply(msgId, rating, uq, ba) {
  const r = await api('/api/feedback/rate', 'POST', {
    message_id: msgId, rating,
    user_question: decodeURIComponent(uq), bot_answer: decodeURIComponent(ba),
  });
  const d = await r.json();
  if (d.ok) loadFeedbackList(); else alert(d.error || 'Loi');
}

async function openCorrect(msgId, uq, ba) {
  const userQ = decodeURIComponent(uq);
  const botA = decodeURIComponent(ba);
  const corrected = prompt(`Cau tra loi DUNG cho: "${userQ.slice(0,100)}"\n\n(Bo trong de chi cham 👎 ma khong sua):`, '');
  if (corrected === null) return;
  const r = await api('/api/feedback/rate', 'POST', {
    message_id: msgId, rating: -1,
    user_question: userQ, bot_answer: botA,
    corrected_answer: corrected.trim() || null,
  });
  const d = await r.json();
  if (d.ok) {
    alert(corrected.trim() ? '✅ Da luu. Bot se hoc cau dung cho lan sau.' : '✅ Da cham 👎');
    loadFeedbackList();
  }
  else alert(d.error || 'Loi');
}

// ====== GUESTS (khach quen) ======
async function loadGuests() {
  const box = document.getElementById('guests-list');
  if (!box) return;
  box.innerHTML = '<div class="p-4 text-slate-500">Dang tai...</div>';
  try {
    const rows = await api('/api/feedback/guests').then(r => r.json());
    if (!rows.length) { box.innerHTML = '<div class="p-4 text-slate-500">Chua co khach nao</div>'; return; }
    box.innerHTML = `
      <table class="w-full text-sm">
        <thead class="bg-slate-100 text-xs uppercase"><tr>
          <th class="p-3 text-left">Ten</th><th class="p-3 text-left">SDT</th>
          <th class="p-3 text-right">Lan chat</th><th class="p-3 text-right">Da dat</th>
          <th class="p-3 text-left">Lan cuoi</th><th class="p-3 text-left">So thich</th>
        </tr></thead>
        <tbody>${rows.map(g => {
          let prefs = ''; try { prefs = Object.entries(JSON.parse(g.preferences||'{}')).map(([k,v])=>`${k}:${v}`).join(', '); } catch {}
          return `<tr class="border-t">
            <td class="p-3">${escapeHtml(g.name||'—')}</td>
            <td class="p-3 font-mono text-xs">${escapeHtml(g.phone||'—')}</td>
            <td class="p-3 text-right">${g.total_conversations}</td>
            <td class="p-3 text-right">${g.booked_count}</td>
            <td class="p-3 text-xs">${new Date(g.last_seen).toLocaleString('vi-VN')}</td>
            <td class="p-3 text-xs text-slate-500">${escapeHtml(prefs)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  } catch(e) {
    box.innerHTML = '<div class="p-4 text-red-600">Loi: ' + e.message + '</div>';
  }
}

// ====== REFERRAL ======
async function loadReferral() {
  try {
    const d = await api('/api/referral/my').then(r => r.json());
    document.getElementById('ref-code').textContent = d.code;
    document.getElementById('ref-link').value = location.origin + d.link;
    const s = d.stats || {};
    document.getElementById('ref-total').textContent = s.total || 0;
    document.getElementById('ref-pending').textContent = ((s.pending_amount || 0)).toLocaleString('vi') + 'đ';
    document.getElementById('ref-paid').textContent = ((s.paid_amount || 0)).toLocaleString('vi') + 'đ';
    const hist = d.recent || [];
    document.getElementById('ref-history').innerHTML = hist.length ? `
      <table class="w-full">
        <thead class="bg-slate-100 text-xs uppercase"><tr>
          <th class="p-2 text-left">Ngày</th><th class="p-2 text-left">KS được giới thiệu</th>
          <th class="p-2 text-left">Gói</th><th class="p-2 text-right">Số tiền</th>
          <th class="p-2 text-right">Hoa hồng</th><th class="p-2 text-center">Trạng thái</th>
        </tr></thead>
        <tbody>${hist.map(h => `<tr class="border-t">
          <td class="p-2 text-xs">${new Date(h.created_at).toLocaleDateString('vi-VN')}</td>
          <td class="p-2">${escapeHtml(h.referred_name||'Hotel #'+h.referred_hotel_id)}</td>
          <td class="p-2">${h.plan}</td>
          <td class="p-2 text-right font-mono">${(h.amount||0).toLocaleString('vi')}đ</td>
          <td class="p-2 text-right font-mono text-green-700">${(h.commission||0).toLocaleString('vi')}đ</td>
          <td class="p-2 text-center"><span class="${h.status==='paid'?'text-green-600':'text-orange-600'}">${h.status==='paid'?'✅ Đã trả':'⏳ Chờ'}</span></td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="text-slate-500">Chưa có giao dịch nào. Bắt đầu chia sẻ link để nhận hoa hồng!</div>';
  } catch(e) { console.warn('ref load fail', e); }
}

function copyRefCode() { navigator.clipboard.writeText(document.getElementById('ref-code').textContent); alert('Đã copy mã'); }
function copyRefLink() { navigator.clipboard.writeText(document.getElementById('ref-link').value); alert('Đã copy link'); }

// ====== Tab hooks for new tabs ======
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'dashboard') { setTimeout(loadDashboard, 100); setTimeout(loadStatusBanner, 150); }
    if (btn.dataset.tab === 'sysconfig') { setTimeout(loadSubRequests, 200); }
    if (btn.dataset.tab === 'feedback') { setTimeout(loadFeedbackList, 100); }
    if (btn.dataset.tab === 'guests') { setTimeout(loadGuests, 100); }
    if (btn.dataset.tab === 'referral') { setTimeout(loadReferral, 100); }
  });
});

// ====== ROOM IMAGES ======
async function loadRoomImages() {
  try {
    const resp = await fetch('/api/media/room-images', { credentials: 'include' });
    const images = await resp.json();
    const list = document.getElementById('room-images-list');
    if (!Array.isArray(images) || images.length === 0) {
      list.innerHTML = '<p class="text-slate-400 col-span-full">Chua co anh nao. Upload o tren de bat dau.</p>';
      return;
    }
    list.innerHTML = images.map(img => `
      <div class="border rounded overflow-hidden bg-slate-50">
        <img src="${img.image_url}" alt="${img.room_type_name}" class="w-full h-40 object-cover" onerror="this.style.background='#ddd';this.alt='Loi tai anh'" />
        <div class="p-2">
          <div class="text-sm font-medium truncate">${img.room_type_name}</div>
          ${img.caption ? `<div class="text-xs text-slate-500 truncate">${img.caption}</div>` : ''}
          <button onclick="deleteRoomImage(${img.id})" class="mt-1 text-xs text-red-600 hover:underline">Xoa</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('room-images-list').innerHTML = `<p class="text-red-500 col-span-full">Loi: ${e.message}</p>`;
  }
}

async function deleteRoomImage(id) {
  if (!confirm('Xoa anh nay?')) return;
  try {
    const resp = await fetch('/api/media/room-images/' + id, { method: 'DELETE', credentials: 'include' });
    if (!resp.ok) throw new Error('Xoa that bai');
    loadRoomImages();
  } catch (e) {
    alert(e.message);
  }
}

document.getElementById('room-images-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('ri-status');
  const roomType = document.getElementById('ri-room-type').value.trim();
  const caption = document.getElementById('ri-caption').value.trim();
  const files = document.getElementById('ri-files').files;
  if (!roomType || !files.length) { status.textContent = 'Thieu thong tin'; status.className = 'text-sm ml-3 text-red-600'; return; }

  const fd = new FormData();
  fd.append('room_type_name', roomType);
  if (caption) fd.append('caption', caption);
  for (const f of files) fd.append('files', f);

  status.textContent = '⏳ Dang upload...'; status.className = 'text-sm ml-3 text-slate-500';
  try {
    const resp = await fetch('/api/media/room-images/upload', {
      method: 'POST', credentials: 'include', body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Upload that bai');
    status.textContent = `✅ Upload ${data.count} anh OK`; status.className = 'text-sm ml-3 text-green-600';
    document.getElementById('room-images-form').reset();
    loadRoomImages();
  } catch (err) {
    status.textContent = '❌ ' + err.message; status.className = 'text-sm ml-3 text-red-600';
  }
});

// ====== LEARNING CACHE STATS ======
async function loadLearningStats() {
  const box = document.getElementById('learning-stats');
  if (!box) return;
  try {
    const resp = await fetch('/api/monitoring/learning', { credentials: 'include' });
    const s = await resp.json();
    box.innerHTML = `
      <div class="flex gap-6">
        <div><span class="text-slate-500">Total:</span> <b>${s.total}</b></div>
        <div><span class="text-slate-500">Promoted (&ge;${s.min_hits} hits):</span> <b class="text-green-600">${s.promoted}</b></div>
        <div><span class="text-slate-500">Threshold:</span> sim &ge; ${s.serve_threshold}</div>
      </div>
      ${s.top && s.top.length ? `
        <div class="mt-3">
          <div class="text-xs font-semibold text-slate-500 mb-1">Top cau hoi hoc duoc:</div>
          <div class="space-y-1">
            ${s.top.map(t => `
              <div class="flex justify-between border-b py-1">
                <span class="truncate mr-2">"${t.question}"</span>
                <span class="text-xs whitespace-nowrap"><b>${t.hits}</b> hits · ${t.intent || '—'}</span>
              </div>`).join('')}
          </div>
        </div>` : '<p class="text-slate-400 mt-2">Chua co cau nao duoc hoc.</p>'}
    `;
  } catch (e) {
    box.innerHTML = `<p class="text-red-500">Loi: ${e.message}</p>`;
  }
}

// ====== WEEKLY REPORT ======
async function loadWeeklyReport() {
  const box = document.getElementById('weekly-report');
  if (!box) return;
  box.textContent = 'Loading...';
  try {
    const resp = await fetch('/api/monitoring/weekly-report', { credentials: 'include' });
    const data = await resp.json();
    box.textContent = data.preview || JSON.stringify(data, null, 2);
  } catch (e) {
    box.textContent = 'Loi: ' + e.message;
  }
}

async function sendWeeklyReport() {
  if (!confirm('Gui bao cao tuan qua Telegram ngay?')) return;
  try {
    const resp = await fetch('/api/monitoring/weekly-report/send', {
      method: 'POST', credentials: 'include',
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Gui that bai');
    alert('✅ Da gui Telegram');
  } catch (e) {
    alert('❌ ' + e.message);
  }
}

// ══════ Appointments / Agent audit / Bot control / Funnel ══════
const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const _fmtTs = (ms) => ms ? new Date(Number(ms)).toLocaleString('vi-VN') : '';

async function loadAppointments() {
  const box = document.getElementById('appt-list');
  if (!box) return;
  const status = (document.getElementById('appt-status')?.value || '').trim();
  box.innerHTML = '<div class="text-slate-500 text-sm">Đang tải...</div>';
  try {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    const r = await api('/agent/appointments' + q);
    const items = r.items || [];
    if (!items.length) { box.innerHTML = '<div class="text-slate-500 text-sm">Chưa có lịch hẹn.</div>'; return; }
    box.innerHTML = `<table class="w-full text-sm border">
      <thead class="bg-slate-100"><tr>
        <th class="p-2 text-left">ID</th><th class="p-2 text-left">Khách</th>
        <th class="p-2 text-left">SĐT</th><th class="p-2 text-left">Dịch vụ</th>
        <th class="p-2 text-left">Thời gian</th><th class="p-2 text-left">Trạng thái</th>
        <th class="p-2 text-left">Hành động</th></tr></thead>
      <tbody>${items.map(a => `<tr class="border-t">
        <td class="p-2">${a.id}</td>
        <td class="p-2">${_esc(a.customer_name || a.sender_id || '')}</td>
        <td class="p-2">${_esc(a.phone || '')}</td>
        <td class="p-2">${_esc(a.service || '')}</td>
        <td class="p-2">${_fmtTs(a.scheduled_at)}</td>
        <td class="p-2"><span class="px-2 py-0.5 rounded text-xs bg-slate-200">${_esc(a.status)}</span></td>
        <td class="p-2 space-x-1">
          <button onclick="setApptStatus(${a.id},'confirmed')" class="text-xs px-2 py-1 bg-green-100 rounded">✓</button>
          <button onclick="setApptStatus(${a.id},'done')" class="text-xs px-2 py-1 bg-blue-100 rounded">Done</button>
          <button onclick="setApptStatus(${a.id},'cancelled')" class="text-xs px-2 py-1 bg-red-100 rounded">✕</button>
        </td></tr>`).join('')}</tbody></table>`;
  } catch (e) { box.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`; }
}
window.setApptStatus = async (id, status) => {
  try {
    await api(`/agent/appointments/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    loadAppointments();
  } catch (e) { alert('Lỗi: ' + e.message); }
};
document.getElementById('appt-status')?.addEventListener('change', loadAppointments);
document.getElementById('appt-refresh')?.addEventListener('click', loadAppointments);

async function loadAgentToggle() {
  try {
    const s = await api('/settings/profile').catch(() => null);
    const feat = s?.features ? (typeof s.features === 'string' ? JSON.parse(s.features) : s.features) : {};
    const cb = document.getElementById('agent-toggle');
    if (cb) cb.checked = !!feat.agent_tools;
  } catch {}
}
window.toggleAgent = async () => {
  const cb = document.getElementById('agent-toggle');
  try {
    await api('/agent/toggle', { method: 'POST', body: JSON.stringify({ enabled: cb.checked }) });
  } catch (e) { alert('Lỗi: ' + e.message); cb.checked = !cb.checked; }
};
document.getElementById('agent-toggle')?.addEventListener('change', window.toggleAgent);

async function loadAgentAudit() {
  const log = document.getElementById('agent-log');
  const stats = document.getElementById('agent-stats');
  if (!log) return;
  log.innerHTML = '<div class="text-slate-500 text-sm">Đang tải...</div>';
  try {
    const [calls, st] = await Promise.all([
      api('/agent/tool-calls?limit=50'),
      api('/agent/tool-calls/stats?days=7'),
    ]);
    if (stats) {
      const grouped = {};
      (st.stats || []).forEach(r => {
        grouped[r.tool] = grouped[r.tool] || { ok: 0, err: 0 };
        if (r.status === 'success') grouped[r.tool].ok += r.n; else grouped[r.tool].err += r.n;
      });
      const keys = Object.keys(grouped);
      stats.innerHTML = keys.length ? keys.map(k => `
        <div class="p-3 bg-white border rounded">
          <div class="text-xs text-slate-500">${_esc(k)}</div>
          <div class="text-lg font-semibold">${grouped[k].ok} <span class="text-xs text-green-600">ok</span>
          <span class="text-sm text-red-600 ml-2">${grouped[k].err} lỗi</span></div>
        </div>`).join('') : '<div class="text-slate-500 text-sm col-span-4">Chưa có dữ liệu 7 ngày qua.</div>';
    }
    const items = calls.items || [];
    log.innerHTML = items.length ? `<table class="w-full text-xs border">
      <thead class="bg-slate-100"><tr>
        <th class="p-2 text-left">Time</th><th class="p-2 text-left">Sender</th>
        <th class="p-2 text-left">Tool</th><th class="p-2 text-left">Status</th>
        <th class="p-2 text-left">Latency</th><th class="p-2 text-left">Params</th></tr></thead>
      <tbody>${items.map(c => `<tr class="border-t">
        <td class="p-2">${_fmtTs(c.created_at)}</td>
        <td class="p-2">${_esc(c.sender_id || '')}</td>
        <td class="p-2 font-mono">${_esc(c.tool)}</td>
        <td class="p-2">${c.status === 'success' ? '✅' : '❌'} ${_esc(c.status)}</td>
        <td class="p-2">${c.latency_ms || 0}ms</td>
        <td class="p-2 text-slate-600 font-mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.params || '')}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="text-slate-500 text-sm">Chưa có tool call nào.</div>';
  } catch (e) { log.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`; }
}
document.getElementById('agent-refresh')?.addEventListener('click', loadAgentAudit);

async function loadBotStatus() {
  const box = document.getElementById('bot-status');
  if (!box) return;
  box.innerHTML = 'Đang tải...';
  try {
    const r = await api('/auto-reply/pause-status');
    if (r.paused) {
      const until = r.until ? ` đến ${_fmtTs(r.until)}` : ' (vô thời hạn)';
      box.innerHTML = `<div class="p-3 bg-amber-50 border border-amber-300 rounded">
        ⏸️ Bot đang TẠM DỪNG${until}. ${r.reason ? 'Lý do: ' + _esc(r.reason) : ''}</div>`;
    } else {
      box.innerHTML = '<div class="p-3 bg-green-50 border border-green-300 rounded">✅ Bot đang HOẠT ĐỘNG.</div>';
    }
  } catch (e) { box.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`; }
}
window.pauseBot = async (minutes) => {
  let mins = minutes;
  if (minutes === 'morning') {
    const now = new Date(); const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1); tmr.setHours(8, 0, 0, 0);
    mins = Math.ceil((tmr.getTime() - now.getTime()) / 60000);
  }
  const reason = prompt('Lý do tạm dừng? (tuỳ chọn)') || '';
  try {
    await api('/auto-reply/pause', { method: 'POST', body: JSON.stringify({ minutes: mins, reason }) });
    loadBotStatus();
  } catch (e) { alert('Lỗi: ' + e.message); }
};
window.resumeBot = async () => {
  try { await api('/auto-reply/resume', { method: 'POST' }); loadBotStatus(); }
  catch (e) { alert('Lỗi: ' + e.message); }
};

async function loadFunnel() {
  const chart = document.getElementById('funnel-chart');
  const top = document.getElementById('funnel-top');
  if (!chart) return;
  const days = parseInt(document.getElementById('funnel-days')?.value || '30', 10);
  chart.innerHTML = 'Đang tải...';
  try {
    const steps = ['signup_view', 'signup_success', 'plan_selected', 'proof_submitted', 'plan_approved'];
    const q = `steps=${encodeURIComponent(steps.join(','))}&days=${days}`;
    const [f, t] = await Promise.all([
      api('/admin/funnel?' + q),
      api('/admin/events/top?days=' + days),
    ]);
    const rows = f.steps || f.funnel || [];
    const max = Math.max(1, ...rows.map(r => r.count || 0));
    chart.innerHTML = rows.map((r, i) => {
      const pct = Math.round((r.count || 0) / max * 100);
      const prev = i > 0 ? rows[i - 1].count : null;
      const drop = prev ? Math.round((1 - (r.count || 0) / prev) * 100) : null;
      return `<div class="mb-2">
        <div class="flex justify-between text-xs mb-1">
          <span class="font-mono">${_esc(r.step || r.event || r.name)}</span>
          <span>${r.count || 0}${drop !== null ? ` <span class="text-red-600">(-${drop}%)</span>` : ''}</span>
        </div>
        <div class="h-6 bg-slate-100 rounded overflow-hidden"><div class="h-full bg-indigo-500" style="width:${pct}%"></div></div>
      </div>`;
    }).join('') || '<div class="text-slate-500 text-sm">Chưa có sự kiện nào.</div>';
    if (top) {
      const items = t.top || t.items || t.events || [];
      top.innerHTML = items.length ? `<table class="w-full text-xs border">
        <thead class="bg-slate-100"><tr><th class="p-2 text-left">Event</th><th class="p-2 text-left">Count</th></tr></thead>
        <tbody>${items.map(e => `<tr class="border-t"><td class="p-2 font-mono">${_esc(e.event || e.name)}</td><td class="p-2">${e.count || e.n || 0}</td></tr>`).join('')}</tbody></table>`
        : '<div class="text-slate-500 text-sm">Không có dữ liệu.</div>';
    }
  } catch (e) { chart.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`; }
}
document.getElementById('funnel-days')?.addEventListener('change', loadFunnel);
document.getElementById('funnel-refresh')?.addEventListener('click', loadFunnel);

// ── Intent Router analytics ──
const INTENT_LABELS = {
  booking_action: '📝 Đặt phòng', booking_info: '📋 Cung cấp info',
  price_objection: '💰 Than đắt', price_q: '💵 Hỏi giá',
  location_q: '📍 Hỏi vị trí', amenity_q: '🛋️ Hỏi tiện nghi',
  policy_q: '📜 Hỏi chính sách', small_talk: '💬 Nói chuyện',
  complaint: '😤 Phàn nàn', goodbye: '👋 Tạm biệt',
  handoff_request: '🆘 Gặp NV', unclear: '❓ Không rõ',
};
async function loadIntents() {
  const days = parseInt(document.getElementById('intents-days')?.value || '7', 10);
  const kpi = document.getElementById('intents-kpis');
  const chart = document.getElementById('intents-chart');
  const handlers = document.getElementById('intents-handlers');
  const healthEl = document.getElementById('intents-health');
  if (!chart) return;
  chart.innerHTML = 'Đang tải...';
  handlers.innerHTML = '';
  try {
    const [r, h] = await Promise.all([
      api('/analytics/intents?days=' + days),
      api('/analytics/router-health'),
    ]);
    kpi.innerHTML = [
      { label: 'Tổng lượt', val: r.total, sub: `${days} ngày` },
      { label: 'Avg Confidence', val: (r.avg_confidence * 100).toFixed(0) + '%', sub: r.avg_confidence >= 0.7 ? '✅ Tốt' : '⚠️ Thấp' },
      { label: 'LLM vs Rule', val: `${r.sources?.llm || 0} / ${r.sources?.rule || 0}`, sub: 'LLM / fallback' },
      { label: 'High confidence', val: r.confidence_buckets?.high || 0, sub: `>= 75%` },
    ].map(k => `<div class="bg-white rounded-xl shadow p-4">
      <div class="text-xs text-slate-500">${k.label}</div>
      <div class="text-2xl font-bold mt-1">${k.val}</div>
      <div class="text-xs text-slate-400 mt-1">${k.sub}</div>
    </div>`).join('');

    const maxCount = Math.max(1, ...r.intents.map(i => i.count));
    chart.innerHTML = r.intents.length === 0 ? '<div class="text-slate-500 text-sm">Chưa có dữ liệu intent.</div>'
      : r.intents.map(i => {
        const label = INTENT_LABELS[i.intent] || i.intent;
        const w = Math.round(i.count / maxCount * 100);
        return `<div class="mb-2">
          <div class="flex justify-between text-xs mb-1">
            <span>${label}</span>
            <span class="font-mono">${i.count} <span class="text-slate-400">(${i.pct}%)</span></span>
          </div>
          <div class="h-5 bg-slate-100 rounded overflow-hidden"><div class="h-full bg-indigo-500" style="width:${w}%"></div></div>
        </div>`;
      }).join('');

    handlers.innerHTML = r.handlers.length === 0 ? '<div class="text-slate-500 text-sm">Chưa có dữ liệu.</div>'
      : `<table class="w-full text-sm">
        <thead><tr class="text-xs text-slate-500 border-b"><th class="text-left py-2">Handler</th><th class="text-right py-2">Lượt</th></tr></thead>
        <tbody>${r.handlers.map(x => `<tr class="border-b"><td class="py-2 font-mono">${x.handler}</td><td class="py-2 text-right font-semibold">${x.count}</td></tr>`).join('')}</tbody>
      </table>`;

    if (healthEl) {
      const st = h.status || 'no-data';
      const color = st === 'healthy' ? 'bg-green-100 text-green-700' : st === 'degraded' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500';
      healthEl.innerHTML = `<span class="px-3 py-1 rounded-full text-xs font-semibold ${color}">${st === 'healthy' ? '✅ Healthy' : st === 'degraded' ? '⚠️ Degraded' : '· No data'} (rule=${h.rule_fallback_pct}%, lowConf=${h.low_confidence_pct}%)</span>`;
    }
  } catch (e) {
    chart.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`;
  }
}
document.getElementById('intents-days')?.addEventListener('change', loadIntents);
document.getElementById('intents-refresh')?.addEventListener('click', loadIntents);

// ── Revenue & Funnel (Sprint 7) ──
const STAGE_LABELS = {
  inbox: '📥 Inbox đầu tiên',
  qualified: '🎯 Có ý định đặt',
  booking_created: '📋 Tạo báo giá',
  deposit: '💰 Chuyển cọc',
  confirmed: '✅ Xác nhận',
};
function fmtVnd(n) {
  if (!n || isNaN(n)) return '0₫';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B₫';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M₫';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K₫';
  return Math.round(n) + '₫';
}
async function loadRevenue() {
  const days = parseInt(document.getElementById('rev-days')?.value || '30', 10);
  const kpi = document.getElementById('rev-kpis');
  const funnel = document.getElementById('rev-funnel');
  const spam = document.getElementById('rev-spam');
  if (!funnel) return;
  funnel.innerHTML = 'Đang tải...';
  try {
    const [r, s] = await Promise.all([
      api('/analytics/revenue?days=' + days),
      api('/analytics/spam').catch(() => ({ items: [] })),
    ]);
    const inbox = r.stages?.find(x => x.stage === 'inbox')?.count || 0;
    const qualified = r.stages?.find(x => x.stage === 'qualified')?.count || 0;
    const confirmed = r.stages?.find(x => x.stage === 'confirmed')?.count || 0;
    const finalConv = inbox > 0 ? ((confirmed / inbox) * 100).toFixed(1) : '0';
    const qualifyRate = inbox > 0 ? ((qualified / inbox) * 100).toFixed(1) : '0';

    kpi.innerHTML = [
      { label: 'Inbox', val: inbox, sub: days + ' ngày qua' },
      { label: 'Tỉ lệ qualified', val: qualifyRate + '%', sub: `${qualified} có ý định đặt` },
      { label: 'Inbox → Đặt thành công', val: finalConv + '%', sub: `${confirmed} booking xác nhận` },
      { label: 'Doanh thu từ bot', val: fmtVnd(r.revenue?.total_booking_vnd), sub: `TB: ${fmtVnd(r.revenue?.avg_booking_vnd)}/booking` },
    ].map(k => `<div class="bg-white rounded-xl shadow p-4">
      <div class="text-xs text-slate-500">${k.label}</div>
      <div class="text-2xl font-bold mt-1">${k.val}</div>
      <div class="text-xs text-slate-400 mt-1">${k.sub}</div>
    </div>`).join('');

    const maxCount = Math.max(1, ...(r.stages || []).map(x => x.count));
    funnel.innerHTML = (r.stages || []).map((st, i) => {
      const label = STAGE_LABELS[st.stage] || st.stage;
      const w = Math.round(st.count / maxCount * 100);
      const drop = i > 0 ? `<span class="text-xs text-red-500 ml-2">−${(100 - st.conversion_pct).toFixed(0)}%</span>` : '';
      return `<div class="mb-3">
        <div class="flex justify-between text-sm mb-1">
          <span class="font-semibold">${label}</span>
          <span class="font-mono">${st.count} ${drop}</span>
        </div>
        <div class="h-7 bg-slate-100 rounded overflow-hidden relative">
          <div class="h-full bg-gradient-to-r from-indigo-500 to-green-500" style="width:${w}%"></div>
          <span class="absolute right-3 top-1 text-xs font-semibold text-slate-700">${st.total_pct}%</span>
        </div>
      </div>`;
    }).join('');

    const blocked = s.items || [];
    spam.innerHTML = blocked.length === 0
      ? '<div class="text-sm text-slate-500">Không có sender nào bị block. 👍</div>'
      : `<table class="w-full text-sm"><thead class="bg-slate-50"><tr>
          <th class="text-left p-2 text-xs">Sender</th>
          <th class="text-left p-2 text-xs">Lý do</th>
          <th class="text-left p-2 text-xs">Block lúc</th>
          <th class="p-2"></th>
        </tr></thead><tbody>${blocked.map(b => `<tr class="border-t">
          <td class="p-2 font-mono text-xs">${_esc(b.sender_id)}</td>
          <td class="p-2">${_esc(b.reason)}</td>
          <td class="p-2 text-xs text-slate-500">${_fmtTs(b.blocked_at)}</td>
          <td class="p-2"><button onclick="unblockSender('${_esc(b.sender_id)}')" class="text-xs px-2 py-1 bg-red-100 rounded">Unblock</button></td>
        </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    funnel.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`;
  }
}
window.unblockSender = async (sid) => {
  if (!confirm('Gỡ block sender ' + sid + '?')) return;
  try { await api('/analytics/spam/unblock', { method: 'POST', body: JSON.stringify({ sender_id: sid }) }); loadRevenue(); }
  catch (e) { alert('Lỗi: ' + e.message); }
};
document.getElementById('rev-days')?.addEventListener('change', loadRevenue);
document.getElementById('rev-refresh')?.addEventListener('click', loadRevenue);

// ── Knowledge Sync (v7) ──
async function loadKnowledgeSync() {
  const kpis = document.getElementById('ks-kpis');
  const runs = document.getElementById('ks-runs');
  if (!kpis) return;
  runs.innerHTML = 'Đang tải...';
  try {
    const s = await api('/admin/etl/stats?days=30');
    const agg = s.agg || {};
    const last = s.last_run;
    kpis.innerHTML = [
      { label: 'Total runs (30d)', val: agg.total_runs || 0, sub: last ? `last ${_fmtTs(last.started_at)}` : 'chưa chạy' },
      { label: 'Hotels synced', val: agg.hotels_synced || 0, sub: `Gemini ${agg.gemini_calls || 0} / fallback ${agg.fallback_calls || 0}` },
      { label: 'Failures', val: agg.failures || 0, sub: agg.failures > 0 ? '⚠️ review below' : '✅ all ok' },
      { label: 'Total time', val: Math.round((agg.total_duration_ms || 0) / 60000) + ' phút', sub: 'cho 30 ngày' },
    ].map(k => `<div class="bg-white rounded-xl shadow p-4">
      <div class="text-xs text-slate-500">${k.label}</div>
      <div class="text-2xl font-bold mt-1">${k.val}</div>
      <div class="text-xs text-slate-400 mt-1">${k.sub}</div>
    </div>`).join('');

    const recent = s.recent_runs || [];
    runs.innerHTML = recent.length === 0
      ? '<div class="text-sm text-slate-500">Chưa có run nào. Bấm "Run sync ngay" để thử.</div>'
      : `<table class="w-full text-sm"><thead class="bg-slate-50"><tr>
          <th class="p-2 text-left text-xs">Run #</th>
          <th class="p-2 text-left text-xs">Started</th>
          <th class="p-2 text-left text-xs">Status</th>
          <th class="p-2 text-left text-xs">Hotels</th>
          <th class="p-2 text-left text-xs">Providers</th>
          <th class="p-2 text-left text-xs">Duration</th>
          <th class="p-2 text-left text-xs">Trigger</th>
        </tr></thead><tbody>${recent.map(r => `<tr class="border-t">
          <td class="p-2">#${r.id}</td>
          <td class="p-2 text-xs">${_fmtTs(r.started_at)}</td>
          <td class="p-2"><span class="px-2 py-0.5 rounded text-xs ${r.status === 'completed' ? 'bg-green-100 text-green-700' : r.status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}">${r.status}</span></td>
          <td class="p-2 text-xs">${r.hotels_ok || 0}/${r.hotels_total || 0}${r.hotels_failed > 0 ? ` <span class="text-red-600">(${r.hotels_failed} fail)</span>` : ''}</td>
          <td class="p-2 text-xs">G:${r.provider_gemini || 0} / F:${r.provider_fallback || 0}</td>
          <td class="p-2 text-xs">${r.duration_ms ? Math.round(r.duration_ms / 1000) + 's' : '-'}</td>
          <td class="p-2 text-xs font-mono">${r.trigger_source || '-'}</td>
        </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    runs.innerHTML = `<div class="text-red-600 text-sm">Lỗi: ${_esc(e.message)}</div>`;
  }
}

document.getElementById('ks-refresh')?.addEventListener('click', loadKnowledgeSync);

document.getElementById('ks-run-btn')?.addEventListener('click', async () => {
  if (!confirm('Chạy ETL sync ngay? (incremental)')) return;
  const btn = document.getElementById('ks-run-btn');
  btn.disabled = true; btn.textContent = '⏳ Đang chạy...';
  try {
    const r = await api('/admin/etl/run', { method: 'POST', body: JSON.stringify({}) });
    alert(`ETL ${r.result.status}\n${r.result.hotels_ok} ok / ${r.result.hotels_failed} failed\n${Math.round(r.result.duration_ms / 1000)}s`);
    loadKnowledgeSync();
  } catch (e) { alert('Lỗi: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '▶ Run sync ngay'; }
});

document.getElementById('ks-force-btn')?.addEventListener('click', async () => {
  if (!confirm('Force re-sync TẤT CẢ hotels? (có thể mất nhiều phút)')) return;
  const btn = document.getElementById('ks-force-btn');
  btn.disabled = true; btn.textContent = '⏳ Forcing...';
  try {
    const r = await api('/admin/etl/run', { method: 'POST', body: JSON.stringify({ force: true }) });
    alert(`Force ETL ${r.result.status}\n${r.result.hotels_ok} ok / ${r.result.hotels_failed} failed`);
    loadKnowledgeSync();
  } catch (e) { alert('Lỗi: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '↻ Force re-sync all'; }
});

document.getElementById('ks-preview-btn')?.addEventListener('click', async () => {
  const hid = document.getElementById('ks-preview-id').value;
  const pre = document.getElementById('ks-preview');
  if (!hid) return;
  pre.textContent = 'Đang tải...';
  try {
    const r = await api('/admin/etl/knowledge/' + encodeURIComponent(hid));
    pre.textContent = JSON.stringify(r, null, 2);
  } catch (e) { pre.textContent = 'Lỗi: ' + e.message; }
});

// ====== Training Review ======
const trainingState = { tier: 'pending', provider: '', intent: '', offset: 0, limit: 20, total: 0 };

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatRelTime(ts) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'vừa xong';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' phút trước';
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' giờ trước';
  return Math.floor(diff / 86400_000) + ' ngày trước';
}

async function loadTraining() {
  trainingState.offset = 0;
  await Promise.all([loadTrainingStats(), loadTrainingDistinct(), loadTrainingList()]);
}

async function loadTrainingStats() {
  try {
    const s = await api('/training/stats');
    const byTier = {};
    (s.by_tier || []).forEach(r => byTier[r.tier] = r.n);
    document.getElementById('stat-pending').textContent = byTier.pending || 0;
    document.getElementById('stat-approved').textContent = byTier.approved || 0;
    document.getElementById('stat-trusted').textContent = byTier.trusted || 0;
    document.getElementById('stat-rejected').textContent = (byTier.rejected || 0) + (byTier.blacklisted || 0);
    document.getElementById('stat-hits').textContent = s.cache_hits_7d || 0;
    // Update sidebar badge
    const badge = document.getElementById('training-badge');
    if (badge) {
      const pendingCount = byTier.pending || 0;
      if (pendingCount > 0) { badge.textContent = pendingCount > 99 ? '99+' : pendingCount; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
  } catch (e) { console.warn('training stats fail:', e.message); }
}

async function loadTrainingDistinct() {
  try {
    const d = await api('/training/meta/distinct');
    const provSel = document.getElementById('training-provider');
    const intSel = document.getElementById('training-intent');
    if (provSel.options.length <= 1) {
      (d.providers || []).forEach(p => {
        const o = document.createElement('option'); o.value = p; o.textContent = p; provSel.appendChild(o);
      });
    }
    if (intSel.options.length <= 1) {
      (d.intents || []).forEach(i => {
        const o = document.createElement('option'); o.value = i; o.textContent = i; intSel.appendChild(o);
      });
    }
  } catch (e) { /* non-fatal */ }
}

async function loadTrainingList() {
  const container = document.getElementById('training-list');
  container.innerHTML = '<div class="text-slate-400 text-sm p-4">Đang tải...</div>';
  try {
    const qs = new URLSearchParams({
      tier: trainingState.tier,
      provider: trainingState.provider,
      intent: trainingState.intent,
      limit: trainingState.limit,
      offset: trainingState.offset,
    }).toString();
    const r = await api('/training/list?' + qs);
    trainingState.total = r.total;
    if (r.items.length === 0) {
      container.innerHTML = '<div class="bg-white rounded-lg shadow-sm p-8 text-center text-slate-500 border border-slate-200">Chưa có entry nào ở tier <b>' + trainingState.tier + '</b>.</div>';
    } else {
      container.innerHTML = r.items.map(renderTrainingRow).join('');
    }
    // Pager
    const info = document.getElementById('training-pager-info');
    const start = trainingState.offset + 1;
    const end = Math.min(trainingState.offset + trainingState.limit, r.total);
    info.textContent = r.total > 0 ? `Hiển thị ${start}-${end} / ${r.total} entries` : '';
    document.getElementById('training-prev').disabled = trainingState.offset <= 0;
    document.getElementById('training-next').disabled = end >= r.total;
    if (window.lucide) window.lucide.createIcons();
  } catch (e) {
    container.innerHTML = '<div class="text-rose-600 text-sm p-4">Lỗi: ' + escapeHtml(e.message) + '</div>';
  }
}

function tierBadge(tier) {
  const map = {
    pending: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Pending' },
    approved: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Approved' },
    trusted: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Trusted' },
    rejected: { bg: 'bg-rose-100', text: 'text-rose-800', label: 'Rejected' },
    blacklisted: { bg: 'bg-slate-300', text: 'text-slate-800', label: 'Blacklisted' },
  };
  const m = map[tier] || { bg: 'bg-slate-100', text: 'text-slate-700', label: tier };
  return `<span class="text-xs font-medium ${m.bg} ${m.text} px-2 py-0.5 rounded">${m.label}</span>`;
}

function renderTrainingRow(row) {
  const tags = (row.context_tags || []).map(t => `<span class="inline-block text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mr-1">${escapeHtml(t)}</span>`).join('');
  const displayedResponse = row.admin_edited_response || row.ai_response;
  const editedBadge = row.admin_edited_response ? '<span class="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded ml-1">đã sửa</span>' : '';
  const isActionable = row.tier === 'pending';
  const scoreClass = row.feedback_score > 0 ? 'text-emerald-600' : row.feedback_score < 0 ? 'text-rose-600' : 'text-slate-400';
  const feedbackSummary = (row.positive_feedback || row.negative_feedback)
    ? `<span class="text-xs ${scoreClass} font-semibold">★${row.feedback_score || 0} (<span class="text-emerald-600">+${row.positive_feedback}</span>/<span class="text-rose-600">-${row.negative_feedback}</span>)</span>`
    : '';
  return `
    <div class="bg-white rounded-lg shadow-sm p-4 border border-slate-200" data-id="${row.id}">
      <div class="flex items-start justify-between mb-2 gap-2">
        <div class="flex items-center gap-2 flex-wrap">
          ${tierBadge(row.tier)}
          <span class="text-xs text-slate-500">#${row.id}</span>
          <span class="text-xs text-slate-500">${escapeHtml(row.ai_provider || 'unknown')}</span>
          ${row.intent_category ? `<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">${escapeHtml(row.intent_category)}</span>` : ''}
          <span class="text-xs text-slate-400">hits=${row.hits_count}</span>
          ${feedbackSummary}
          <span class="text-xs text-slate-400">${formatRelTime(row.created_at)}</span>
        </div>
        <div class="flex gap-1 flex-wrap">
          ${isActionable ? `
            <button class="training-approve bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1 rounded font-medium">✓ Duyệt</button>
            <button class="training-edit bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1 rounded font-medium">✎ Sửa</button>
            <button class="training-reject bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1 rounded">✗ Từ chối</button>
            <button class="training-blacklist bg-slate-700 hover:bg-slate-800 text-white text-xs px-3 py-1 rounded">🚫 Chặn</button>
          ` : row.tier === 'approved' || row.tier === 'trusted' ? `
            <button class="training-edit bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1 rounded">✎ Sửa</button>
            <button class="training-reject bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1 rounded">Hủy</button>
          ` : ''}
          <button class="training-feedback-up bg-white border border-emerald-500 text-emerald-600 hover:bg-emerald-50 text-xs px-2 py-1 rounded" title="Đánh giá tốt">👍</button>
          <button class="training-feedback-down bg-white border border-rose-500 text-rose-600 hover:bg-rose-50 text-xs px-2 py-1 rounded" title="Đánh giá không ổn">👎</button>
          <button class="training-feedback-history bg-white border text-slate-600 hover:bg-slate-50 text-xs px-2 py-1 rounded" title="Lịch sử feedback">📊</button>
        </div>
      </div>
      <div class="mb-2">
        <div class="text-xs font-semibold text-slate-500 uppercase mb-1">Khách hỏi</div>
        <div class="text-sm text-slate-800 bg-slate-50 p-2 rounded border border-slate-200">${escapeHtml(row.customer_question)}</div>
      </div>
      <div>
        <div class="text-xs font-semibold text-slate-500 uppercase mb-1">Bot trả lời ${editedBadge}</div>
        <div class="training-response text-sm text-slate-800 bg-emerald-50 p-2 rounded border border-emerald-200 whitespace-pre-wrap">${escapeHtml(displayedResponse)}</div>
      </div>
      ${tags ? `<div class="mt-2">${tags}</div>` : ''}
      ${row.admin_notes ? `<div class="mt-2 text-xs text-slate-600 italic">Ghi chú: ${escapeHtml(row.admin_notes)}</div>` : ''}
      <div class="training-feedback-panel hidden mt-3 pt-3 border-t border-slate-200" data-feedback-for="${row.id}"></div>
    </div>`;
}

async function trainingApprove(id, editedResponse) {
  try {
    await api(`/training/${id}/approve`, { method: 'POST', body: JSON.stringify({ edited_response: editedResponse || undefined }) });
    await Promise.all([loadTrainingStats(), loadTrainingList()]);
  } catch (e) { alert('Lỗi duyệt: ' + e.message); }
}

async function trainingReject(id) {
  const reason = prompt('Lý do từ chối (bắt buộc, ≥3 ký tự):');
  if (!reason || reason.trim().length < 3) return;
  try {
    await api(`/training/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    await Promise.all([loadTrainingStats(), loadTrainingList()]);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function trainingBlacklist(id) {
  if (!confirm('Blacklist entry này? Pattern tương tự sẽ bị chặn tự động.')) return;
  const reason = prompt('Lý do blacklist (tùy chọn):') || 'spam/troll pattern';
  try {
    await api(`/training/${id}/blacklist`, { method: 'POST', body: JSON.stringify({ reason }) });
    await Promise.all([loadTrainingStats(), loadTrainingList()]);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

function trainingEdit(id, currentResponse) {
  const edited = prompt('Sửa câu trả lời (bot sẽ dùng phiên bản này khi match):', currentResponse);
  if (edited === null) return;
  if (edited.trim().length < 3) { alert('Phản hồi quá ngắn'); return; }
  trainingApprove(id, edited.trim());
}

// Phase 3: feedback helpers
const SIGNAL_LABEL = {
  positive_thanks: '🙏 Cảm ơn',
  positive_phone_given: '📞 Cho SĐT',
  positive_booking_progress: '📅 Tiếp tục đặt',
  positive_different_topic: '✅ Chuyển chủ đề',
  negative_explicit: '❌ Nói sai',
  negative_repeated_question: '🔁 Hỏi lại',
  negative_handoff_request: '🆘 Xin gặp người',
  negative_complaint: '😠 Khiếu nại',
  admin_manual: '👤 Admin',
  neutral: '• neutral',
};

async function trainingFeedbackGrade(id, sentiment) {
  const note = sentiment === 'negative' ? prompt('Ghi chú (tùy chọn):') : null;
  try {
    await api(`/training/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ sentiment, note: note || undefined }),
    });
    await loadTrainingList();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function trainingFeedbackHistory(id, panel) {
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  panel.innerHTML = '<div class="text-sm text-slate-400">Đang tải...</div>';
  panel.classList.remove('hidden');
  try {
    const r = await api(`/training/${id}/feedback`);
    if (r.items.length === 0) {
      panel.innerHTML = '<div class="text-sm text-slate-500">Chưa có feedback.</div>';
      return;
    }
    panel.innerHTML = `
      <div class="text-xs font-semibold text-slate-600 mb-2">Lịch sử feedback (${r.items.length} mục gần nhất):</div>
      <div class="space-y-1 max-h-48 overflow-y-auto">
        ${r.items.map(f => {
          const sentClass = f.sentiment === 'positive' ? 'bg-emerald-50 border-emerald-200' : f.sentiment === 'negative' ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200';
          return `<div class="${sentClass} border rounded p-2 text-xs">
            <div class="flex justify-between items-center">
              <span class="font-medium">${SIGNAL_LABEL[f.signal] || f.signal}</span>
              <span class="text-slate-500">${formatRelTime(f.created_at)}</span>
            </div>
            ${f.follow_up_message ? `<div class="mt-1 text-slate-700 italic">"${escapeHtml(f.follow_up_message)}"</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  } catch (e) {
    panel.innerHTML = '<div class="text-sm text-rose-600">Lỗi: ' + escapeHtml(e.message) + '</div>';
  }
}

// Event delegation cho list
document.getElementById('training-list')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-id]');
  if (!row) return;
  const id = parseInt(row.dataset.id, 10);
  const responseEl = row.querySelector('.training-response');
  const currentResponse = responseEl ? responseEl.textContent : '';
  const panel = row.querySelector('.training-feedback-panel');
  if (ev.target.classList.contains('training-approve')) trainingApprove(id);
  else if (ev.target.classList.contains('training-reject')) trainingReject(id);
  else if (ev.target.classList.contains('training-blacklist')) trainingBlacklist(id);
  else if (ev.target.classList.contains('training-edit')) trainingEdit(id, currentResponse);
  else if (ev.target.classList.contains('training-feedback-up')) trainingFeedbackGrade(id, 'positive');
  else if (ev.target.classList.contains('training-feedback-down')) trainingFeedbackGrade(id, 'negative');
  else if (ev.target.classList.contains('training-feedback-history') && panel) trainingFeedbackHistory(id, panel);
});

// Filter changes
document.getElementById('training-tier')?.addEventListener('change', (e) => {
  trainingState.tier = e.target.value; trainingState.offset = 0; loadTrainingList();
});
document.getElementById('training-provider')?.addEventListener('change', (e) => {
  trainingState.provider = e.target.value; trainingState.offset = 0; loadTrainingList();
});
document.getElementById('training-intent')?.addEventListener('change', (e) => {
  trainingState.intent = e.target.value; trainingState.offset = 0; loadTrainingList();
});
document.getElementById('training-refresh')?.addEventListener('click', loadTraining);
document.getElementById('training-prev')?.addEventListener('click', () => {
  trainingState.offset = Math.max(0, trainingState.offset - trainingState.limit);
  loadTrainingList();
});
document.getElementById('training-next')?.addEventListener('click', () => {
  trainingState.offset += trainingState.limit;
  loadTrainingList();
});
document.getElementById('training-promote')?.addEventListener('click', async () => {
  try {
    const r = await api('/training/promote-trusted', { method: 'POST' });
    alert(`Promoted ${r.promoted} → trusted. Demoted ${r.demoted} → pending.`);
    await loadTraining();
  } catch (e) { alert('Lỗi: ' + e.message); }
});

document.getElementById('training-seed-btn')?.addEventListener('click', async () => {
  const question = prompt('Câu hỏi của khách (VD: "Có wifi không?"):');
  if (!question || question.trim().length < 3) return;
  const response = prompt('Câu trả lời mẫu (bot sẽ dùng nguyên văn khi match):');
  if (!response || response.trim().length < 3) return;
  const intent_category = prompt('Intent category (tùy chọn, VD: amenity_q, price_q, location_q):') || 'manual_seed';
  try {
    const r = await api('/training/seed', {
      method: 'POST',
      body: JSON.stringify({ question: question.trim(), response: response.trim(), intent_category, notes: 'manual seed' }),
    });
    alert(r.is_new ? `Đã thêm Q&A #${r.qa_cache_id}` : 'Q&A này đã tồn tại (merge hits)');
    await loadTraining();
  } catch (e) { alert('Lỗi: ' + e.message); }
});

// ─── Phase 4: Cost Dashboard + Threshold Tuning ──────────────────
async function loadTrainingCost() {
  const days = parseInt(document.getElementById('training-cost-days').value || '7', 10);
  try {
    const c = await api('/training/cost-stats?days=' + days);
    document.getElementById('cost-total-tokens').textContent = (c.total_tokens_est || 0).toLocaleString();
    document.getElementById('cost-total-usd').textContent = '$' + (c.total_cost_usd_est || 0).toFixed(4);
    document.getElementById('cost-hit-rate').textContent = ((c.hit_rate || 0) * 100).toFixed(1) + '%';
    document.getElementById('cost-cache-served').textContent = (c.cache_hits_served || 0).toLocaleString();
    document.getElementById('cost-savings-usd').textContent = '$' + (c.savings_usd_est || 0).toFixed(4);

    // By provider breakdown table
    const byProv = document.getElementById('cost-by-provider');
    if ((c.by_provider || []).length === 0) {
      byProv.innerHTML = '<div class="text-slate-400">Chưa có data trong khoảng này.</div>';
    } else {
      const rows = c.by_provider.map(p => `
        <tr class="border-b border-slate-100">
          <td class="py-1 pr-3 font-mono">${escapeHtml(p.ai_provider || 'unknown')}</td>
          <td class="py-1 pr-3 text-slate-500">${escapeHtml(p.ai_model || '-')}</td>
          <td class="py-1 pr-3 text-right">${(p.calls || 0).toLocaleString()}</td>
          <td class="py-1 pr-3 text-right">${(p.tokens_out || 0).toLocaleString()}</td>
          <td class="py-1 pr-3 text-right text-slate-600">$${(p.cost_usd_est || 0).toFixed(4)}</td>
          <td class="py-1 pr-3 text-right text-emerald-600 font-medium">${(p.total_hits || 0).toLocaleString()} hits</td>
        </tr>`).join('');
      byProv.innerHTML = `<table class="w-full">
        <thead><tr class="text-slate-500"><th class="text-left font-normal py-1 pr-3">Provider</th><th class="text-left font-normal py-1 pr-3">Model</th><th class="text-right font-normal py-1 pr-3">Calls</th><th class="text-right font-normal py-1 pr-3">Out tok</th><th class="text-right font-normal py-1 pr-3">Cost</th><th class="text-right font-normal py-1 pr-3">Cache hits</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }
  } catch (e) { console.warn('cost stats fail:', e.message); }
}

async function loadConfidenceDist() {
  const days = parseInt(document.getElementById('training-cost-days').value || '7', 10);
  try {
    const d = await api('/training/confidence-dist?days=' + days);
    document.getElementById('conf-dist-samples').textContent = d.total_samples + ' samples';
    const buckets = d.buckets || {};
    const max = Math.max(1, ...Object.values(buckets));
    const chart = document.getElementById('conf-dist-chart');
    chart.innerHTML = Object.entries(buckets).map(([label, count]) => {
      const hPct = (count / max) * 100;
      const inDangerZone = label < '0.70';
      const color = inDangerZone ? 'bg-amber-400' : 'bg-emerald-500';
      return `<div class="flex-1 flex flex-col items-center gap-1" title="${label}: ${count} hits">
        <div class="${color} w-full rounded-t" style="height: ${hPct}%; min-height: 2px;"></div>
        <div class="text-[10px] text-slate-500 rotate-45 origin-top-left mt-1">${label}</div>
      </div>`;
    }).join('');
  } catch (e) { console.warn('conf dist fail:', e.message); }
}

async function loadThreshold() {
  try {
    const t = await api('/training/threshold');
    const slider = document.getElementById('threshold-slider');
    slider.value = t.threshold;
    document.getElementById('threshold-current').textContent = 'Hiện tại: ' + t.threshold.toFixed(2);
  } catch (e) { console.warn('threshold fail:', e.message); }
}

document.getElementById('threshold-slider')?.addEventListener('input', (e) => {
  document.getElementById('threshold-current').textContent = 'Sẽ đặt: ' + parseFloat(e.target.value).toFixed(2);
});

document.getElementById('threshold-save')?.addEventListener('click', async () => {
  const v = parseFloat(document.getElementById('threshold-slider').value);
  try {
    const r = await api('/training/threshold', { method: 'POST', body: JSON.stringify({ value: v }) });
    document.getElementById('threshold-current').textContent = 'Hiện tại: ' + r.threshold.toFixed(2);
    alert('Đã lưu threshold = ' + r.threshold + '. Có hiệu lực cho request tiếp theo.');
  } catch (e) { alert('Lỗi: ' + e.message); }
});

document.getElementById('training-cost-days')?.addEventListener('change', () => {
  loadTrainingCost(); loadConfidenceDist();
});

document.getElementById('training-toggle-cost')?.addEventListener('click', () => {
  const panel = document.getElementById('training-cost-panel');
  const btn = document.getElementById('training-toggle-cost');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    btn.textContent = '📊 Ẩn Cost';
    loadTrainingCost();
    loadConfidenceDist();
    loadThreshold();
  } else {
    panel.classList.add('hidden');
    btn.textContent = '📊 Cost & Tuning';
  }
});

// Auto-refresh badge mỗi 60s khi đang ở tab khác (nhắc có pending mới)
setInterval(() => { if (document.visibilityState === 'visible') loadTrainingStats().catch(() => {}); }, 60_000);

// ====== News → Post ======
const newsState = { status: 'pending', offset: 0, limit: 20, total: 0 };

async function loadNews() {
  newsState.offset = 0;
  await Promise.all([loadNewsStats(), loadNewsList()]);
}

async function loadNewsStats() {
  try {
    const s = await api('/news/stats');
    const byStatus = {};
    (s.drafts_by_status || []).forEach(r => byStatus[r.status] = r.n);
    document.getElementById('news-stat-articles24h').textContent = s.articles_24h || 0;
    document.getElementById('news-stat-pending').textContent = byStatus.pending || 0;
    document.getElementById('news-stat-approved').textContent = byStatus.approved || 0;
    document.getElementById('news-stat-published').textContent = s.published_7d || 0;
    document.getElementById('news-stat-rejected').textContent = s.auto_rejected_7d || 0;
    document.getElementById('news-stat-sources').textContent = s.sources_enabled || 0;
    const badge = document.getElementById('news-badge');
    if (badge) {
      const p = byStatus.pending || 0;
      if (p > 0) { badge.textContent = p > 99 ? '99+' : p; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
  } catch (e) { console.warn('news stats:', e.message); }
}

async function loadNewsList() {
  const container = document.getElementById('news-list');
  container.innerHTML = '<div class="text-slate-400 text-sm p-4">Đang tải...</div>';
  try {
    const qs = new URLSearchParams({
      status: newsState.status, limit: newsState.limit, offset: newsState.offset,
    }).toString();
    const r = await api('/news/list?' + qs);
    newsState.total = r.total;
    if (r.items.length === 0) {
      container.innerHTML = '<div class="bg-white rounded-lg shadow-sm p-8 text-center text-slate-500 border border-slate-200">Chưa có draft ở trạng thái <b>' + newsState.status + '</b>.</div>';
    } else {
      container.innerHTML = r.items.map(renderNewsCard).join('');
    }
    const info = document.getElementById('news-pager-info');
    const start = newsState.offset + 1;
    const end = Math.min(newsState.offset + newsState.limit, r.total);
    info.textContent = r.total > 0 ? `Hiển thị ${start}-${end} / ${r.total} drafts` : '';
    document.getElementById('news-prev').disabled = newsState.offset <= 0;
    document.getElementById('news-next').disabled = end >= r.total;
    if (window.lucide) window.lucide.createIcons();
  } catch (e) {
    container.innerHTML = '<div class="text-rose-600 text-sm p-4">Lỗi: ' + escapeHtml(e.message) + '</div>';
  }
}

function newsStatusBadge(status) {
  const m = {
    pending: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Pending' },
    approved: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Approved' },
    published: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Published' },
    rejected: { bg: 'bg-rose-100', text: 'text-rose-800', label: 'Rejected' },
  };
  const v = m[status] || { bg: 'bg-slate-100', text: 'text-slate-700', label: status };
  return `<span class="text-xs font-medium ${v.bg} ${v.text} px-2 py-0.5 rounded">${v.label}</span>`;
}

function renderNewsCard(d) {
  const actions = [];
  const message = d.edited_post || d.draft_post;

  if (d.status === 'pending') {
    actions.push(`<button class="news-approve bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1 rounded font-medium">✓ Duyệt (lên lịch)</button>`);
    actions.push(`<button class="news-publish-now bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1 rounded">▶️ Đăng ngay</button>`);
    actions.push(`<button class="news-edit bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1 rounded">✎ Sửa</button>`);
    actions.push(`<button class="news-regen bg-slate-600 hover:bg-slate-700 text-white text-xs px-3 py-1 rounded">🔁 Viết lại</button>`);
    actions.push(`<button class="news-reject bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1 rounded">✗ Từ chối</button>`);
  } else if (d.status === 'approved') {
    actions.push(`<button class="news-publish-now bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1 rounded">▶️ Đăng ngay</button>`);
    actions.push(`<button class="news-edit bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1 rounded">✎ Sửa</button>`);
    actions.push(`<button class="news-reject bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1 rounded">✗ Hủy</button>`);
  } else if (d.status === 'rejected') {
    actions.push(`<button class="news-regen bg-slate-600 hover:bg-slate-700 text-white text-xs px-3 py-1 rounded">🔁 Viết lại</button>`);
  }

  const schLabel = d.scheduled_at ? new Date(d.scheduled_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
  const pubLabel = d.published_at ? new Date(d.published_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
  const fbLink = d.fb_post_id ? `<a href="https://facebook.com/${escapeHtml(d.fb_post_id)}" target="_blank" class="text-blue-600 hover:underline text-xs">Xem FB post ↗</a>` : '';

  const safety = d.safety_flags || {};
  const safetyBadge = safety.failure_reason
    ? `<span class="text-xs bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded" title="${escapeHtml(safety.failure_reason)}">🛡️ ${escapeHtml(safety.failure_reason)}</span>`
    : (safety.tone
      ? `<span class="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">🛡️ tone=${escapeHtml(safety.tone)}${safety.fact_source ? ' + ✓ source' : ''}</span>`
      : '');

  const imagePreview = d.image_url
    ? `<img src="${escapeHtml(d.image_url)}" alt="" class="w-full max-h-48 object-cover rounded mt-2 border border-slate-200" onerror="this.style.display='none'">`
    : '';

  return `
    <div class="bg-white rounded-lg shadow-sm p-4 border border-slate-200" data-id="${d.id}">
      <div class="flex items-start justify-between mb-2 gap-2 flex-wrap">
        <div class="flex items-center gap-2 flex-wrap">
          ${newsStatusBadge(d.status)}
          <span class="text-xs text-slate-500">#${d.id}</span>
          <span class="text-xs bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">${escapeHtml(d.article_source || 'unknown')}</span>
          ${d.region ? `<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">${escapeHtml(d.region)}</span>` : ''}
          ${typeof d.impact_score === 'number' ? `<span class="text-xs text-slate-500">impact=${d.impact_score}</span>` : ''}
          ${safetyBadge}
          <span class="text-xs text-slate-400">${formatRelTime(d.created_at)}</span>
        </div>
        <div class="flex gap-1 flex-wrap">${actions.join('')}</div>
      </div>
      <div class="mb-2 text-xs text-slate-500">
        <a href="${escapeHtml(d.article_url || '#')}" target="_blank" class="hover:underline">📰 ${escapeHtml((d.article_title || '').slice(0, 120))}</a>
      </div>
      <div class="text-sm text-slate-800 bg-emerald-50 p-3 rounded border border-emerald-200 whitespace-pre-wrap news-message">${escapeHtml(message || '')}</div>
      ${imagePreview}
      ${schLabel && d.status === 'approved' ? `<div class="mt-2 text-xs text-blue-700 font-medium">📅 Đã lên lịch: ${schLabel}</div>` : ''}
      ${pubLabel && d.status === 'published' ? `<div class="mt-2 text-xs text-blue-700 font-medium">✅ Đã đăng: ${pubLabel} ${fbLink}</div>` : ''}
      ${d.rejection_reason ? `<div class="mt-2 text-xs text-rose-700 italic">Lý do từ chối: ${escapeHtml(d.rejection_reason)}</div>` : ''}
    </div>`;
}

async function newsApprove(id) {
  const custom = prompt('Giờ đăng (để trống = tự chọn khung T2/T4/T6 20h VN). Format: YYYY-MM-DD HH:MM', '');
  let scheduled_at;
  if (custom && custom.trim()) {
    const t = Date.parse(custom.trim());
    if (!isNaN(t)) scheduled_at = t;
  }
  try {
    await api(`/news/draft/${id}/approve`, { method: 'POST', body: JSON.stringify({ scheduled_at }) });
    await Promise.all([loadNewsStats(), loadNewsList()]);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function newsReject(id) {
  const reason = prompt('Lý do từ chối:');
  if (!reason) return;
  try {
    await api(`/news/draft/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    await Promise.all([loadNewsStats(), loadNewsList()]);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function newsEdit(id, currentText) {
  const edited = prompt('Sửa nội dung bài đăng:', currentText);
  if (edited === null) return;
  if (edited.trim().length < 20) { alert('Bài quá ngắn'); return; }
  try {
    await api(`/news/draft/${id}/edit`, { method: 'POST', body: JSON.stringify({ edited_post: edited.trim() }) });
    await loadNewsList();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function newsPublishNow(id) {
  if (!confirm('Đăng BÀI NÀY ngay lập tức lên fanpage?')) return;
  try {
    const r = await api(`/news/draft/${id}/publish-now`, { method: 'POST' });
    alert('Đã đăng thành công! FB post: ' + r.fb_post_id);
    await Promise.all([loadNewsStats(), loadNewsList()]);
  } catch (e) { alert('Lỗi đăng: ' + e.message); }
}

async function newsRegen(id) {
  if (!confirm('Viết lại bài này với angle mới? (draft cũ sẽ bị xóa)')) return;
  try {
    const r = await api(`/news/draft/${id}/regen`, { method: 'POST' });
    alert('Đã tạo draft mới. Status: ' + r.result?.status);
    await Promise.all([loadNewsStats(), loadNewsList()]);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

// Event delegation
document.getElementById('news-list')?.addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-id]');
  if (!row) return;
  const id = parseInt(row.dataset.id, 10);
  const msgEl = row.querySelector('.news-message');
  const currentText = msgEl ? msgEl.textContent : '';
  if (ev.target.classList.contains('news-approve')) newsApprove(id);
  else if (ev.target.classList.contains('news-reject')) newsReject(id);
  else if (ev.target.classList.contains('news-edit')) newsEdit(id, currentText);
  else if (ev.target.classList.contains('news-publish-now')) newsPublishNow(id);
  else if (ev.target.classList.contains('news-regen')) newsRegen(id);
});

// Filters
document.getElementById('news-status')?.addEventListener('change', (e) => {
  newsState.status = e.target.value; newsState.offset = 0; loadNewsList();
});
document.getElementById('news-refresh')?.addEventListener('click', loadNews);
document.getElementById('news-prev')?.addEventListener('click', () => {
  newsState.offset = Math.max(0, newsState.offset - newsState.limit); loadNewsList();
});
document.getElementById('news-next')?.addEventListener('click', () => {
  newsState.offset += newsState.limit; loadNewsList();
});

// Manual trigger buttons
document.getElementById('news-ingest-now')?.addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true; btn.textContent = '⏳ Đang fetch...';
  try { const r = await api('/news/ingest-now', { method: 'POST' });
    alert(`Ingested: ${r.new} articles mới / ${r.fetched} fetched (${r.elapsed_ms}ms).`);
    await loadNewsStats();
  } catch (err) { alert('Lỗi: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = '🔄 Ingest ngay'; }
});
document.getElementById('news-classify-now')?.addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true; btn.textContent = '⏳ Đang classify...';
  try { const r = await api('/news/classify-now', { method: 'POST', body: JSON.stringify({ limit: 20 }) });
    alert(`Classified ${r.processed}: ${r.passed} passed, ${r.political_filtered} political, ${r.keyword_filtered} no-kw.`);
    await loadNewsStats();
  } catch (err) { alert('Lỗi: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = '⚡ Classify'; }
});
document.getElementById('news-gen-drafts-now')?.addEventListener('click', async (e) => {
  const btn = e.target; btn.disabled = true; btn.textContent = '⏳ Đang viết...';
  try { const r = await api('/news/generate-drafts-now', { method: 'POST', body: JSON.stringify({ limit: 5 }) });
    alert(`Gen drafts: ${r.created} created, ${r.safety_rejected} safety-rejected, ${r.already_exists} dup.`);
    await Promise.all([loadNewsStats(), loadNewsList()]);
  } catch (err) { alert('Lỗi: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = '✍️ Gen drafts'; }
});

// Auto-refresh stats 60s
setInterval(() => { if (document.visibilityState === 'visible') loadNewsStats().catch(() => {}); }, 60_000);

// ═══════════════════════════════════════════════════════════
// Đợt 3.1: Bot Playground
// ═══════════════════════════════════════════════════════════
const pgState = { hotelId: 1, history: [] };

async function loadPlayground() {
  try {
    const r = await api('/playground/hotels');
    const sel = document.getElementById('pg-hotel');
    sel.innerHTML = r.hotels.map(h => `<option value="${h.mkt_hotel_id}">#${h.mkt_hotel_id} ${escapeHtml(h.name)} — ${escapeHtml(h.product_group || 'unknown')}</option>`).join('');
    if (r.hotels[0]) { pgState.hotelId = r.hotels[0].mkt_hotel_id; updatePgHotelInfo(r.hotels[0]); }
    sel.addEventListener('change', () => {
      const h = r.hotels.find(x => x.mkt_hotel_id == sel.value);
      pgState.hotelId = parseInt(sel.value, 10);
      if (h) updatePgHotelInfo(h);
    });
  } catch (e) { console.warn('playground hotels fail:', e.message); }
}

function updatePgHotelInfo(h) {
  const info = document.getElementById('pg-hotel-info');
  const bits = [];
  bits.push(h.brand_voice ? `🎭 ${h.brand_voice}` : '');
  bits.push(h.rooms_count ? `🛏️ ${h.rooms_count} phòng` : '');
  bits.push(h.amenities_count ? `✨ ${h.amenities_count} tiện nghi` : '');
  bits.push(h.has_policies ? '📋 có policy' : '');
  if (h.price_min_vnd) bits.push('💰 từ ' + (h.price_min_vnd/1000000).toFixed(1) + 'M');
  else if (h.monthly_price_from) bits.push('🏠 ' + (h.monthly_price_from/1000000).toFixed(1) + 'M/tháng');
  info.textContent = bits.filter(Boolean).join(' · ');
}

function pgAddMessage(role, text, meta) {
  const box = document.getElementById('pg-messages');
  const bubble = role === 'user'
    ? `<div class="flex justify-end"><div class="max-w-[75%] bg-blue-500 text-white px-3 py-2 rounded-lg"><div class="text-sm whitespace-pre-wrap">${escapeHtml(text)}</div></div></div>`
    : `<div class="flex justify-start"><div class="max-w-[75%] bg-white border border-slate-200 px-3 py-2 rounded-lg shadow-sm"><div class="text-sm text-slate-800 whitespace-pre-wrap">${escapeHtml(text)}</div>${meta ? `<div class="text-[10px] text-slate-400 mt-1">${meta}</div>` : ''}</div></div>`;
  box.insertAdjacentHTML('beforeend', bubble);
  box.scrollTop = box.scrollHeight;
}

function pgUpdateDebug(r) {
  const box = document.getElementById('pg-debug');
  const llm = r.debug?.llm_info;
  const cache = r.debug?.cache_match;
  const parts = [];
  parts.push(`<div class="bg-slate-50 p-2 rounded border"><div class="font-semibold mb-1">📊 Dispatch</div>
    <div>intent: <span class="font-mono text-blue-700">${escapeHtml(r.intent || '-')}</span></div>
    <div>tier: <span class="font-mono">${escapeHtml(r.tier || '-')}</span></div>
    <div>latency: ${r.latency_ms}ms (total ${r.total_latency_ms}ms)</div>
    ${typeof r.confidence === 'number' ? `<div>confidence: ${r.confidence.toFixed(3)}</div>` : ''}
  </div>`);
  if (llm) parts.push(`<div class="bg-emerald-50 p-2 rounded border border-emerald-200"><div class="font-semibold mb-1">🤖 LLM dùng</div>
    <div>provider: <span class="font-mono text-emerald-700">${escapeHtml(llm.provider)}</span></div>
    <div>model: <span class="font-mono text-xs">${escapeHtml(llm.model || '-')}</span></div>
    <div>tokens: in=${llm.tokens_in} out=${llm.tokens_out}</div>
    ${llm.hops ? `<div class="text-amber-700">hops=${llm.hops} (đã fallback)</div>` : ''}
  </div>`);
  if (cache) {
    const hitColor = cache.used_cached ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200';
    parts.push(`<div class="${hitColor} p-2 rounded border"><div class="font-semibold mb-1">💾 QA Cache</div>
      <div>matched: ${cache.matched ? '✓' : '✗'} — conf=${cache.confidence?.toFixed(3) || '0'}</div>
      <div>tier: <span class="font-mono">${escapeHtml(cache.tier || '-')}</span></div>
      <div>used: ${cache.used_cached ? '<span class="text-emerald-600">YES (cached served)</span>' : '<span class="text-slate-500">no (LLM called)</span>'}</div>
      ${cache.cached_question ? `<div class="mt-1 italic text-slate-600">match: "${escapeHtml(cache.cached_question.slice(0, 60))}"</div>` : ''}
    </div>`);
  }
  box.innerHTML = parts.join('');
}

async function pgSend() {
  const input = document.getElementById('pg-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  pgAddMessage('user', msg);
  pgAddMessage('bot', '⏳ đang suy nghĩ...', null);
  try {
    const r = await api('/playground/test', {
      method: 'POST',
      body: JSON.stringify({
        hotel_id: pgState.hotelId,
        message: msg,
        sender_name: document.getElementById('pg-sender-name').value || 'PlaygroundAdmin',
      }),
    });
    // Replace "đang suy nghĩ" with real reply
    const box = document.getElementById('pg-messages');
    box.lastElementChild?.remove();
    const metaStr = `${r.intent || ''} · ${r.tier || ''} · ${r.latency_ms}ms`;
    pgAddMessage('bot', r.reply || '(empty)', metaStr);
    pgUpdateDebug(r);
  } catch (e) {
    const box = document.getElementById('pg-messages');
    box.lastElementChild?.remove();
    pgAddMessage('bot', '❌ Lỗi: ' + e.message);
  }
}

document.getElementById('pg-send')?.addEventListener('click', pgSend);
document.getElementById('pg-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pgSend(); }
});
document.getElementById('pg-reset')?.addEventListener('click', async () => {
  if (!confirm('Xoá hết lịch sử playground?')) return;
  try {
    await api('/playground/reset', { method: 'POST', body: JSON.stringify({ hotel_id: pgState.hotelId }) });
    document.getElementById('pg-messages').innerHTML = '';
    document.getElementById('pg-debug').innerHTML = '<div class="text-slate-400">Đã reset. Gửi tin nhắn mới để xem debug.</div>';
  } catch (e) { alert('Lỗi reset: ' + e.message); }
});
document.querySelectorAll('.pg-quick').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('pg-input').value = btn.dataset.msg;
    pgSend();
  });
});

// ═══════════════════════════════════════════════════════════
// Đợt 3.2: Hotel Editor
// ═══════════════════════════════════════════════════════════
async function loadHotelsEditor() {
  const list = document.getElementById('hotels-list');
  list.innerHTML = '<div class="text-slate-400 text-sm p-4">Đang tải...</div>';
  try {
    const r = await api('/hotels-editor/list');
    if (!r.hotels?.length) {
      list.innerHTML = '<div class="bg-white p-6 rounded-lg border border-slate-200 text-slate-500">Chưa có khách sạn nào.</div>';
      return;
    }
    list.innerHTML = r.hotels.map(h => renderHotelRow(h)).join('');
    // Wire click to expand
    list.querySelectorAll('[data-hotel-id]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, input, select, textarea, form')) return;
        const id = parseInt(row.dataset.hotelId, 10);
        toggleHotelDetail(id, row);
      });
    });
    if (window.lucide) window.lucide.createIcons();
  } catch (e) {
    list.innerHTML = `<div class="text-rose-600 p-4">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

function renderHotelRow(h) {
  const vBadge = h.brand_voice ? `<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">${escapeHtml(h.brand_voice)}</span>` : '';
  const typeBadge = h.product_group ? `<span class="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">${escapeHtml(h.product_group)}</span>` : '';
  const priceStr = h.monthly_price_from
    ? `${(h.monthly_price_from/1000000).toFixed(1)}M - ${(h.monthly_price_to/1000000).toFixed(1)}M/tháng`
    : h.price_min_vnd ? `từ ${h.price_min_vnd.toLocaleString('vi-VN')}đ/đêm` : '-';
  return `
    <div class="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden" data-hotel-id="${h.mkt_hotel_id}">
      <div class="p-4 cursor-pointer hover:bg-slate-50">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1">
            <div class="flex items-center gap-2 flex-wrap mb-1">
              <span class="font-bold text-slate-800">#${h.mkt_hotel_id} ${escapeHtml(h.name)}</span>
              ${vBadge}${typeBadge}
            </div>
            <div class="text-xs text-slate-500">${escapeHtml(h.district || '')} ${escapeHtml(h.city || '')} · ${priceStr}</div>
            <div class="text-xs text-slate-400 mt-1">🛏️ ${h.rooms_count} phòng · ✨ ${h.amenities_count} tiện nghi · ${h.has_policies ? '📋 có policy' : '⚠ chưa có policy'}</div>
          </div>
          <div class="text-xs text-slate-400">▼ xem chi tiết</div>
        </div>
      </div>
      <div class="hotel-detail hidden border-t border-slate-200 p-4"></div>
    </div>`;
}

async function toggleHotelDetail(id, row) {
  const detail = row.querySelector('.hotel-detail');
  if (!detail.classList.contains('hidden')) {
    detail.classList.add('hidden');
    detail.innerHTML = '';
    return;
  }
  detail.innerHTML = '<div class="text-slate-400 text-sm">Đang tải chi tiết...</div>';
  detail.classList.remove('hidden');
  try {
    const r = await api(`/hotels-editor/${id}`);
    detail.innerHTML = renderHotelDetailForm(id, r);
    wireHotelDetailForm(id, detail);
  } catch (e) {
    detail.innerHTML = `<div class="text-rose-600 text-sm">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

function renderHotelDetailForm(id, data) {
  const p = data.profile;
  const rooms = data.rooms || [];
  const amenities = data.amenities || [];
  const policies = data.policies || {};
  return `
    <form class="hotel-form space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs font-semibold mb-1">Tên khách sạn</label><input name="name_canonical" value="${escapeHtml(p.name_canonical || '')}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Điện thoại</label><input name="phone" value="${escapeHtml(p.phone || '')}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Tỉnh/Thành</label><input name="city" value="${escapeHtml(p.city || '')}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Quận/Huyện</label><input name="district" value="${escapeHtml(p.district || '')}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div class="col-span-2"><label class="block text-xs font-semibold mb-1">Địa chỉ</label><input name="address" value="${escapeHtml(p.address || '')}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Brand voice</label>
          <select name="brand_voice" class="w-full border rounded px-2 py-1 text-sm">
            <option value="friendly" ${p.brand_voice === 'friendly' ? 'selected' : ''}>Friendly (thân thiện)</option>
            <option value="formal" ${p.brand_voice === 'formal' ? 'selected' : ''}>Formal (trang trọng)</option>
            <option value="luxury" ${p.brand_voice === 'luxury' ? 'selected' : ''}>Luxury (sang trọng)</option>
          </select>
        </div>
        <div><label class="block text-xs font-semibold mb-1">Product group</label>
          <select name="product_group" class="w-full border rounded px-2 py-1 text-sm">
            <option value="nightly_stay" ${p.product_group === 'nightly_stay' ? 'selected' : ''}>Nightly stay</option>
            <option value="monthly_apartment" ${p.product_group === 'monthly_apartment' ? 'selected' : ''}>Monthly apartment</option>
          </select>
        </div>
        <div class="col-span-2"><label class="block text-xs font-semibold mb-1">Tóm tắt (bot dùng khi tư vấn)</label>
          <textarea name="ai_summary_vi" rows="3" class="w-full border rounded px-2 py-1 text-sm">${escapeHtml(p.ai_summary_vi || '')}</textarea>
        </div>
        <div class="col-span-2"><label class="block text-xs font-semibold mb-1">USP (top 3, mỗi dòng 1 cái)</label>
          <textarea name="usp_top3_raw" rows="3" class="w-full border rounded px-2 py-1 text-sm">${escapeHtml((p.usp_top3 || []).join('\n'))}</textarea>
        </div>
        ${p.product_group === 'monthly_apartment' ? `
        <div><label class="block text-xs font-semibold mb-1">Giá thuê tháng TỪ (VND)</label><input name="monthly_price_from" type="number" value="${p.monthly_price_from || ''}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Giá thuê tháng ĐẾN (VND)</label><input name="monthly_price_to" type="number" value="${p.monthly_price_to || ''}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Thuê tối thiểu (tháng)</label><input name="min_stay_months" type="number" value="${p.min_stay_months || ''}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        <div><label class="block text-xs font-semibold mb-1">Cọc (tháng)</label><input name="deposit_months" type="number" value="${p.deposit_months || ''}" class="w-full border rounded px-2 py-1 text-sm"/></div>
        ` : ''}
      </div>
      <div class="flex gap-2 items-center pt-2 border-t border-slate-200">
        <button type="button" class="hotel-save bg-emerald-600 hover:bg-emerald-700 text-white text-sm px-4 py-1.5 rounded font-medium">💾 Lưu</button>
        <label class="flex items-center gap-1 text-xs text-slate-600">
          <input type="checkbox" name="manual_override" ${p.manual_override ? 'checked' : ''} class="hotel-override"/>
          Manual override (ETL không ghi đè)
        </label>
      </div>

      <div class="pt-3 border-t border-slate-200">
        <h4 class="font-semibold text-sm mb-2">🛏️ Phòng (${rooms.length})</h4>
        <div class="space-y-1 text-xs">
          ${rooms.map(r => `<div class="flex items-center gap-2 bg-slate-50 p-2 rounded">
            <span class="flex-1"><b>${escapeHtml(r.display_name_vi)}</b> — ${r.price_weekday?.toLocaleString('vi-VN') || '?'}đ · ${r.max_guests} khách${r.price_hourly ? ' · giờ ' + r.price_hourly.toLocaleString('vi-VN') + 'đ' : ''}</span>
            <button type="button" class="room-delete text-rose-600 hover:underline" data-rid="${r.id}">xoá</button>
          </div>`).join('') || '<div class="text-slate-400">Chưa có phòng nào. Add bằng form bên dưới ↓</div>'}
        </div>
        <div class="mt-2 flex gap-1 items-end text-xs">
          <input class="room-new-name border rounded px-2 py-1 flex-1" placeholder="Tên phòng..."/>
          <input class="room-new-price border rounded px-2 py-1 w-28" type="number" placeholder="Giá/đêm"/>
          <input class="room-new-guests border rounded px-2 py-1 w-16" type="number" placeholder="Khách" value="2"/>
          <button type="button" class="room-add bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded">+ Thêm</button>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-200">
        <h4 class="font-semibold text-sm mb-2">✨ Tiện nghi (${amenities.length})</h4>
        <div class="flex flex-wrap gap-1 text-xs">
          ${amenities.map(a => `<span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">${escapeHtml(a.name_vi)}${a.free ? ' 🆓' : ''} <button type="button" class="amenity-delete ml-1 text-rose-600" data-aid="${a.id}">✗</button></span>`).join('') || '<span class="text-slate-400">Chưa có.</span>'}
        </div>
        <div class="mt-2 flex gap-1 text-xs">
          <input class="amenity-new-name border rounded px-2 py-1 flex-1" placeholder="Tên tiện nghi..."/>
          <select class="amenity-new-cat border rounded px-2 py-1">
            <option value="general">General</option>
            <option value="room">Phòng</option>
            <option value="pool">Hồ bơi</option>
            <option value="gym">Gym</option>
            <option value="spa">Spa</option>
            <option value="food">F&B</option>
          </select>
          <label class="flex items-center gap-1"><input type="checkbox" class="amenity-new-free" checked/>Miễn phí</label>
          <button type="button" class="amenity-add bg-blue-600 text-white px-3 py-1 rounded">+</button>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-200">
        <h4 class="font-semibold text-sm mb-2">📋 Chính sách</h4>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <input name="pol_checkin" value="${escapeHtml(policies.checkin_time || '')}" placeholder="Check-in (14:00)" class="border rounded px-2 py-1"/>
          <input name="pol_checkout" value="${escapeHtml(policies.checkout_time || '')}" placeholder="Check-out (12:00)" class="border rounded px-2 py-1"/>
          <input name="pol_deposit" type="number" value="${policies.deposit_percent || ''}" placeholder="Cọc %" class="border rounded px-2 py-1"/>
          <label class="flex items-center gap-1"><input name="pol_pet" type="checkbox" ${policies.pet_allowed ? 'checked' : ''}/>Cho phép thú cưng</label>
          <textarea name="pol_cancel" placeholder="Chính sách huỷ..." class="border rounded px-2 py-1 col-span-2" rows="2">${escapeHtml(policies.cancellation_text || '')}</textarea>
        </div>
        <button type="button" class="pol-save mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm px-3 py-1 rounded">Lưu policies</button>
      </div>
    </form>`;
}

function wireHotelDetailForm(hotelId, root) {
  const form = root.querySelector('.hotel-form');
  // Save profile
  root.querySelector('.hotel-save')?.addEventListener('click', async () => {
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    body.usp_top3 = (body.usp_top3_raw || '').split('\n').map(s => s.trim()).filter(Boolean);
    delete body.usp_top3_raw;
    ['monthly_price_from', 'monthly_price_to', 'min_stay_months', 'deposit_months'].forEach(k => {
      if (body[k]) body[k] = parseInt(body[k], 10);
    });
    try {
      await api(`/hotels-editor/${hotelId}`, { method: 'PUT', body: JSON.stringify(body) });
      alert('✓ Đã lưu + bật manual_override');
      loadHotelsEditor();
    } catch (e) { alert('Lỗi: ' + e.message); }
  });
  // Toggle override
  root.querySelector('.hotel-override')?.addEventListener('change', async (e) => {
    try {
      await api(`/hotels-editor/${hotelId}/toggle-override`, { method: 'POST', body: JSON.stringify({ enable: e.target.checked }) });
    } catch (err) { alert('Lỗi: ' + err.message); }
  });
  // Add room
  root.querySelector('.room-add')?.addEventListener('click', async () => {
    const name = root.querySelector('.room-new-name').value.trim();
    const price = parseInt(root.querySelector('.room-new-price').value || '0', 10);
    const guests = parseInt(root.querySelector('.room-new-guests').value || '2', 10);
    if (!name) return alert('Nhập tên phòng');
    try {
      await api(`/hotels-editor/${hotelId}/room`, { method: 'POST', body: JSON.stringify({ display_name_vi: name, price_weekday: price, price_weekend: price, max_guests: guests }) });
      toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
      toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
    } catch (e) { alert('Lỗi: ' + e.message); }
  });
  // Delete room
  root.querySelectorAll('.room-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Xoá phòng này?')) return;
      try {
        await api(`/hotels-editor/${hotelId}/room/${btn.dataset.rid}`, { method: 'DELETE' });
        toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
        toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
      } catch (e) { alert('Lỗi: ' + e.message); }
    });
  });
  // Add amenity
  root.querySelector('.amenity-add')?.addEventListener('click', async () => {
    const name = root.querySelector('.amenity-new-name').value.trim();
    if (!name) return;
    const cat = root.querySelector('.amenity-new-cat').value;
    const free = root.querySelector('.amenity-new-free').checked;
    try {
      await api(`/hotels-editor/${hotelId}/amenity`, { method: 'POST', body: JSON.stringify({ name_vi: name, category: cat, free }) });
      toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
      toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
    } catch (e) { alert('Lỗi: ' + e.message); }
  });
  // Delete amenity
  root.querySelectorAll('.amenity-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/hotels-editor/${hotelId}/amenity/${btn.dataset.aid}`, { method: 'DELETE' });
        toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
        toggleHotelDetail(hotelId, root.closest('[data-hotel-id]'));
      } catch (e) { alert('Lỗi: ' + e.message); }
    });
  });
  // Save policies
  root.querySelector('.pol-save')?.addEventListener('click', async () => {
    const fd = new FormData(form);
    const body = {
      checkin_time: fd.get('pol_checkin') || null,
      checkout_time: fd.get('pol_checkout') || null,
      deposit_percent: fd.get('pol_deposit') ? parseInt(fd.get('pol_deposit'), 10) : null,
      pet_allowed: fd.get('pol_pet') === 'on',
      cancellation_text: fd.get('pol_cancel') || null,
    };
    try {
      await api(`/hotels-editor/${hotelId}/policies`, { method: 'PUT', body: JSON.stringify(body) });
      alert('✓ Đã lưu policies');
    } catch (e) { alert('Lỗi: ' + e.message); }
  });
}

// ═══════════════════════════════════════════════════════════
// Đợt 3.3: Conversations Viewer
// ═══════════════════════════════════════════════════════════
const convoState = { selected: null };

async function loadConversations() {
  const q = document.getElementById('convo-search')?.value || '';
  try {
    const r = await api('/conversations/senders' + (q ? '?q=' + encodeURIComponent(q) : ''));
    renderConvoSenders(r.senders || []);
  } catch (e) {
    document.getElementById('convo-senders').innerHTML = `<div class="p-3 text-rose-600 text-xs">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

function renderConvoSenders(senders) {
  const list = document.getElementById('convo-senders');
  if (!senders.length) {
    list.innerHTML = '<div class="p-4 text-slate-400 text-xs">Chưa có hội thoại.</div>';
    return;
  }
  list.innerHTML = senders.map(s => `
    <div class="convo-item p-2 border-b border-slate-100 cursor-pointer hover:bg-slate-50" data-sender="${escapeHtml(s.sender_id)}">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-semibold text-slate-700">${escapeHtml(s.guest_name || s.sender_id.slice(-10))}</span>
        <span class="text-[10px] text-slate-400">${formatRelTime(s.last_ts)}</span>
      </div>
      <div class="text-[11px] text-slate-500 truncate">${s.last_role === 'bot' ? '🤖 ' : '👤 '}${escapeHtml((s.last_msg || '').slice(0, 80))}</div>
      <div class="text-[10px] text-slate-400">${s.user_msgs}u / ${s.bot_msgs}b${s.phone ? ' · 📞 ' + escapeHtml(s.phone) : ''}</div>
    </div>
  `).join('');
  list.querySelectorAll('.convo-item').forEach(el => {
    el.addEventListener('click', () => {
      list.querySelectorAll('.convo-item').forEach(x => x.classList.remove('bg-blue-50'));
      el.classList.add('bg-blue-50');
      loadConvoMessages(el.dataset.sender);
    });
  });
}

async function loadConvoMessages(senderId) {
  convoState.selected = senderId;
  const header = document.getElementById('convo-header');
  const box = document.getElementById('convo-messages');
  header.textContent = 'Đang tải...';
  box.innerHTML = '';
  try {
    const r = await api('/conversations/messages/' + encodeURIComponent(senderId));
    const guest = r.guest;
    const phone = r.phone;
    header.innerHTML = `
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <b>${escapeHtml(guest?.name || senderId)}</b>
          ${phone ? `<span class="ml-2 text-emerald-700 text-xs">📞 ${escapeHtml(phone.phone || phone)}</span>` : ''}
          <span class="text-xs text-slate-400 ml-2">${r.messages?.length || 0} tin nhắn</span>
        </div>
        <div class="flex gap-1">
          <button class="convo-pause bg-amber-500 hover:bg-amber-600 text-white text-xs px-2 py-1 rounded">⏸ Pause bot</button>
        </div>
      </div>`;
    box.innerHTML = r.messages.map(m => `
      <div class="flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}">
        <div class="max-w-[75%] ${m.role === 'user' ? 'bg-white border border-slate-200' : 'bg-blue-500 text-white'} px-3 py-2 rounded-lg">
          <div class="text-sm whitespace-pre-wrap">${escapeHtml(m.message || '')}</div>
          <div class="text-[10px] ${m.role === 'user' ? 'text-slate-400' : 'text-blue-100'} mt-1">${m.intent || ''} · ${formatRelTime(m.created_at)}</div>
        </div>
      </div>
    `).join('');
    box.scrollTop = box.scrollHeight;
    header.querySelector('.convo-pause')?.addEventListener('click', async () => {
      try { await api('/conversations/' + encodeURIComponent(senderId) + '/pause', { method: 'POST' });
        alert('Bot đã pause cho sender này');
      } catch (e) { alert('Lỗi: ' + e.message); }
    });
  } catch (e) {
    header.innerHTML = `<span class="text-rose-600">Lỗi: ${escapeHtml(e.message)}</span>`;
  }
}

document.getElementById('convo-search')?.addEventListener('input', debounce(loadConversations, 300));

function debounce(fn, ms) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

// ====== Init ======
checkAuth();
