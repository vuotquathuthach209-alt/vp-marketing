import axios from 'axios';
import { getSetting } from '../db';

/**
 * Unsplash API — Free stock photos for content creation
 * Free tier: 50 requests/hour, must attribute photographer
 */

const BASE = 'https://api.unsplash.com';

interface UnsplashPhoto {
  id: string;
  description: string | null;
  alt_description: string | null;
  urls: { regular: string; small: string; thumb: string };
  user: { name: string; username: string };
  links: { html: string };
}

const cache = new Map<string, { photos: UnsplashPhoto[]; ts: number }>();
const CACHE_TTL = 2 * 3600000; // 2 hours

function getAccessKey(): string | null {
  return getSetting('unsplash_access_key');
}

/**
 * Search Unsplash for photos matching a query
 */
export async function searchPhotos(query: string, perPage: number = 10): Promise<UnsplashPhoto[]> {
  const key = getAccessKey();
  if (!key) {
    console.warn('[unsplash] No access key configured');
    return [];
  }

  const cacheKey = `${query}:${perPage}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.photos;

  try {
    const { data } = await axios.get(`${BASE}/search/photos`, {
      params: { query, per_page: perPage, orientation: 'landscape' },
      headers: { Authorization: `Client-ID ${key}` },
      timeout: 10000,
    });
    const photos = (data.results || []) as UnsplashPhoto[];
    cache.set(cacheKey, { photos, ts: Date.now() });
    console.log(`[unsplash] Found ${photos.length} photos for "${query}"`);
    return photos;
  } catch (err: any) {
    console.error('[unsplash] Search failed:', err.response?.data || err.message);
    return cached?.photos || [];
  }
}

/**
 * Get a random photo for a given topic, returns URL + attribution
 */
export async function getRandomPhoto(query: string): Promise<{
  imageUrl: string;
  attribution: string;
  photographerName: string;
  unsplashUrl: string;
} | null> {
  const photos = await searchPhotos(query);
  if (photos.length === 0) return null;

  const photo = photos[Math.floor(Math.random() * photos.length)];
  return {
    imageUrl: photo.urls.regular,
    attribution: `📷 Photo by ${photo.user.name} on Unsplash`,
    photographerName: photo.user.name,
    unsplashUrl: photo.links.html,
  };
}

/**
 * Search photos relevant to hotel/travel content
 */
export async function getHotelPhoto(hotelName: string, contentType: string): Promise<{
  imageUrl: string;
  attribution: string;
} | null> {
  const queryMap: Record<string, string> = {
    product: 'luxury hotel room interior',
    tips: 'travel tips packing',
    lifestyle: 'vietnam food culture',
    community: 'hotel guest happy',
    behind_scenes: 'hotel staff service',
    news_brand: 'travel destination vietnam',
  };
  const query = queryMap[contentType] || `hotel ${hotelName}`;
  return getRandomPhoto(query);
}
