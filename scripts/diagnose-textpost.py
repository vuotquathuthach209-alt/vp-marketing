"""Diagnose text/image post effectiveness."""
import sys, paramiko

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass

HOST = "103.82.193.74"; USER = "root"; PASSWORD = "cCxEvKZ0J3Ee6NJG"

NODE = """
const Database = require('better-sqlite3');
const axios = require('axios');
const db = new Database('/opt/vp-marketing/data/db.sqlite', { readonly: true });
const page = db.prepare("SELECT * FROM pages WHERE id = 1").get();

(async () => {
  console.log('═══ FB Graph API: published posts last 30 ═══');
  try {
    const r = await axios.get(`https://graph.facebook.com/v21.0/${page.fb_page_id}/published_posts`, {
      params: {
        access_token: page.access_token,
        fields: 'id,created_time,message,attachments{media_type},reactions.summary(total_count),comments.summary(total_count),shares',
        limit: 30,
      },
      timeout: 30000,
    });
    const posts = r.data.data || [];

    let imgN=0, vidN=0, txtN=0;
    let imgEng=0, vidEng=0, txtEng=0;
    let imgZero=0, vidZero=0;

    for (const p of posts) {
      const mt = p.attachments?.data?.[0]?.media_type || 'text';
      const re = p.reactions?.summary?.total_count || 0;
      const cm = p.comments?.summary?.total_count || 0;
      const sh = p.shares?.count || 0;
      const eng = re + cm + sh;
      const isZero = re === 0 && cm === 0 && sh === 0;

      if (mt === 'photo' || mt === 'album') {
        imgN++; imgEng += eng; if (isZero) imgZero++;
      } else if (mt === 'video') {
        vidN++; vidEng += eng;
      } else {
        txtN++; txtEng += eng;
      }
    }

    console.log(`Photo/album: ${imgN} posts, total engagement: ${imgEng}, zero-engage: ${imgZero}/${imgN} (${(imgZero/imgN*100).toFixed(0)}%)`);
    console.log(`Video: ${vidN} posts, total engagement: ${vidEng}`);
    console.log(`Text: ${txtN} posts, total engagement: ${txtEng}`);
    console.log();
    console.log(`Avg engagement IMAGE/post: ${imgN ? (imgEng/imgN).toFixed(2) : 'N/A'}`);
    console.log(`Avg engagement VIDEO/post: ${vidN ? (vidEng/vidN).toFixed(2) : 'N/A'}`);
    console.log();

    console.log('═══ Top 5 IMAGE posts by engagement ═══');
    const imgPosts = posts
      .filter(p => (p.attachments?.data?.[0]?.media_type === 'photo' || p.attachments?.data?.[0]?.media_type === 'album'))
      .map(p => ({
        msg: (p.message || '').slice(0, 70),
        eng: (p.reactions?.summary?.total_count||0) + (p.comments?.summary?.total_count||0) + (p.shares?.count||0),
        time: p.created_time?.slice(0, 16),
      }))
      .sort((a,b) => b.eng - a.eng)
      .slice(0, 5);
    for (const p of imgPosts) {
      console.log(`  [${p.time}] eng=${p.eng} | "${p.msg}"`);
    }
  } catch (e) {
    console.log('FB Graph err:', e.message);
  }

  console.log();
  console.log('═══ DB: auto_post_history ═══');
  const histRows = db.prepare("SELECT id, scheduled_date, status, hotel_id FROM auto_post_history ORDER BY id DESC LIMIT 10").all();
  for (const h of histRows) console.log(`  #${h.id} ${h.scheduled_date} hotel=${h.hotel_id} status=${h.status}`);

  console.log();
  console.log('═══ DB: posts table latest 10 image ═══');
  const dbPosts = db.prepare("SELECT id, status, substr(caption,1,80) as cap, datetime(published_at/1000,'unixepoch','+7 hours') as pub FROM posts WHERE media_type='image' ORDER BY id DESC LIMIT 10").all();
  for (const p of dbPosts) console.log(`  #${p.id} ${p.status} ${p.pub} "${p.cap}"`);

  db.close();
})();
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PASSWORD, timeout=15, look_for_keys=False, allow_agent=False)
sftp = c.open_sftp()
with sftp.open('/tmp/diag-textpost.js', 'w') as f:
    f.write(NODE)
sftp.close()
_, o, _ = c.exec_command('cd /opt/vp-marketing && node /tmp/diag-textpost.js 2>&1', timeout=120)
print(o.read().decode('utf-8', errors='replace'))
c.close()
