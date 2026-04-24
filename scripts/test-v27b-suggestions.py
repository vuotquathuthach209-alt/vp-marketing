"""Test v27B suggestions API end-to-end on VPS."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing

cat > /opt/vp-marketing/_tmp_test_suggestions.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  console.log('=== Check agentic_template_suggestions table ===');
  const info = db.prepare(`PRAGMA table_info(agentic_template_suggestions)`).all();
  console.log(`Columns: ${info.length} — ${info.map(c => c.name).join(', ')}`);

  console.log('\n=== Gather evidence (local) ===');
  const { gatherStuckConversations, gatherHandoffConversations, gatherUnderperformingTemplates, gatherUnmatchedPatterns } =
    require('/opt/vp-marketing/dist/services/agentic/template-suggester');

  const stuck = gatherStuckConversations(30);
  const handoff = gatherHandoffConversations(30);
  const underperf = gatherUnderperformingTemplates();
  const unmatched = gatherUnmatchedPatterns(50);

  console.log(`  stuck: ${stuck.length}`);
  console.log(`  handoff: ${handoff.length}`);
  console.log(`  underperforming: ${underperf.length}`);
  console.log(`  unmatched: ${unmatched.length}`);

  if (stuck.length + handoff.length + unmatched.length === 0) {
    console.log('\n⚠️  No real evidence yet (DB fresh). Inserting MOCK evidence for test...');

    // Insert mock stuck conversations
    const mockSender = 'fb:test_stuck_' + Date.now();
    db.prepare(`INSERT OR REPLACE INTO bot_conversation_state (sender_id, current_stage, same_stage_count, updated_at)
                VALUES (?, 'AREA_ASK', 3, ?)`).run(mockSender, Date.now());
    const msgs = [
      ['user', 'em có cho thú cưng vào phòng không ạ con chó nhà em 40kg'],
      ['bot', 'Dạ em tư vấn đặt phòng ngắn ngày ạ! Anh/chị cho em xin: ngày check-in, số đêm, số khách...'],
      ['user', 'tôi hỏi về chó cưng mà bạn'],
      ['bot', 'Dạ để em check phòng trống, anh/chị cho em ngày check-in + số khách ạ'],
      ['user', 'thôi khỏi'],
    ];
    for (const [role, msg] of msgs) {
      db.prepare(`INSERT INTO conversation_memory (sender_id, page_id, role, message, created_at) VALUES (?, 0, ?, ?, ?)`)
        .run(mockSender, role, msg, Date.now());
    }
    console.log('Inserted 1 mock stuck convo (pet question → bot ignored)');

    const stuck2 = gatherStuckConversations(30);
    console.log(`After mock: stuck=${stuck2.length}`);

    console.log('\n=== Test proposeTemplatesFromEvidence via Gemini ===');
    const { proposeTemplatesFromEvidence, saveSuggestion } = require('/opt/vp-marketing/dist/services/agentic/template-suggester');
    const mockUnmatched = [
      'cho chó cưng 40kg vào phòng được không',
      'có refund không nếu covid',
      'khách sạn có hồ bơi không',
      'cho thú cưng vào không',
      'chính sách hoàn tiền như thế nào',
    ];
    const proposals = await proposeTemplatesFromEvidence(stuck2, [], [], mockUnmatched);
    console.log(`Gemini proposed: ${proposals.length}`);
    for (const p of proposals) {
      console.log(`  - [${p.category}] ${p.suggested_id} (conf=${p.confidence})`);
      console.log(`    📝 ${p.description}`);
      console.log(`    💡 ${p.reasoning}`);
      console.log(`    Content: ${p.content.substring(0, 100)}...`);
    }

    // Save proposals
    if (proposals.length > 0) {
      console.log('\n=== Save proposals ===');
      for (const p of proposals) {
        const id = saveSuggestion(p, 'pattern_repeat', { source_stats: { stuck: stuck2.length, unmatched: mockUnmatched.length }, reasoning: p.reasoning });
        console.log(`  saved id=${id} for ${p.suggested_id}`);
      }
    }

    // List pending
    console.log('\n=== List pending suggestions ===');
    const { listPendingSuggestions, approveSuggestion, rejectSuggestion } = require('/opt/vp-marketing/dist/services/agentic/template-suggester');
    const pending = listPendingSuggestions(100);
    console.log(`Pending: ${pending.length}`);
    for (const p of pending) {
      console.log(`  [${p.id}] ${p.suggested_id} (${p.status})`);
    }

    // Test approve first one
    if (pending.length > 0) {
      console.log('\n=== Test approve first suggestion ===');
      const r = approveSuggestion(pending[0].id, 'test@admin', {});
      console.log(`  result: ${JSON.stringify(r)}`);

      // Verify template was created
      const created = db.prepare(`SELECT id, category, active FROM agentic_templates WHERE id = ?`).get(r.template_id);
      console.log(`  template in DB: ${JSON.stringify(created)}`);
    }

    // Test reject second
    if (pending.length > 1) {
      console.log('\n=== Test reject second suggestion ===');
      const r = rejectSuggestion(pending[1].id, 'test@admin', 'test rejection');
      console.log(`  result: ${JSON.stringify(r)}`);
    }

    // Cleanup mock data
    console.log('\n=== Cleanup ===');
    db.prepare(`DELETE FROM conversation_memory WHERE sender_id LIKE 'fb:test_stuck_%'`).run();
    db.prepare(`DELETE FROM bot_conversation_state WHERE sender_id LIKE 'fb:test_stuck_%'`).run();
    // Keep suggestions + templates để admin thấy demo (có thể delete manual sau)
  }

  db.close();
  console.log('\n✅ Test complete');
})();
JS

node /opt/vp-marketing/_tmp_test_suggestions.js
rm /opt/vp-marketing/_tmp_test_suggestions.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=20)
_, out, err = c.exec_command(CMD, timeout=180)
print(out.read().decode('utf-8', errors='replace'))
e = err.read().decode('utf-8', errors='replace')
if e.strip(): print('--STDERR--'); print(e)
c.close()
