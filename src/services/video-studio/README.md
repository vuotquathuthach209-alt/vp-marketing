# Video Studio Module

> **Module HOÀN TOÀN TÁCH BIỆT** với chatbot + agentic template system.
> Zero cross-imports. Có thể bật/tắt độc lập qua feature flag.

## Isolation rules

1. ❌ KHÔNG import bất cứ thứ gì từ `src/services/agentic/`
2. ❌ KHÔNG import từ `src/services/gemini-intent-classifier.ts`, `smartreply.ts`
3. ❌ KHÔNG touch tables không prefix `video_*`
4. ✅ CÓ THỂ share: `db.ts` (same DB file), `smart-cascade.ts` (LLM cascade — infrastructure)
5. ✅ CÓ THỂ share: API keys trong settings (ELEVENLABS_API_KEY, PEXELS_API_KEY, etc.)

## Feature flag

Settings key: `video_studio_enabled` (default `false`)

Check qua `isVideoStudioEnabled()` before any operation.

## Pipeline states

```
draft → scripting → script_review → visuals → voice_review →
composing → qc_review → approved → scheduled → published
```

## Folder structure

```
video-studio/
├── brand-kit.ts              # Auto-gen + manage brand kits
├── content-discovery.ts      # Find hot travel tips
├── script-writer.ts          # LLM → structured script JSON
├── visual-generator.ts       # Unified interface: stock | ai | hybrid
│   └── providers/
│       ├── pexels.ts         # Free stock
│       ├── pixabay.ts        # Free stock
│       ├── runway.ts         # (Phase V3) AI video
│       └── hailuo.ts         # (Phase V3) AI video
├── voice-synthesizer.ts      # ElevenLabs integration
├── video-composer.ts         # FFmpeg orchestration
├── video-qc.ts               # Auto quality checks
├── studio-orchestrator.ts    # State machine main loop
└── publishers/
    ├── facebook-video.ts     # Upload video to FB page
    ├── instagram-reels.ts    # Upload IG Reel
    ├── zalo-video.ts         # Upload Zalo video article
    └── youtube-shorts.ts     # (optional) YT Shorts
```

## Costs per video (Tier A — stock mode)

- Script LLM: ~$0.02
- Voice (ElevenLabs, 1200 chars VN): ~$0.36
- Stock footage: Free
- Composition (FFmpeg local): Free
- **Total: ~$0.38/video**

## Settings keys (prefix `vs_`)

- `vs_elevenlabs_voice_id` — Default ElevenLabs voice
- `vs_target_duration_sec` — Default 90
- `vs_auto_publish` — Auto-publish after final approve (default false)
- `vs_review_required` — Force 4-gate review (default true)
