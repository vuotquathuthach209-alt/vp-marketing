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
  const aCount = s.anthropic?.count || 0;
  const fCount = s.fal?.count || 0;
  const aEl = document.getElementById('anthropic-count');
  const fEl = document.getElementById('fal-count');
  if (aEl) aEl.textContent = aCount > 0
    ? `(đang có ${aCount} key: ${s.anthropic.masked.replace(/\n/g, ', ')})`
    : '(chưa có key)';
  if (fEl) fEl.textContent = fCount > 0
    ? `(đang có ${fCount} key: ${s.fal.masked.replace(/\n/g, ', ')})`
    : '(chưa có key)';
  document.getElementById('key-anthropic').value = '';
  document.getElementById('key-fal').value = '';
  loadPagesInSettings();
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
    fal_api_key: document.getElementById('key-fal').value,
  };
  try {
    const r = await api('/settings/keys', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('keys-status').textContent =
      `✅ Đã lưu (${r.anthropic_count || 0} Anthropic key, ${r.fal_count || 0} fal.ai key)`;
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

// ====== Init ======
checkAuth();
