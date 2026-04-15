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
  loadPagesInSettings();
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

// ====== Init ======
checkAuth();
