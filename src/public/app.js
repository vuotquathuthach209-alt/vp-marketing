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
async function checkAuth() {
  const r = await api('/auth/me');
  if (r.authenticated) showApp();
  else showLogin();
}

function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  loadPages();
  switchTab('compose');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    showApp();
  } catch (err) {
    const errEl = document.getElementById('login-error');
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
  if (tab === 'posts') loadPosts();
  if (tab === 'media') loadMedia();
  if (tab === 'settings') loadSettings();
  if (tab === 'campaigns') loadCampaigns();
  if (tab === 'autoreply') loadAutoReply();
  if (tab === 'wiki') loadWiki();
  if (tab === 'analytics') loadAnalytics();
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
async function loadAutopilotStatus() {
  try {
    const r = await api('/autopilot/status');
    const badge = document.getElementById('autopilot-status-badge');
    badge.innerHTML = r.enabled
      ? '<span class="text-green-600">🟢 ĐANG CHẠY</span>'
      : '<span class="text-slate-500">⚪ TẮT</span>';
    const info = document.getElementById('autopilot-info');
    info.innerHTML = `
      <div>📋 Pillar hôm nay: <b>${r.currentPillar.emoji} ${r.currentPillar.name}</b> — ${r.currentPillar.description}</div>
      <div>⏰ Giờ đăng: <b>${r.postTimes.join(', ')}</b></div>
      <div>📝 Số bài/ngày: <b>${r.postsPerDay}</b></div>
    `;
  } catch {}
}
loadAutopilotStatus();

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
  pre.textContent = '⏳ Đang chạy autopilot (nghiên cứu → viết caption → tạo ảnh)...';
  try {
    const pageId = state.pages?.[0]?.id;
    if (!pageId) { pre.textContent = '❌ Chưa có Fanpage nào. Thêm Fanpage trước.'; return; }
    const r = await api('/autopilot/run-now', { method: 'POST', body: JSON.stringify({ pageId }) });
    pre.textContent = `✅ Đã tạo post #${r.postId}\n📝 Chủ đề: ${r.topic}\n🖼️ Ảnh: ${r.mediaId ? 'Có (ID ' + r.mediaId + ')' : 'Không'}\n⏰ Lên lịch: ${new Date(r.scheduledAt).toLocaleString('vi-VN')}\n\n${r.caption}`;
  } catch (e) {
    pre.textContent = '❌ Lỗi: ' + e.message;
  }
});
document.getElementById('btn-autopilot-morning')?.addEventListener('click', async () => {
  const pre = document.getElementById('autopilot-report');
  pre.classList.remove('hidden');
  pre.textContent = '⏳ Đang nghiên cứu chủ đề...';
  try {
    const r = await api('/autopilot/morning-report');
    pre.textContent = r.report;
  } catch (e) {
    pre.textContent = '❌ ' + e.message;
  }
});
document.getElementById('btn-autopilot-evening')?.addEventListener('click', async () => {
  const pre = document.getElementById('autopilot-report');
  pre.classList.remove('hidden');
  pre.textContent = '⏳ Đang tổng hợp...';
  try {
    const r = await api('/autopilot/evening-report');
    pre.textContent = r.report;
  } catch (e) {
    pre.textContent = '❌ ' + e.message;
  }
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

// ====== Init ======
checkAuth();
