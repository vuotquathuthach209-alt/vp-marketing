/**
 * Anthology seed data — characters + locations + values + logos + initial arcs.
 *
 * Idempotent: skip if already seeded. Force re-seed via parameter.
 *
 * Reference skill: sonder-storytelling
 */

import { db } from '../../db';

// ═══════════════════════════════════════════════════════════
// CHARACTERS — 6 initial pool
// ═══════════════════════════════════════════════════════════

const CHARACTERS = [
  {
    slug: 'linh',
    name: 'Linh',
    age: 28,
    gender: 'female',
    role: 'main_protagonist',
    backstory: 'Linh, 28 tuổi, vừa rời Đà Nẵng sau 4 năm làm việc về Sài Gòn để bắt đầu lại. Tính cách: trầm lặng, quan sát kỹ, nhạy cảm. Hay viết nhật ký, thích những khoảnh khắc nhỏ.',
    visual_prompt: 'Young Vietnamese woman 28 with long straight black hair side-parted, gentle features, contemplative quiet expression. Wearing oversized white linen shirt, beige cotton pants, casual minimalist style. Often holds a small notebook and a glass of warm water.',
    signature_props: JSON.stringify(['small notebook', 'glass of warm water', 'canvas tote bag', 'simple silver bracelet']),
    voice_style: 'intimate',
    voice_id_override: 'a3AkyqGG4v8Pg7SWQ0Y3', // Ngân (default)
  },
  {
    slug: 'tuan',
    name: 'Tuấn',
    age: 54,
    gender: 'male',
    role: 'staff_anchor',
    backstory: 'Chú Tuấn 54 tuổi, lễ tân Sonder Airport 8 năm. Trước làm khách sạn 5 sao, bỏ vì "khách sáo quá". Sống ở Tân Bình từ 1985. Vợ làm cô giáo, 2 con đã lớn. Pha trà giỏi, hay quan sát khách.',
    visual_prompt: 'Vietnamese middle-aged man 54, salt-and-pepper hair neatly combed, warm crinkled eyes, gentle smile. Wearing simple navy uniform shirt with small Sonder logo embroidered chest pocket. Often holding a clay tea pot.',
    signature_props: JSON.stringify(['clay tea pot', 'name tag Tuan with Sonder logo', 'reading glasses on chain', 'small notebook for guest preferences']),
    voice_style: 'warm_elder',
    voice_id_override: null, // Future: clone giọng đàn ông trung niên
  },
  {
    slug: 'vy',
    name: 'Vy',
    age: 32,
    gender: 'female',
    role: 'external_observer',
    backstory: 'Chị Vy 32 tuổi, đã ly hôn, có 1 con gái 6 tuổi. Mở cafe "Vy" đối diện Sonder Q1 từ 2019. Pha cafe sữa đá ngon nhất khu. Khách Sonder ghé đều, chị nhớ mặt từng người.',
    visual_prompt: 'Vietnamese woman 32, shoulder-length wavy hair, warm smile, apron over linen shirt, simple gold earrings. Behind cafe counter with manual coffee filter (phin) and condensed milk cans visible.',
    signature_props: JSON.stringify(['phin coffee filter', 'apron with stains', 'daughter drawing on wall', 'soft jazz playing']),
    voice_style: 'warm',
    voice_id_override: null,
  },
  {
    slug: 'khanh',
    name: 'Khanh',
    age: 35,
    gender: 'male',
    role: 'returning_guest',
    backstory: 'Anh Khanh 35 tuổi, người Hàn Quốc, business trip Sài Gòn mỗi quý từ tháng 3/2025. Lần đầu ở khách sạn 5 sao Bùi Viện cảm thấy lạnh, lần 2 thử Sonder Airport, từ đó luôn quay lại. Nói tiếng Việt accent Hàn nhẹ.',
    visual_prompt: 'Korean man 35, short black hair clean cut, business casual navy blazer over white t-shirt, leather briefcase, slim build. Polite gentle face, slight reserved smile.',
    signature_props: JSON.stringify(['leather briefcase', 'phone with translation app', 'Sonder room key as souvenir']),
    voice_style: 'korean_accent_vn',
    voice_id_override: null, // Future: clone giọng Hàn nói VN
  },
  {
    slug: 'ha',
    name: 'Hà',
    age: 62,
    gender: 'female',
    role: 'family_visitor',
    backstory: 'Cô Hà 62 tuổi, mẹ Linh, ở Đà Nẵng. Lần đầu đi máy bay 1 mình vào thăm con. Sợ lạc, sợ làm phiền. Mang đồ ăn quê (bánh ít, mít sấy) cho Linh.',
    visual_prompt: 'Vietnamese elder woman 62, gray hair tied bun, áo bà ba neat, soft smile, gentle eyes with crow feet. Carrying canvas bag with food packages, cardigan over shoulders.',
    signature_props: JSON.stringify(['canvas bag with home-made food', 'prayer beads', 'flip phone basic', 'small photo of Linh as baby']),
    voice_style: 'warm_elder_female',
    voice_id_override: null,
  },
  {
    slug: 'tai',
    name: 'Tài',
    age: 24,
    gender: 'male',
    role: 'long_term_resident',
    backstory: 'Tài 24 tuổi, từ Cần Thơ, sinh viên freelance graphic design. Ở Sonder Phú Nhuận từ tháng 1, gần trường cũ. Hay làm việc ở sảnh đêm khuya. Quen với chú Tuấn cuối tuần ghé thăm.',
    visual_prompt: 'Young Vietnamese man 24, oversized hoodie, ripped jeans, slip-on sneakers, headphones around neck. Laptop sticker-covered, leaning over coffee on lobby couch.',
    signature_props: JSON.stringify(['MacBook with stickers', 'Wacom drawing tablet', 'third-wave coffee cup', 'airpods']),
    voice_style: 'gen_z_male',
    voice_id_override: null,
  },
];

