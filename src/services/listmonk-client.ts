/**
 * Listmonk API client — typed wrapper for transactional email send.
 *
 * Reference: https://listmonk.app/docs/apis/transactional/
 * Auth: API username + password (Basic auth).
 *
 * Config via env:
 *   LISTMONK_BASE_URL=https://mail.sondervn.com
 *   LISTMONK_API_USER=admin
 *   LISTMONK_API_PASS=<admin password>
 *
 * Or via DB settings (preferred, hot-reload):
 *   listmonk_api_user, listmonk_api_pass
 *
 * Reference: skill sonder-tech-sovereignty (Listmonk locked OSS email engine)
 */

import axios, { AxiosInstance } from 'axios';
import { db } from '../db';

const BASE_URL = process.env.LISTMONK_BASE_URL || 'https://mail.sondervn.com';

let client: AxiosInstance | null = null;
let cachedAuth: string | null = null;

function getCredentials(): { user: string; pass: string } | null {
  const user = process.env.LISTMONK_API_USER
    || (db.prepare(`SELECT value FROM settings WHERE key = 'listmonk_api_user'`).get() as any)?.value
    || 'admin';
  const pass = process.env.LISTMONK_API_PASS
    || (db.prepare(`SELECT value FROM settings WHERE key = 'listmonk_api_pass'`).get() as any)?.value;
  if (!user || !pass) return null;
  return { user, pass };
}

function getClient(): AxiosInstance | null {
  if (client) return client;
  const creds = getCredentials();
  if (!creds) {
    console.warn('[listmonk] credentials missing — set LISTMONK_API_PASS env or settings.listmonk_api_pass');
    return null;
  }
  cachedAuth = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
  client = axios.create({
    baseURL: `${BASE_URL}/api`,
    headers: { Authorization: `Basic ${cachedAuth}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return client;
}

export function isListmonkEnabled(): boolean {
  return !!getCredentials();
}

/** Subscriber existing or create new */
export async function upsertSubscriber(opts: {
  email: string;
  name: string;
  list_ids?: number[];   // Listmonk lists to add to
  attribs?: Record<string, any>;
}): Promise<number | null> {
  const c = getClient();
  if (!c) return null;
  try {
    // Try create — if exists, will return 409 with existing id
    const r = await c.post('/subscribers', {
      email: opts.email,
      name: opts.name,
      status: 'enabled',
      lists: opts.list_ids || [],
      attribs: opts.attribs || {},
    }, { validateStatus: () => true });

    if (r.status === 200 || r.status === 201) {
      return r.data?.data?.id || null;
    }
    if (r.status === 409) {
      // Already exists — search to get id
      const search = await c.get('/subscribers', {
        params: { query: `subscribers.email = '${opts.email.replace(/'/g, "''")}'`, per_page: 1 },
      });
      const subs = search.data?.data?.results || [];
      return subs[0]?.id || null;
    }
    console.warn(`[listmonk] upsertSubscriber unexpected status ${r.status}:`, r.data);
    return null;
  } catch (e: any) {
    console.warn('[listmonk] upsertSubscriber fail:', e?.response?.data || e.message);
    return null;
  }
}

/** Send transactional email using template ID + variables */
export async function sendTransactional(opts: {
  subscriber_email: string;
  template_id: number;
  data?: Record<string, any>;     // Template variables
  from_email?: string;
  messenger?: string;             // 'email' default; 'sms' if configured
}): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    const body: any = {
      subscriber_email: opts.subscriber_email,
      template_id: opts.template_id,
      data: opts.data || {},
      messenger: opts.messenger || 'email',
    };
    if (opts.from_email) body.from_email = opts.from_email;

    const r = await c.post('/tx', body, { validateStatus: () => true });
    if (r.status === 200) return true;
    console.warn(`[listmonk] sendTransactional failed ${r.status}:`, r.data);
    return false;
  } catch (e: any) {
    console.warn('[listmonk] sendTransactional fail:', e?.response?.data || e.message);
    return false;
  }
}

/** Get all templates */
export async function listTemplates(): Promise<Array<{ id: number; name: string; type: string }>> {
  const c = getClient();
  if (!c) return [];
  try {
    const r = await c.get('/templates');
    return (r.data?.data || []).map((t: any) => ({ id: t.id, name: t.name, type: t.type }));
  } catch (e: any) {
    return [];
  }
}
