/**
 * Video Studio — standalone UI.
 * Module HOÀN TOÀN TÁCH BIỆT với chatbot/agentic main UI.
 */

const API = '/api/video-studio';
let _status = null;

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'include',
    body: opts.body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function show(tab) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab));
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'ideas') loadIdeas();
  if (tab === 'projects') loadProjects();
  if (tab === 'brand') loadBrandKit();
  if (tab === 'settings') loadSettings();
}

document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

// ═══════════════════════════════════════════════════════════
// Status + feature flag check
// ═══════════════════════════════════════════════════════════

async function checkStatus() {
  try {
    _status = await api('/status');
    const flag = document.getElementById('vs-flag');
    if (!_status.enabled) {
      flag.classList.remove('hidden');
      flag.textContent = 'OFF';
      flag.className = 'mt-2 inline-block text-[10px] bg-rose-600 text-white px-2 py-0.5 rounded';
    } else {
      flag.classList.remove('hidden');
      flag.textContent = 'ON';
      flag.className = 'mt-2 inline-block text-[10px] bg-emerald-500 text-white px-2 py-0.5 rounded';
    }
  } catch (e) {
    alert('Lỗi auth: ' + e.message + '\nVui lòng đăng nhập lại ở app chính.');
    window.location.href = '/';
  }
}

// ═══════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════