// ═══════════════════════════════════════════════════════════
// LOCATIONS — 4 Sonder properties
// ═══════════════════════════════════════════════════════════

const LOCATIONS = [
  {
    slug: 'sonder_airport',
    name: 'Sonder Airport',
    area: 'Tân Bình',
    signature_details: JSON.stringify([
      'warm yellow lobby lighting',
      'brass key hooks behind reception',
      'small tea station with clay pot always warm',
      'guest book on wooden counter handwritten',
      'dim hallway lit by amber wall sconces',
    ]),
    visual_prompt_addon: 'Sonder Airport boutique guesthouse, warm amber lighting, cozy intimate lobby with brass key hooks, wooden reception counter, small altar with fresh flowers, soft Vietnamese ambient sounds',
    recurring_elements: JSON.stringify(['chú Tuấn at counter', 'tea pot clay', 'handwritten map of nearby food spots']),
  },
  {
    slug: 'sonder_q1',
    name: 'Sonder Q1',
    area: 'Quận 1',
    signature_details: JSON.stringify([
      'rooftop with view of Bitexco at golden hour',
      'communal kitchen with Vietnamese spices visible',
      'bookshelf in lobby Vietnamese poetry English novels',
      'large window living room facing Bui Vien street',
    ]),
    visual_prompt_addon: 'Sonder Q1 boutique apartment, large floor-to-ceiling windows facing District 1 Saigon street, warm wood interior, plants on shelves, view of Bitexco Tower in background',
    recurring_elements: JSON.stringify(['cafe Vy across street', 'rooftop terrace', 'communal kitchen with phin cafe']),
  },
  {
    slug: 'sonder_binh_thanh',
    name: 'Sonder Bình Thạnh',
    area: 'Bình Thạnh',
    signature_details: JSON.stringify([
      'bedroom window facing Saigon River',
      'quiet alley entrance no street noise',
      'shared courtyard with longan tree',
      'Landmark 81 visible from upper floor at night',
    ]),
    visual_prompt_addon: 'Sonder Bình Thạnh quiet residential boutique, alley entrance with longan tree, view of Saigon River and Landmark 81 tower in distance, soft natural daylight, plants in courtyard',
    recurring_elements: JSON.stringify(['longan tree courtyard', 'river view bedroom', 'early morning bird sounds']),
  },
  {
    slug: 'sonder_phu_nhuan',
    name: 'Sonder Phú Nhuận',
    area: 'Phú Nhuận',
    signature_details: JSON.stringify([
      'deep alley entrance 10m from main road',
      'small gate with Sonder logo',
      'shared garden with morning glory vines',
      'cafe directly opposite different from Vy',
    ]),
    visual_prompt_addon: 'Sonder Phú Nhuận hidden boutique in deep Saigon alley, small wooden gate with Sonder logo, morning glory vines on walls, intimate garden inside, neighborhood vibe',
    recurring_elements: JSON.stringify(['small alley cafe across', 'residential neighborhood feel', 'Tài regular spot at lobby']),
  },
];

