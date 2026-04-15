import { Router } from 'express';
import { generateCaption, generateImagePrompt } from '../services/claude';
import { generateVideo } from '../services/falai';
import { generateImageSmart } from '../services/imagegen';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// Tạo caption từ chủ đề
router.post('/caption', async (req, res) => {
  const { topic, context } = req.body;
  if (!topic) return res.status(400).json({ error: 'Thiếu topic' });
  try {
    const caption = await generateCaption(topic, context);
    res.json({ caption });
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
