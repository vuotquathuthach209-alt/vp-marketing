import { Router } from 'express';
import { generateCaption, generateImagePrompt } from '../services/claude';
import { generateVideo } from '../services/falai';
import { generateImageSmart } from '../services/imagegen';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { getCachedResponse, setCachedResponse, hashPrompt } from '../services/ai-cache';

const router = Router();
router.use(authMiddleware);

// Tạo caption từ chủ đề (with cache)
router.post('/caption', async (req: AuthRequest, res) => {
  const hotelId = getHotelId(req);
  const { topic, context, no_cache } = req.body;
  if (!topic) return res.status(400).json({ error: 'Thiếu topic' });

  // Check cache (unless no_cache=true)
  const cacheKey = hashPrompt(`caption:${hotelId}:${topic}:${context || ''}`);
  if (!no_cache) {
    const cached = getCachedResponse(cacheKey, 'content');
    if (cached) return res.json({ caption: cached, cached: true });
  }

  try {
    const caption = await generateCaption(topic, context);
    setCachedResponse(cacheKey, 'content', caption, hotelId);
    res.json({ caption, cached: false });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Gen ảnh từ prompt (hoặc từ caption → auto tạo prompt)
router.post('/image', async (req, res) => {
  const { prompt, caption } = req.body;
  try {
    let finalPrompt = prompt;
    if (!finalPrompt && caption) {
      finalPrompt = await generateImagePrompt(caption);
    }
    if (!finalPrompt) return res.status(400).json({ error: 'Thiếu prompt hoặc caption' });
    const r = await generateImageSmart(finalPrompt);
    res.json({ mediaId: r.mediaId, prompt: finalPrompt, provider: r.provider, model: r.model });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Gen video (chậm, ~1-3 phút)
router.post('/video', async (req, res) => {
  const { prompt, caption } = req.body;
  try {
    let finalPrompt = prompt;
    if (!finalPrompt && caption) {
      finalPrompt = await generateImagePrompt(caption);
    }
    if (!finalPrompt) return res.status(400).json({ error: 'Thiếu prompt hoặc caption' });
    const mediaId = await generateVideo(finalPrompt);
    res.json({ mediaId, prompt: finalPrompt });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