// ═══════════════════════════════════════════════════════════
// BRAND VALUES — 4 core
// ═══════════════════════════════════════════════════════════

const BRAND_VALUES = [
  {
    value_key: 'respect_individual',
    value_label_vn: 'Tôn trọng cá nhân',
    description: 'Khách đến Sonder để được THẤY mình, không phải để khoe.',
    example_actions: JSON.stringify([
      'Không hỏi đi với ai / lý do đến SG',
      'Không phán xét trang phục / tuổi / ngoại hình',
      'Pha trà mở cửa phòng KHÔNG phỏng vấn',
      'Gọi tên khách (nhớ từ lần trước)',
      'Để khách ngồi sảnh 2 tiếng không hỏi cần gì',
    ]),
  },
  {
    value_key: 'warm_like_home',
    value_label_vn: 'Ấm áp như nhà',
    description: 'Sonder không khách sáo, Sonder thuộc về.',
    example_actions: JSON.stringify([
      'Ly trà gừng pha sẵn khi check-in đêm',
      'Đèn vàng không trắng lạnh',
      'Ga giường thơm xà phòng nhẹ',
      'Hành lang để dép guest tự đặt',
      'Bếp chung có sẵn nước mắm ớt chanh',
    ]),
  },
  {
    value_key: 'understand_local',
    value_label_vn: 'Hiểu địa phương',
    description: 'Sonder là 1 phần Sài Gòn, không phải hotel chain.',
    example_actions: JSON.stringify([
      'Gợi ý quán phở 6h sáng cụ thể đường nào',
      'Biết cafe yên cuối tuần quán đông',
      'Có sẵn map walking route handwritten',
      'Khuyên giờ tránh kẹt ngày lễ',
      'Hỗ trợ khách nước ngoài đọc menu',
    ]),
  },
  {
    value_key: 'always_someone_waits',
    value_label_vn: 'Có người đợi 24/7',
    description: 'Đến muộn không là phiền. Sonder có người đợi.',
    example_actions: JSON.stringify([
      '11h đêm vẫn có lễ tân không self check-in',
      '5h sáng có người mở cửa',
      'Hủy phút cuối không bị scolded',
      'Quên đồ phòng staff giữ giúp',
      'Bị bệnh có người hỏi cần gì không',
    ]),
  },
];

// ═══════════════════════════════════════════════════════════
// LOGO PLACEMENTS — 7 visual brand presence
// ═══════════════════════════════════════════════════════════

const LOGO_PLACEMENTS = [
  {
    placement_key: 'watermark',
    placement_label: 'Watermark góc dưới-phải (constant)',
    visual_prompt_addon: 'Sonder logo small subtle watermark bottom right corner, alpha 0.30',
    alpha_strength: 0.30,
    description: '100% mọi tập, alpha 0.30, 80×80px',
  },
  {
    placement_key: 'staff_tag',
    placement_label: 'Tag áo nhân viên',
    visual_prompt_addon: 'navy uniform shirt with small embroidered Sonder logo on chest pocket',
    alpha_strength: 1.0,
    description: 'Tập có staff (Tuấn) — visible khi close-up',
  },
  {
    placement_key: 'tea_cup',
    placement_label: 'Ly/cốc trà',
    visual_prompt_addon: 'ceramic tea cup with subtle Sonder logo etched on side, partially visible',
    alpha_strength: 1.0,
    description: 'Tập có đồ uống — quan trọng cho ENCOUNTER moment',
  },
  {
    placement_key: 'brass_key',
    placement_label: 'Chìa khoá phòng',
    visual_prompt_addon: 'brass key with leather tag, small Sonder logo embossed on tag',
    alpha_strength: 1.0,
    description: 'Tập có check-in / handover key',
  },
  {
    placement_key: 'door_plate',
    placement_label: 'Cửa phòng',
    visual_prompt_addon: 'wooden door with small Sonder logo plate beside room number 305',
    alpha_strength: 1.0,
    description: 'Tập vào phòng — moment chìa khoá unlock',
  },
  {
    placement_key: 'linen_napkin',
    placement_label: 'Khăn lau / amenity',
    visual_prompt_addon: 'white linen napkin with embroidered Sonder logo on corner',
    alpha_strength: 1.0,
    description: 'Tập có sensory close-up đồ amenity',
  },
  {
    placement_key: 'guest_book',
    placement_label: 'Sổ sảnh / menu',
    visual_prompt_addon: 'guest book with Sonder logo on cover, handwritten signatures inside',
    alpha_strength: 1.0,
    description: 'Tập close-up sảnh / lobby moment',
  },
];

