/**
 * Publish Log dashboard + API — xem MỌI bài đăng across kênh ở 1 chỗ.
 * Mounted behind authMiddleware tại /api/publish-log + /admin/publish-log.
 */

import { Router } from 'express';
import { getPublishLog, getPublishStats } from '../services/publish-log';

const router = Router();

router.get('/data', (req, res) => {
  const items = getPublishLog({
    channel: (req.query.channel as string) || undefined,
    status: (req.query.status as string) || undefined,
    source_type: (req.query.source as string) || undefined,
    since: req.query.days ? Date.now() - parseInt(String(req.query.days), 10) * 86400_000 : undefined,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 150,
  });
  res.json({ items });
});

router.get('/stats', (req, res) => {
  res.json(getPublishStats(req.query.days ? parseInt(String(req.query.days), 10) : 30));
});

router.get('/dashboard', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Publish Log — Sonder</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f3ec;color:#1a1a1a;padding:20px}
  h1{font-size:22px;margin-bottom:4px}
  .meta{color:#888;font-size:13px;margin-bottom:18px}
  .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:#fff;border:1px solid #e0d8c0;border-radius:8px;padding:14px}
  .stat .num{font-size:24px;font-weight:700}
  .stat .lbl{font-size:12px;color:#666;margin-top:4px}
  .stat.s-ok .num{color:#2e7d32}.stat.s-fail .num{color:#c62828}.stat.s-block .num{color:#e65100}
  .filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
  select,button{padding:7px 12px;border:1px solid #ccc;border-radius:6px;font-size:14px;background:#fff;cursor:pointer}
  button.primary{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;font-size:13px}
  th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #eee}
  th{background:#efe9d8;font-weight:600}
  .badge{display:inline-block;padding:2px 9px;border-radius:12px;font-size:11px;font-weight:600}
  .b-success{background:#e8f5e9;color:#2e7d32}.b-failed{background:#ffebee;color:#c62828}
  .b-blocked{background:#fff3e0;color:#e65100}.b-pending{background:#e3f2fd;color:#1565c0}
  .ch{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#eef;color:#33c}
  .channel-bars{margin:16px 0}
  .cbar{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}
  .cbar .name{width:90px;font-weight:600}
  .cbar .track{flex:1;height:20px;background:#eee;border-radius:10px;overflow:hidden;display:flex}
  .cbar .ok{background:#66bb6a;height:100%}.cbar .fl{background:#ef5350;height:100%}.cbar .bl{background:#ffa726;height:100%}
  td.err{color:#c62828;font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  a{color:#1d4ed8}
</style></head><body>
<h1>📋 Publish Log — Tổng hợp bài đăng mọi kênh</h1>
<div class="meta" id="meta">Đang tải…</div>
<div class="stats" id="stats"></div>
<div class="channel-bars" id="cbars"></div>
<div class="filters">
  <select id="fCh"><option value="">— Mọi kênh —</option><option>facebook</option><option>instagram</option><option>zalo</option><option>web_blog</option><option>telegram</option></select>
  <select id="fSt"><option value="">— Mọi status —</option><option>success</option><option>failed</option><option>blocked</option><option>pending</option></select>
  <select id="fSrc"><option value="">— Mọi nguồn —</option><option>v5t</option><option>seo_article</option><option>cross_post</option><option>manual</option><option>news_draft</option><option>product_auto_post</option></select>
  <select id="fDay"><option value="7">7 ngày</option><option value="30" selected>30 ngày</option><option value="90">90 ngày</option><option value="3650">Tất cả</option></select>
  <button class="primary" onclick="load()">🔄 Lọc</button>
</div>
<table><thead><tr><th>Thời gian</th><th>Kênh</th><th>Nguồn</th><th>Tiêu đề</th><th>Status</th><th>Link / Lỗi</th></tr></thead>
<tbody id="rows"><tr><td colspan="6">Đang tải…</td></tr></tbody></table>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmt(ts){if(!ts)return '—';const d=new Date(ts);return d.toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
async function load(){
  const ch=document.getElementById('fCh').value,st=document.getElementById('fSt').value,
        src=document.getElementById('fSrc').value,day=document.getElementById('fDay').value;
  const st2=await fetch('/api/publish-log/stats?days='+day).then(r=>r.json());
  let tot=0,ok=0,fl=0,bl=0;
  for(const c of st2.byChannel){tot+=c.total;ok+=c.success;fl+=c.failed;bl+=c.blocked}
  document.getElementById('meta').textContent='Tổng '+st2.total+' bản ghi · '+day+' ngày gần nhất · cập nhật '+new Date().toLocaleString('vi-VN');
  document.getElementById('stats').innerHTML=
    '<div class="stat"><div class="num">'+tot+'</div><div class="lbl">Tổng lượt đăng</div></div>'+
    '<div class="stat s-ok"><div class="num">'+ok+'</div><div class="lbl">✅ Thành công</div></div>'+
    '<div class="stat s-fail"><div class="num">'+fl+'</div><div class="lbl">🔴 Thất bại</div></div>'+
    '<div class="stat s-block"><div class="num">'+bl+'</div><div class="lbl">🛡️ Bị chặn</div></div>'+
    '<div class="stat"><div class="num">'+(tot?Math.round(ok/tot*100):0)+'%</div><div class="lbl">Success rate</div></div>';
  let cb='<strong style="font-size:14px">Theo kênh:</strong>';
  for(const c of st2.byChannel){
    const t=c.total||1;
    cb+='<div class="cbar"><div class="name">'+esc(c.channel)+'</div><div class="track">'+
      '<div class="ok" style="width:'+(c.success/t*100)+'%"></div>'+
      '<div class="fl" style="width:'+(c.failed/t*100)+'%"></div>'+
      '<div class="bl" style="width:'+(c.blocked/t*100)+'%"></div></div>'+
      '<div style="width:140px;color:#666">'+c.success+'✅ '+c.failed+'🔴 '+c.blocked+'🛡️ /'+c.total+'</div></div>';
  }
  document.getElementById('cbars').innerHTML=cb;
  const q=new URLSearchParams();if(ch)q.set('channel',ch);if(st)q.set('status',st);if(src)q.set('source',src);q.set('days',day);q.set('limit','200');
  const d=await fetch('/api/publish-log/data?'+q).then(r=>r.json());
  if(!d.items.length){document.getElementById('rows').innerHTML='<tr><td colspan="6" style="text-align:center;color:#888;padding:30px">Không có bản ghi</td></tr>';return}
  document.getElementById('rows').innerHTML=d.items.map(function(r){
    const link=r.external_url?'<a href="'+esc(r.external_url)+'" target="_blank">mở ↗</a>':(r.error_message?'<span class="err" title="'+esc(r.error_message)+'">'+esc(r.error_message)+'</span>':'—');
    return '<tr><td>'+fmt(r.attempted_at)+'</td>'+
      '<td><span class="ch">'+esc(r.channel)+'</span></td>'+
      '<td>'+esc(r.source_type)+(r.source_id?' #'+esc(r.source_id):'')+'</td>'+
      '<td>'+esc((r.title||'').slice(0,70))+'</td>'+
      '<td><span class="badge b-'+esc(r.status)+'">'+esc(r.status)+'</span></td>'+
      '<td>'+link+'</td></tr>';
  }).join('');
}
load();
</script></body></html>`);
});

export default router;
