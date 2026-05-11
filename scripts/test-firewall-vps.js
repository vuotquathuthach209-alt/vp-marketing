const { checkBeforePublish } = require('/opt/vp-marketing/dist/services/copyright/firewall');

(async () => {
  console.log('--- Test 1: spammy caption (should BLOCK)');
  const r1 = await checkBeforePublish({
    source: 'manual',
    source_id: 'test-spam-1',
    caption: 'KHÁCH SẠN SIÊU RẺ NHẤT VN!!! Đặt ngay 0942883133. Tag bạn vào đây để nhận giảm 50%! Bit.ly/abc123',
  });
  console.log('blocked=' + r1.blocked + ' decision=' + r1.decision);
  console.log('reasons: ' + r1.reasons.join(' | '));
  console.log('caption_issues: ' + (r1.caption_issues || []).join(' | '));

  console.log('');
  console.log('--- Test 2: bit.ly only (should BLOCK on URL shortener)');
  const r2 = await checkBeforePublish({
    source: 'manual',
    source_id: 'test-spam-2',
    caption: 'Sài Gòn sáng sớm. Chi tiết: bit.ly/sondervn',
  });
  console.log('blocked=' + r2.blocked + ' decision=' + r2.decision);
  console.log('reasons: ' + r2.reasons.join(' | '));

  console.log('');
  console.log('--- Test 3: clean caption (should ALLOW)');
  const r3 = await checkBeforePublish({
    source: 'manual',
    source_id: 'test-clean',
    caption: 'Sài Gòn buổi sớm. Ly cà phê đen đá pha vội ở quán cũ trên đường Hai Bà Trưng. Một ngày mới bắt đầu chậm rãi và bình yên.',
  });
  console.log('blocked=' + r3.blocked + ' decision=' + r3.decision);
  console.log('reasons: ' + r3.reasons.join(' | '));

  process.exit(0);
})();