// ═══════════════════════════════════════════════════════════
// INITIAL ARCS — 3 arcs khởi đầu
// ═══════════════════════════════════════════════════════════

const INITIAL_ARCS = [
  {
    arc_slug: 'linh_season_1',
    character_slug: 'linh',
    season_no: 1,
    arc_title: 'Sài Gòn Tháng Đầu',
    premise: 'Linh vừa rời Đà Nẵng sau 4 năm. 30 tập theo cô làm quen với Sài Gòn — từ đêm đầu lo lắng đến khi chấp nhận thành phố này là nhà. Mỗi tập là 1 lát cắt, không cần liền mạch.',
    episodes_planned: 30,
    next_arc_slug: 'linh_season_2',
    status: 'active',
  },
  {
    arc_slug: 'tuan_backstory',
    character_slug: 'tuan',
    season_no: 1,
    arc_title: 'Tám Năm Lễ Tân',
    premise: 'Sub-arc 10 tập về chú Tuấn — tại sao chú bỏ khách sạn 5 sao để về Sonder, những guest đáng nhớ trong 8 năm, triết lý "không khách sáo".',
    episodes_planned: 10,
    next_arc_slug: null,
    status: 'planned',
  },
  {
    arc_slug: 'vy_cafe',
    character_slug: 'vy',
    season_no: 1,
    arc_title: 'Cafe Đối Diện Sonder',
    premise: 'Sub-arc 15 tập về chị Vy — single mom mở cafe Q1, observe khách Sonder qua window, build mini friendships qua cafe sữa đá.',
    episodes_planned: 15,
    next_arc_slug: null,
    status: 'planned',
  },
];

// ═══════════════════════════════════════════════════════════
// SEED FUNCTIONS
// ═══════════════════════════════════════════════════════════

export interface SeedResult {
  characters: { inserted: number; skipped: number };
  locations: { inserted: number; skipped: number };
  values: { inserted: number; skipped: number };
  logos: { inserted: number; skipped: number };
  arcs: { inserted: number; skipped: number };
}

