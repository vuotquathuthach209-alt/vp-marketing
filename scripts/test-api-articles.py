"""Verify SEO article API: list + get + copy package."""
import paramiko, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
HOST = "103.82.193.74"; USER = "root"; PASS = "cCxEvKZ0J3Ee6NJG"

# Use auth bypass via local app — node script calls list/get directly
SCRIPT = r"""
cat > /tmp/test-list.js <<'EOF'
const { db } = require('/opt/vp-marketing/dist/db');
const { listArticles, getArticle } = require('/opt/vp-marketing/dist/services/seo/article-writer');

console.log('=== Articles list ===');
const list = listArticles({ limit: 10 });
console.log('Total: ' + list.length);
for (const a of list) {
  console.log('  #' + a.id + ' | ' + a.status + ' | ' + a.word_count + 'w | "' + a.title.slice(0,55) + '" | kw="' + (a.keyword_target||'').slice(0,40) + '"');
}

if (list.length > 0) {
  const a = getArticle(list[0].id);
  console.log('');
  console.log('=== Article #' + a.id + ' detail ===');
  console.log('Title:        ' + a.title);
  console.log('Slug:         ' + a.slug);
  console.log('Meta:         ' + (a.meta_description||'').slice(0,140));
  console.log('Word count:   ' + a.word_count);
  console.log('Status:       ' + a.status);
  console.log('Body MD len:  ' + (a.body_md||'').length + ' chars');
  console.log('Body HTML len:' + (a.body_html||'').length + ' chars');
  console.log('FAQ items:    ' + (a.faq||[]).length);
  console.log('Related kw:   ' + (a.related_keywords||[]).length);
  console.log('Internal links: ' + (a.internal_links||[]).length);
  console.log('Image sugg:   ' + (a.image_suggestions||[]).length);
  console.log('');
  console.log('=== Article schema (snippet) ===');
  console.log('  @type: ' + a.article_schema?.['@type']);
  console.log('  headline: ' + a.article_schema?.headline);
  console.log('  url: ' + a.article_schema?.url);
  console.log('  wordCount: ' + a.article_schema?.wordCount);
  console.log('  inLanguage: ' + a.article_schema?.inLanguage);
  console.log('');
  console.log('=== FAQ schema ===');
  console.log('  @type: ' + a.faq_schema?.['@type']);
  console.log('  Q count: ' + (a.faq_schema?.mainEntity||[]).length);
  for (const q of (a.faq_schema?.mainEntity||[])) {
    console.log('    Q: ' + q.name);
    console.log('    A: ' + (q.acceptedAnswer?.text||'').slice(0,80) + '...');
  }
  console.log('');
  console.log('=== Full body MD (first 1500 chars) ===');
  console.log((a.body_md||'').slice(0, 1500));
  console.log('...');
}
process.exit(0);
EOF
cd /opt/vp-marketing && node /tmp/test-list.js
"""

cl = paramiko.SSHClient()
cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cl.connect(HOST, 22, USER, PASS, timeout=30, banner_timeout=60)
_, o, e = cl.exec_command(SCRIPT, timeout=60)
print(o.read().decode("utf-8", errors="replace").rstrip())
err = e.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err, file=sys.stderr)
cl.close()