async function loadDashboard() {
  if (!_status) await checkStatus();

  const banner = document.getElementById('dash-banner');
  if (!_status?.enabled) {
    banner.innerHTML = `
      <div class="bg-amber-50 border border-amber-300 rounded-lg p-4">
        <div class="font-bold text-amber-800">⚠️ Module chưa được bật</div>
        <div class="text-sm text-amber-700 mt-1">Vào Settings tab → bật Video Studio → setup API keys để bắt đầu.</div>
      </div>
    `;
    document.getElementById('dash-summary').innerHTML = '';
    document.getElementById('dash-recent').innerHTML = '';
    return;
  }

  // Check API keys
  const keys = _status.api_keys;
  const missing = Object.entries(keys).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    banner.innerHTML = `
      <div class="bg-rose-50 border border-rose-300 rounded-lg p-4">
        <div class="font-bold text-rose-800">⚠️ Thiếu API keys</div>
        <div class="text-sm text-rose-700 mt-1">Cần setup: ${missing.join(', ')}. Vào Settings.</div>
      </div>
    `;
  } else {
    banner.innerHTML = '';
  }

  try {
    const s = await api('/dashboard/summary');
    if (!s.success) return;
    const d = s.data;

    // Status counts
    const statusMap = Object.fromEntries((d.status_counts || []).map(r => [r.status, r.n]));
    const cards = [
      { label: 'Total projects', value: (d.status_counts || []).reduce((sum, r) => sum + r.n, 0), color: 'slate' },
      { label: 'Đang review', value: (statusMap.script_review || 0) + (statusMap.voice_review || 0) + (statusMap.qc_review || 0), color: 'amber' },
      { label: 'Published', value: statusMap.published || 0, color: 'emerald' },
      { label: 'Ideas mới', value: d.unused_ideas || 0, color: 'indigo' },
    ];
    document.getElementById('dash-summary').innerHTML = cards.map(c => `
      <div class="bg-white rounded-lg border p-4">
        <div class="text-xs text-slate-500">${c.label}</div>
        <div class="text-3xl font-bold text-${c.color}-600 mt-1">${c.value}</div>
      </div>
    `).join('');

    // Recent
    const recent = d.recent_projects || [];
    document.getElementById('dash-recent').innerHTML = recent.length
      ? recent.map(p => `
        <div class="p-3 hover:bg-slate-50 flex items-center gap-3 cursor-pointer" onclick="openProject(${p.id})">
          <div class="flex-1">
            <div class="font-medium">${esc(p.title)}</div>
            <div class="text-xs text-slate-500">${new Date(p.updated_at).toLocaleString('vi-VN')}</div>
          </div>
          <span class="status-badge bg-slate-200 text-slate-700">${esc(p.status)}</span>
        </div>
      `).join('')
      : '<div class="p-6 text-center text-slate-400 text-sm">Chưa có project nào. Tạo video đầu tiên!</div>';
  } catch (e) {
    console.warn('[vs] dashboard fail:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// Ideas
// ═══════════════════════════════════════════════════════════

async function loadIdeas() {
  try {
    const r = await api('/ideas?limit=100');
    const badge = document.getElementById('ideas-badge');
    if (r.count > 0) { badge.textContent = `${r.count} mới`; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }

    const list = document.getElementById('ideas-list');
    if (r.data.length === 0) {
      list.innerHTML = '<div class="bg-white rounded-lg border p-6 text-center text-slate-400">Chưa có ideas. Bấm "AI brainstorm" hoặc "Discover" để tự động tìm.</div>';
      return;
    }

    list.innerHTML = r.data.map(i => {
      const scoreBadge = { high: 'emerald', mid: 'amber', low: 'slate' };
      const score = (i.relevance_score * 0.6 + i.trending_score * 0.4);
      const tier = score >= 0.7 ? 'high' : score >= 0.5 ? 'mid' : 'low';
      const seasonBadge = i.seasonal_tag && i.seasonal_tag !== 'evergreen' ? `<span class="status-badge bg-sky-100 text-sky-700">${esc(i.seasonal_tag)}</span>` : '';
      return `
        <div class="bg-white rounded-lg border p-3 flex items-start gap-3">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="status-badge bg-${scoreBadge[tier]}-100 text-${scoreBadge[tier]}-700">${(score * 100).toFixed(0)}%</span>
              <span class="status-badge bg-slate-100 text-slate-600">${esc(i.source_type)}</span>
              ${seasonBadge}
            </div>
            <div class="font-medium">${esc(i.topic)}</div>
            ${i.description ? `<div class="text-xs text-slate-500 mt-1">${esc(i.description)}</div>` : ''}
            ${i.target_audience ? `<div class="text-xs text-slate-400 mt-1">🎯 ${esc(i.target_audience)}</div>` : ''}
          </div>
          <div class="flex gap-1 flex-col">
            <button onclick="useIdea(${i.id}, '${esc(i.topic).replace(/'/g, "\\'")}')" class="px-2 py-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded text-xs whitespace-nowrap">🎬 Dùng</button>
            <button onclick="deleteIdea(${i.id})" class="px-2 py-1 bg-rose-100 text-rose-700 rounded text-xs">🗑</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) { console.error('[vs] ideas fail:', e); }
}

async function brainstormIdeas() {
  try {
    const btn = document.getElementById('ideas-brainstorm');
    btn.textContent = '⏳ AI đang nghĩ...';
    btn.disabled = true;
    const r = await api('/ideas/brainstorm', { method: 'POST', body: JSON.stringify({ count: 10 }) });
    btn.textContent = '🧠 AI brainstorm';
    btn.disabled = false;
    alert(`✅ Đã thêm ${r.saved} ideas mới`);
    await loadIdeas();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function discoverIdeas() {
  try {
    const btn = document.getElementById('ideas-discover');
    btn.textContent = '⏳ Đang scan RSS + Reddit...';
    btn.disabled = true;
    const r = await api('/ideas/discover', { method: 'POST' });
    btn.textContent = '🔍 Discover (RSS + Reddit)';
    btn.disabled = false;
    alert(`✅ Discovery xong!\n  RSS: ${r.rss_found}\n  Reddit: ${r.reddit_found}\n  AI: ${r.ai_generated}\n  Lưu: ${r.saved}\n  Skip trùng: ${r.skipped_duplicates}`);
    await loadIdeas();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function addManualIdea() {
  const topic = prompt('Topic:');
  if (!topic) return;
  const desc = prompt('Mô tả (optional):') || '';
  try {
    await api('/ideas', { method: 'POST', body: JSON.stringify({ topic, description: desc }) });
    await loadIdeas();
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function deleteIdea(id) {
  if (!confirm('Xoá idea này?')) return;
  await api('/ideas/' + id, { method: 'DELETE' });
  await loadIdeas();
}

async function useIdea(id, topic) {
  document.getElementById('create-topic').value = topic;
  window._pickedIdeaId = id;
  show('create');
  alert('Đã chọn idea. Chỉnh config + bấm Tạo project.');
}

document.getElementById('ideas-brainstorm').addEventListener('click', brainstormIdeas);
document.getElementById('ideas-discover').addEventListener('click', discoverIdeas);
document.getElementById('ideas-add-manual').addEventListener('click', addManualIdea);

// ═══════════════════════════════════════════════════════════
// Create project
// ═══════════════════════════════════════════════════════════

document.getElementById('create-submit').addEventListener('click', async () => {
  try {
    const topic = document.getElementById('create-topic').value.trim();
    if (!topic) return alert('Nhập topic');

    const btn = document.getElementById('create-submit');
    btn.disabled = true; btn.textContent = '⏳ Creating...';

    const payload = {
      topic,
      target_duration_sec: Number(document.getElementById('create-duration').value),
      tier: document.getElementById('create-tier').value,
      style: document.getElementById('create-style').value,
      audience: document.getElementById('create-audience').value || undefined,
      idea_id: window._pickedIdeaId,
    };

    const createR = await api('/projects', { method: 'POST', body: JSON.stringify(payload) });
    if (!createR.success) { alert('Lỗi: ' + createR.error); btn.disabled = false; btn.textContent = '🎬 Tạo project + generate script'; return; }

    btn.textContent = '⏳ Generating script...';

    const scriptR = await api(`/projects/${createR.id}/generate-script`, { method: 'POST', body: JSON.stringify({}) });

    btn.disabled = false;
    btn.textContent = '🎬 Tạo project + generate script';

    if (scriptR.success) {
      alert(`✅ Project #${createR.id} created + script generated (${scriptR.scenes?.length || 0} scenes). Chuyển sang tab Projects để review.`);
      window._pickedIdeaId = undefined;
      document.getElementById('create-topic').value = '';
      document.getElementById('create-audience').value = '';
      openProject(createR.id);
    } else {
      alert('Project created nhưng script gen fail: ' + (scriptR.error || 'unknown') + '\nXem project detail để retry.');
      openProject(createR.id);
    }
  } catch (e) {
    alert('Lỗi: ' + e.message);
    document.getElementById('create-submit').disabled = false;
    document.getElementById('create-submit').textContent = '🎬 Tạo project + generate script';
  }
});

document.getElementById('create-pick-idea').addEventListener('click', () => show('ideas'));

// ═══════════════════════════════════════════════════════════
// Projects
// ═══════════════════════════════════════════════════════════

async function loadProjects() {
  try {
    const filter = document.getElementById('projects-filter-status').value;
    const path = filter ? `/projects?status=${filter}` : '/projects';
    const r = await api(path);

    document.getElementById('projects-list').innerHTML = r.data.length === 0
      ? '<div class="bg-white rounded-lg border p-6 text-center text-slate-400">Chưa có project. Bấm "Tạo video mới".</div>'
      : r.data.map(p => `
        <div class="bg-white rounded-lg border p-3 hover:bg-slate-50 cursor-pointer" onclick="openProject(${p.id})">
          <div class="flex items-center gap-2 mb-1">
            <span class="status-badge bg-slate-200 text-slate-700">${esc(p.status)}</span>
            <span class="text-xs text-slate-500">#${p.id}</span>
            <span class="text-xs text-slate-500">${p.target_duration_sec}s</span>
            <span class="text-xs text-slate-500">${esc(p.tier)}</span>
          </div>
          <div class="font-medium">${esc(p.title)}</div>
          <div class="text-xs text-slate-400 mt-1">${new Date(p.updated_at).toLocaleString('vi-VN')}</div>
        </div>
      `).join('');
  } catch (e) { console.error('[vs] projects fail:', e); }
}

document.getElementById('projects-refresh').addEventListener('click', loadProjects);
document.getElementById('projects-filter-status').addEventListener('change', loadProjects);
document.getElementById('back-to-projects').addEventListener('click', () => show('projects'));

async function openProject(id) {
  try {
    show('project-detail');
    const content = document.getElementById('project-detail-content');
    content.innerHTML = '<div class="text-slate-400">⏳ Loading...</div>';

    const r = await api('/projects/' + id);
    if (!r.success) { content.innerHTML = `<div class="text-rose-600">Lỗi: ${esc(r.error)}</div>`; return; }

    const p = r.data;
    const script = p.script;

    let html = `
      <div class="mb-4">
        <div class="flex items-center gap-2">
          <span class="status-badge bg-slate-200 text-slate-700">${esc(p.status)}</span>
          <span class="text-xs text-slate-500">#${p.id} · ${p.target_duration_sec}s · ${esc(p.tier)}</span>
          <span class="text-xs text-slate-500">Cost: $${((p.cost_cents || 0) / 100).toFixed(2)}</span>
        </div>
        <h2 class="text-2xl font-bold mt-1">${esc(p.title)}</h2>
        <div class="text-sm text-slate-600">Topic: ${esc(p.topic)}</div>
      </div>
    `;

    // Status-specific actions
    if (p.status === 'draft') {
      html += `<div class="mb-4 p-3 bg-amber-50 rounded border border-amber-200">
        <div class="text-sm">Script chưa generate. <button onclick="retryScript(${p.id})" class="text-indigo-600 hover:underline">Tạo script</button></div>
      </div>`;
    }

    if (p.status === 'script_review' && script) {
      html += `<div class="mb-4 p-3 bg-indigo-50 rounded border border-indigo-300">
        <div class="font-semibold text-indigo-800 mb-2">🛑 Gate 1: Review script</div>
        <div class="text-sm text-slate-700">Review các scenes dưới đây. Bấm Approve để tiếp tục sang fetch visuals.</div>
        <div class="mt-2 flex gap-2">
          <button onclick="approveScript(${p.id})" class="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded text-sm font-medium">✅ Approve script → Fetch visuals</button>
          <button onclick="retryScript(${p.id})" class="px-3 py-1.5 bg-slate-200 rounded text-sm">🔄 Re-generate</button>
        </div>
      </div>`;
    }

    if (p.status === 'visuals') {
      html += `<div class="mb-4 p-3 bg-sky-50 rounded border border-sky-300">
        <div class="font-semibold text-sky-800 mb-2">🎨 Fetching visuals...</div>
        <button onclick="fetchVisuals(${p.id})" class="px-3 py-1.5 bg-sky-500 hover:bg-sky-600 text-white rounded text-sm font-medium">🔍 Fetch stock clips</button>
      </div>`;
    }

    if (p.status === 'voice_review') {
      html += `<div class="mb-4 p-3 bg-emerald-50 rounded border border-emerald-300">
        <div class="font-semibold text-emerald-800 mb-2">✅ Visuals ready</div>
        <div class="text-sm text-slate-700">V1.5 sẽ có voice + composition. V1 hiện tại stop ở đây để test visual quality.</div>
      </div>`;
    }

    // Hook + CTA
    if (script) {
      html += `
        <div class="mb-4 bg-white rounded-lg border p-4">
          <h3 class="font-bold mb-2">📝 Script Overview</h3>
          <div class="text-sm mb-3"><strong>Hook:</strong> ${esc(script.hook_question)}</div>
          <div class="text-sm mb-3"><strong>CTA:</strong> ${esc(script.cta_text)}</div>
          <div class="text-sm"><strong>Caption:</strong> ${esc(script.caption_social || p.caption_text)}</div>
          ${script.hashtags?.length ? `<div class="text-xs text-slate-500 mt-2">${script.hashtags.map(h => esc(h)).join(' ')}</div>` : ''}
        </div>
      `;
    }

    // Scenes
    html += '<h3 class="font-bold mb-2">🎬 Scenes</h3><div class="space-y-2">';
    for (const s of p.scenes || []) {
      const kindColor = { hook: 'indigo', main: 'slate', cta: 'emerald' };
      const statusColor = { ready: 'emerald', failed: 'rose', pending: 'amber', generating: 'sky' };
      html += `
        <div class="bg-white rounded-lg border p-3">
          <div class="flex items-center gap-2 mb-1">
            <span class="status-badge bg-${kindColor[s.kind]}-100 text-${kindColor[s.kind]}-700">${esc(s.kind)} #${s.scene_index}</span>
            <span class="status-badge bg-${statusColor[s.status] || 'slate'}-100 text-${statusColor[s.status] || 'slate'}-700">${esc(s.status)}</span>
            <span class="text-xs text-slate-500">${s.duration_sec}s</span>
            ${s.visual_provider ? `<span class="text-xs text-slate-500">· ${esc(s.visual_provider)}</span>` : ''}
          </div>
          <div class="text-sm"><strong>Text:</strong> ${esc(s.text)}</div>
          <div class="text-xs text-slate-500 mt-1"><strong>Visual:</strong> ${esc(s.visual_prompt)}</div>
          ${s.visual_url ? `
            <details class="mt-2">
              <summary class="cursor-pointer text-xs text-indigo-600">Xem clip</summary>
              <video src="${esc(s.visual_url)}" controls class="mt-2 max-w-xs rounded"></video>
            </details>
          ` : ''}
        </div>
      `;
    }
    html += '</div>';

    html += `<div class="mt-4 flex gap-2">
      <button onclick="deleteProject(${p.id})" class="px-3 py-1.5 bg-rose-100 text-rose-700 rounded text-sm">🗑 Xoá project</button>
    </div>`;

    content.innerHTML = html;
  } catch (e) {
    document.getElementById('project-detail-content').innerHTML = `<div class="text-rose-600">Lỗi: ${esc(e.message)}</div>`;
  }
}

async function retryScript(id) {
  if (!confirm('Re-generate script? Kịch bản cũ sẽ bị overwrite.')) return;
  try {
    await api(`/projects/${id}/generate-script`, { method: 'POST', body: JSON.stringify({}) });
    await openProject(id);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function approveScript(id) {
  try {
    await api(`/projects/${id}/approve-script`, { method: 'POST', body: JSON.stringify({}) });
    await openProject(id);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function fetchVisuals(id) {
  try {
    const btn = event.target;
    btn.disabled = true; btn.textContent = '⏳ Fetching...';
    const r = await api(`/projects/${id}/generate-visuals`, { method: 'POST' });
    alert(`Fetched: ${r.fetched}, Failed: ${r.failed}`);
    await openProject(id);
  } catch (e) { alert('Lỗi: ' + e.message); }
}

async function deleteProject(id) {
  if (!confirm('Xoá project này?')) return;
  try {
    await api(`/projects/${id}`, { method: 'DELETE' });
    show('projects');
  } catch (e) { alert('Lỗi: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════
// Brand Kit
// ═══════════════════════════════════════════════════════════

async function loadBrandKit() {
  try {
    const r = await api('/brand-kits/default');
    if (!r.success) return;
    const k = r.data;
    document.getElementById('brand-kit-content').innerHTML = `
      <div class="bg-white rounded-lg border p-5 space-y-3">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="font-bold">${esc(k.name)}</h3>
          <span class="status-badge bg-emerald-100 text-emerald-700">DEFAULT</span>
        </div>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div><div class="text-slate-500 text-xs">Logo position</div><div>${esc(k.logo_position)}</div></div>
          <div><div class="text-slate-500 text-xs">Aspect ratio</div><div>${esc(k.aspect_ratio)} (${esc(k.resolution)})</div></div>
          <div><div class="text-slate-500 text-xs">Primary color</div><div><span class="inline-block w-4 h-4 rounded mr-1" style="background:${esc(k.primary_color)}"></span>${esc(k.primary_color)}</div></div>
          <div><div class="text-slate-500 text-xs">Secondary color</div><div><span class="inline-block w-4 h-4 rounded mr-1" style="background:${esc(k.secondary_color)}"></span>${esc(k.secondary_color)}</div></div>
          <div><div class="text-slate-500 text-xs">Subtitle font</div><div>${esc(k.subtitle_font)}</div></div>
          <div><div class="text-slate-500 text-xs">Subtitle style</div><div>${esc(k.subtitle_style)}</div></div>
          <div><div class="text-slate-500 text-xs">Music mood</div><div>${esc(k.music_mood)}</div></div>
          <div><div class="text-slate-500 text-xs">LUT file</div><div class="text-xs">${esc(k.color_lut_file || '—')}</div></div>
        </div>
        <div class="border-t pt-3 text-xs text-slate-500">
          Default brand kit được auto-generate khi enable module lần đầu.
          V1 chưa có UI edit — sẽ bổ sung V2. Admin có thể edit trực tiếp via API PUT /api/video-studio/brand-kits/${k.id}.
        </div>
      </div>
    `;
  } catch (e) {
    document.getElementById('brand-kit-content').innerHTML = `<div class="text-rose-600">Lỗi: ${esc(e.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════

async function loadSettings() {
  await checkStatus();
  document.getElementById('settings-enabled').checked = _status?.enabled || false;
}

document.getElementById('settings-enabled').addEventListener('change', async (e) => {
  try {
    await api('/toggle', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
    await checkStatus();
  } catch (err) { alert('Lỗi: ' + err.message); e.target.checked = !e.target.checked; }
});

document.getElementById('settings-save').addEventListener('click', async () => {
  try {
    const payload = {
      pexels_api_key: document.getElementById('settings-pexels').value || undefined,
      pixabay_api_key: document.getElementById('settings-pixabay').value || undefined,
      elevenlabs_api_key: document.getElementById('settings-elevenlabs').value || undefined,
      elevenlabs_voice_id: document.getElementById('settings-elevenlabs-voice').value || undefined,
    };
    // Only send fields filled
    const filtered = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    await api('/settings', { method: 'POST', body: JSON.stringify(filtered) });
    alert('✅ Đã lưu');
    await checkStatus();
  } catch (e) { alert('Lỗi: ' + e.message); }
});

// ═══════════════════════════════════════════════════════════
// Logout
// ═══════════════════════════════════════════════════════════
document.getElementById('vs-logout').addEventListener('click', () => {
  document.cookie = 'auth=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  window.location.href = '/';
});

// ═══════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════
(async () => {
  await checkStatus();
  show('dashboard');
  if (typeof lucide !== 'undefined') lucide.createIcons();
})();
