"""Full end-to-end test: deploy + force analyzer + check Gemini proposals."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
set -e
cd /opt/vp-marketing
git pull origin main 2>&1 | tail -2
npx tsc 2>&1 | tail -3
pm2 restart vp-mkt --update-env 2>&1 | tail -2
sleep 4

cat > /opt/vp-marketing/_tmp_full.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  // Insert mock stuck convos
  console.log('=== Inserting mock evidence ===');
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:test_mock_%'`).run();
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:test_mock_%'`).run();

  const scenarios = [
    {
      id: 'fb:test_mock_pet_1',
      stage: 'AREA_ASK',
      msgs: [
        ['user', 'em có cho chó cưng vào phòng không'],
        ['bot', 'Dạ cho em xin ngày check-in + số khách ạ'],
        ['user', 'tôi hỏi về chó mà bạn'],
        ['bot', 'Dạ để em check phòng, anh/chị muốn khu nào'],
        ['user', 'thôi khỏi'],
      ],
    },
    {
      id: 'fb:test_mock_pet_2',
      stage: 'AREA_ASK',
      msgs: [
        ['user', 'có cho thú cưng vào không'],
        ['bot', 'Dạ anh/chị cho em budget + số đêm ạ'],
        ['user', 'con mèo nhà em 5kg'],
        ['bot', 'Dạ anh/chị khu vực nào'],
      ],
    },
    {
      id: 'fb:test_mock_refund_1',
      stage: 'DATES_ASK',
      msgs: [
        ['user', 'nếu không đi được thì có hoàn tiền không'],
        ['bot', 'Dạ cho em ngày check-in'],
        ['user', 'tôi hỏi refund'],
        ['bot', 'Dạ em check phòng trống giúp anh/chị'],
      ],
    },
  ];

  for (const sc of scenarios) {
    db.prepare(`INSERT INTO bot_conversation_state (sender_id, hotel_id, stage, slots, same_stage_count, created_at, updated_at)
                VALUES (?, 1, ?, '{}', 3, ?, ?)`).run(sc.id, sc.stage, Date.now(), Date.now());
    for (const [role, msg] of sc.msgs) {
      db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, ?, ?, ?)`)
        .run(sc.id, role, msg, Date.now());
    }
  }
  console.log(`Inserted ${scenarios.length} mock stuck conversations`);

  // Run analyzer
  console.log('\n=== Running template suggestion analyzer ===');
  const { runTemplateSuggestionAnalysis } = require('/opt/vp-marketing/dist/services/agentic/template-suggester');
  const r = await runTemplateSuggestionAnalysis();
  console.log(`Evidence stats: ${JSON.stringify(r.evidence_stats)}`);
  console.log(`Suggestions proposed: ${r.suggestions?.length || 0}`);
  console.log(`Saved to DB: ${r.suggestions_created || 0}`);
  if (r.error) console.log(`Error: ${r.error}`);

  if (r.suggestions?.length > 0) {
    console.log('\n=== AI Proposals ===');
    for (const s of r.suggestions) {
      console.log(`\n[${s.category}] ${s.suggested_id} (conf: ${s.confidence})`);
      console.log(`  📝 ${s.description}`);
      console.log(`  💡 ${s.reasoning}`);
      console.log(`  Content preview: ${s.content.substring(0, 150)}...`);
      console.log(`  Trigger: ${JSON.stringify(s.trigger_conditions)}`);
    }
  }

  // List pending
  const pending = db.prepare(`SELECT id, suggested_id, category, analysis_source, status FROM agentic_template_suggestions ORDER BY created_at DESC LIMIT 10`).all();
  console.log(`\n=== All suggestions in DB (${pending.length}) ===`);
  for (const p of pending) console.log(`  [${p.id}] ${p.suggested_id} (${p.category}, ${p.status}, from ${p.analysis_source})`);

  // Cleanup mock
  console.log('\n=== Cleanup ===');
  db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:test_mock_%'`).run();
  db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:test_mock_%'`).run();
  console.log('Mock data cleaned. Suggestions kept for admin demo.');

  db.close();
  console.log('\n✅ End-to-end test complete');
})();
JS

node /opt/vp-marketing/_tmp_full.js
rm /opt/vp-marketing/_tmp_full.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=300)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()
