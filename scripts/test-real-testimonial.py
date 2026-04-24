"""Test Day 1: seed demo reviews + generate testimonial post với review thật."""
import sys, paramiko
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except: pass
HOST = "103.82.193.74"
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else ""

CMD = r"""
cd /opt/vp-marketing
cat > tmp.js <<'JS'
process.chdir('/opt/vp-marketing');
const Database = require('better-sqlite3');
const db = new Database('data/db.sqlite');

(async () => {
  // 1. Seed 3 demo reviews
  console.log('=== 1. Seed demo reviews ===');
  const { upsertReview, pickTestimonialReview, getReviewStats, maskReviewerName } = require('/opt/vp-marketing/dist/services/product-auto-post/review-sync');
  const now = Date.now();
  const demos = [
    {
      review_ota_id: 'demo_' + now + '_1',
      hotel_id: 6, reviewer_name: 'Nguyễn Văn An',
      rating: 5.0, review_text: 'Phòng sạch sẽ, vị trí cực kỳ tiện gần sân bay, nhân viên lễ tân thân thiện, check-in nhanh. Wifi mạnh, bếp đầy đủ để nấu ăn. Sẽ quay lại lần sau.',
      stay_date: '2026-03-15', stay_duration_nights: 5, verified: true,
    },
    {
      review_ota_id: 'demo_' + now + '_2',
      hotel_id: 6, reviewer_name: 'Trần Thị Bình',
      rating: 4.5, review_text: 'Căn hộ rộng rãi, bếp + máy giặt đầy đủ, tiết kiệm tiền ăn ngoài. Giá thuê tháng hợp lý so với khu vực Tân Bình. Hotline hỗ trợ nhanh khi cần.',
      stay_date: '2026-02-20', stay_duration_nights: 30, verified: true,
    },
    {
      review_ota_id: 'demo_' + now + '_3',
      hotel_id: 6, reviewer_name: 'Lê Minh C',
      rating: 4.7, review_text: 'Ở đây 3 tháng cho đợt công tác, cực kỳ hài lòng. Khu vực yên tĩnh, đủ tiện nghi sống lâu dài. Điện nước bao trọn nên không lo phát sinh.',
      stay_date: '2026-01-10', stay_duration_nights: 90, verified: true,
    },
  ];
  for (const d of demos) {
    const outcome = upsertReview(d);
    console.log('  ' + d.reviewer_name + ' (' + d.rating + '⭐) → ' + outcome);
  }

  // 2. Check masking
  console.log('\n=== 2. Privacy masking ===');
  console.log('"Nguyễn Văn An" →', maskReviewerName('Nguyễn Văn An'));
  console.log('"Anna Smith" →', maskReviewerName('Anna Smith'));
  console.log('"Lê Minh C" →', maskReviewerName('Lê Minh C'));

  // 3. Pick testimonial
  console.log('\n=== 3. Pick testimonial review for hotel #6 ===');
  const picked = pickTestimonialReview(6);
  console.log(JSON.stringify(picked, null, 2));

  // 4. Stats
  console.log('\n=== 4. Review stats ===');
  const stats = getReviewStats();
  console.log(JSON.stringify(stats, null, 2));

  // 5. Force generate testimonial angle + test caption
  console.log('\n=== 5. Generate testimonial-angle caption với REAL review ===');
  // Bypass picker, call caption generator directly
  const { generateCaption } = require('/opt/vp-marketing/dist/services/product-auto-post/caption-generator');
  const hotelMock = {
    hotel_id: 6,
    name: 'Sonder Airport',
    property_type: 'apartment',
    district: 'Tân Bình',
    rating: 4.7,
    review_count: 3,
    verified: true,
    image_count: 9,
    monthly_price_from: 3600000,
    min_nightly_price: 1250000,
    usp_top3: ['Gần sân bay', 'Bếp đầy đủ', 'Điện nước bao trọn'],
    last_posted_days_ago: 30,
    score: 80,
    score_breakdown: {},
  };
  const reviewCtx = 'REAL_REVIEW: rating=' + picked.rating.toFixed(1) + ', name="' + picked.masked_name + '", stay="' + (picked.stay_month_year || 'gần đây') + '", verified=' + picked.verified + ', text="' + picked.text + '"';
  const gen = await generateCaption(hotelMock, 'testimonial', { imageContext: reviewCtx });

  if (gen) {
    console.log('\nCaption generated (' + gen.caption.length + ' chars, ' + gen.provider + '):');
    console.log('---');
    console.log(gen.caption);
    console.log('---');

    // Check if caption contains real review text (even a few words of it)
    const reviewWords = picked.text.split(/\s+/).filter(w => w.length > 4);
    const matchedWords = reviewWords.filter(w => gen.caption.toLowerCase().includes(w.toLowerCase()));
    console.log('\nMatched review words:', matchedWords.length, '/', reviewWords.length);
    console.log('(Caption nhắc đến khách "' + picked.masked_name + '"?)', gen.caption.includes(picked.masked_name));
  }

  db.close();
})();
JS
node tmp.js
rm tmp.js
"""

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username="root", password=PASSWORD, timeout=15)
_, out, _ = c.exec_command(CMD, timeout=180)
print(out.read().decode('utf-8'))
c.close()