export function seedAnthologyData(force: boolean = false): SeedResult {
  const now = Date.now();
  const result: SeedResult = {
    characters: { inserted: 0, skipped: 0 },
    locations: { inserted: 0, skipped: 0 },
    values: { inserted: 0, skipped: 0 },
    logos: { inserted: 0, skipped: 0 },
    arcs: { inserted: 0, skipped: 0 },
  };

  // Characters
  for (const c of CHARACTERS) {
    const existing = db.prepare(`SELECT id FROM story_characters WHERE slug = ?`).get(c.slug);
    if (existing && !force) { result.characters.skipped++; continue; }

    if (existing && force) {
      db.prepare(`
        UPDATE story_characters
        SET name = ?, age = ?, gender = ?, role = ?, backstory = ?, visual_prompt = ?,
            signature_props = ?, voice_style = ?, voice_id_override = ?
        WHERE slug = ?
      `).run(c.name, c.age, c.gender, c.role, c.backstory, c.visual_prompt,
        c.signature_props, c.voice_style, c.voice_id_override, c.slug);
    } else {
      db.prepare(`
        INSERT INTO story_characters
          (slug, name, age, gender, role, backstory, visual_prompt, signature_props, voice_style, voice_id_override, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(c.slug, c.name, c.age, c.gender, c.role, c.backstory, c.visual_prompt,
        c.signature_props, c.voice_style, c.voice_id_override, now);
    }
    result.characters.inserted++;
  }

  // Locations
  for (const l of LOCATIONS) {
    const existing = db.prepare(`SELECT id FROM story_locations WHERE slug = ?`).get(l.slug);
    if (existing && !force) { result.locations.skipped++; continue; }

    if (existing && force) {
      db.prepare(`
        UPDATE story_locations
        SET name = ?, area = ?, signature_details = ?, visual_prompt_addon = ?, recurring_elements = ?
        WHERE slug = ?
      `).run(l.name, l.area, l.signature_details, l.visual_prompt_addon, l.recurring_elements, l.slug);
    } else {
      db.prepare(`
        INSERT INTO story_locations
          (slug, name, area, signature_details, visual_prompt_addon, recurring_elements, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(l.slug, l.name, l.area, l.signature_details, l.visual_prompt_addon, l.recurring_elements, now);
    }
    result.locations.inserted++;
  }

  // Brand values
  for (const v of BRAND_VALUES) {
    const existing = db.prepare(`SELECT id FROM story_brand_values WHERE value_key = ?`).get(v.value_key);
    if (existing && !force) { result.values.skipped++; continue; }

    if (existing && force) {
      db.prepare(`
        UPDATE story_brand_values
        SET value_label_vn = ?, description = ?, example_actions = ?
        WHERE value_key = ?
      `).run(v.value_label_vn, v.description, v.example_actions, v.value_key);
    } else {
      db.prepare(`
        INSERT INTO story_brand_values (value_key, value_label_vn, description, example_actions)
        VALUES (?, ?, ?, ?)
      `).run(v.value_key, v.value_label_vn, v.description, v.example_actions);
    }
    result.values.inserted++;
  }

  // Logo placements
  for (const lg of LOGO_PLACEMENTS) {
    const existing = db.prepare(`SELECT id FROM story_logo_placements WHERE placement_key = ?`).get(lg.placement_key);
    if (existing && !force) { result.logos.skipped++; continue; }

    if (existing && force) {
      db.prepare(`
        UPDATE story_logo_placements
        SET placement_label = ?, visual_prompt_addon = ?, alpha_strength = ?, description = ?
        WHERE placement_key = ?
      `).run(lg.placement_label, lg.visual_prompt_addon, lg.alpha_strength, lg.description, lg.placement_key);
    } else {
      db.prepare(`
        INSERT INTO story_logo_placements (placement_key, placement_label, visual_prompt_addon, alpha_strength, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(lg.placement_key, lg.placement_label, lg.visual_prompt_addon, lg.alpha_strength, lg.description);
    }
    result.logos.inserted++;
  }

  // Initial arcs
  for (const a of INITIAL_ARCS) {
    const existing = db.prepare(`SELECT id FROM story_arcs WHERE arc_slug = ?`).get(a.arc_slug);
    if (existing && !force) { result.arcs.skipped++; continue; }

    if (existing && force) {
      db.prepare(`
        UPDATE story_arcs
        SET arc_title = ?, premise = ?, episodes_planned = ?, next_arc_slug = ?, status = ?
        WHERE arc_slug = ?
      `).run(a.arc_title, a.premise, a.episodes_planned, a.next_arc_slug, a.status, a.arc_slug);
    } else {
      db.prepare(`
        INSERT INTO story_arcs
          (arc_slug, character_slug, season_no, arc_title, premise, episodes_planned, status, next_arc_slug, started_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.arc_slug, a.character_slug, a.season_no, a.arc_title, a.premise, a.episodes_planned, a.status, a.next_arc_slug, now, now);
    }
    result.arcs.inserted++;
  }

  return result;
}

/**
 * Auto-seed on boot (idempotent — chỉ chạy nếu table empty).
 */
export function autoSeedAnthologyIfNeeded(): void {
  try {
    const charCount = (db.prepare(`SELECT COUNT(*) as n FROM story_characters`).get() as any).n;
    if (charCount === 0) {
      console.log('[anthology-seed] empty tables, seeding initial data...');
      const r = seedAnthologyData(false);
      console.log(`[anthology-seed] characters=${r.characters.inserted} locations=${r.locations.inserted} values=${r.values.inserted} logos=${r.logos.inserted} arcs=${r.arcs.inserted}`);
    }
  } catch (e: any) {
    console.warn('[anthology-seed] skip:', e?.message);
  }
}
