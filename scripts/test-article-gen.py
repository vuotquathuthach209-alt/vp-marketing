"""Test SEO article generator: trigger generate on VPS, dump result."""
import paramiko, sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

SCRIPT = r"""
cat > /tmp/test-article.js <<'EOF'
(async () => {
  const { generateArticle, saveArticle, getArticle } = require('/opt/vp-marketing/dist/services/seo/article-writer');
  const { db } = require('/opt/vp-marketing/dist/db');

  console.log('=== Test SEO article writer: keyword="khách sạn Q1 Sài Gòn giá dưới 500k" ===');
  console.log('');
  console.log('--- generateArticle (Claude Sonnet 4.6, ~30-60s) ---');
  const t0 = Date.now();
  const draft = await generateArticle({
    keyword_target: 'khách sạn Q1 Sài Gòn giá dưới 500k',
    angle: 'destination_guide',
    language: 'vi',
    target_word_count: 1800,
  });
  const t1 = Date.now();

  if (!draft) {
    console.log('ERROR: generateArticle returned null');
    process.exit(1);
  }

  console.log('OK in ' + ((t1-t0)/1000).toFixed(1) + 's');
  console.log('');
  console.log('Title:        ' + draft.title);
  console.log('Slug:         ' + draft.slug);
  console.log('Meta:         ' + (draft.meta_description||'').slice(0,160));
  console.log('H1:           ' + (draft.h1||''));
  console.log('Word count:   ' + draft.word_count);
  console.log('FAQ count:    ' + (draft.faq?.length||0));
  console.log('Related kw:   ' + (draft.related_keywords||[]).join(', '));
  console.log('Int. links:   ' + (draft.internal_links||[]).length);
  console.log('Img sugg:     ' + (draft.image_suggestions||[]).length);
  console.log('');
  console.log('--- body preview (first 800 chars of markdown) ---');
  console.log((draft.body_md||'').slice(0, 800));
  console.log('');

  // Save
  const id = saveArticle(draft, { angle: 'destination_guide' });
  console.log('Saved article #' + id);

  // Verify retrieve
  const a = getArticle(id);
  console.log('');
  console.log('After save & retrieve:');
  console.log('  status:        ' + a.status);
  console.log('  has body_html: ' + (!!a.body_html));
  console.log('  has article_schema: ' + (!!a.article_schema));
  console.log('  has faq_schema:     ' + (!!a.faq_schema));

  // First Q from JSON-LD FAQ schema
  if (a.faq_schema && a.faq_schema.mainEntity?.[0]) {
    console.log('  faq[0].question:    ' + a.faq_schema.mainEntity[0].name);
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.message, e?.stack); process.exit(1); });
EOF
cd /opt/vp-marketing && node /tmp/test-article.js
"""

def run():
    cl = paramiko.SSHClient()
    cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST}...", flush=True)
    cl.connect(HOST, port=22, username=USER, password=PASS, timeout=30, banner_timeout=60)
    stdin, stdout, stderr = cl.exec_command(SCRIPT, timeout=180)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out: print(out.rstrip(), flush=True)
    if err: print("STDERR:", err.rstrip(), file=sys.stderr, flush=True)
    cl.close()

if __name__ == "__main__":
    run()
