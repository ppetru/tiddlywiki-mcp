/**
 * TiddlyWiki HTTP Client
 *
 * Provides HTTP-based access to TiddlyWiki server with proper metadata handling
 */

import { getServiceUrl } from './consul.js';

export interface Tiddler {
  title: string;
  text?: string;
  type?: string;
  tags?: string;
  created?: string;
  creator?: string;
  modified?: string;
  modifier?: string;
  revision?: number;
  bag?: string;
  [key: string]: any; // Allow custom fields
}

export interface TiddlyWikiConfig {
  consulService: string;
  authHeader: string;
  authUser: string;
}

let config: TiddlyWikiConfig | null = null;
let baseUrlCache: string | null = null;
let cacheTime: number = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Initialize the TiddlyWiki HTTP client
 */
export function initTiddlyWiki(cfg: TiddlyWikiConfig): void {
  config = cfg;
  console.error('[TiddlyWiki HTTP] Initialized with service:', cfg.consulService);
}

/**
 * Get the configured auth user
 */
export function getAuthUser(): string {
  if (!config) {
    throw new Error('TiddlyWiki client not initialized');
  }
  return config.authUser;
}

/**
 * Get the base URL for TiddlyWiki API, with caching
 */
async function getBaseUrl(): Promise<string> {
  if (!config) {
    throw new Error('TiddlyWiki client not initialized');
  }

  const now = Date.now();
  if (baseUrlCache && (now - cacheTime) < CACHE_TTL) {
    return baseUrlCache;
  }

  baseUrlCache = await getServiceUrl(config.consulService, '');
  cacheTime = now;
  return baseUrlCache;
}

/**
 * Get common headers for TiddlyWiki API requests
 */
function getHeaders(includeJson: boolean = false): HeadersInit {
  if (!config) {
    throw new Error('TiddlyWiki client not initialized');
  }

  const headers: HeadersInit = {
    [config.authHeader]: config.authUser,
  };

  if (includeJson) {
    headers['Content-Type'] = 'application/json';
    headers['x-requested-with'] = 'TiddlyWiki';
  }

  return headers;
}

/**
 * Query tiddlers using filter syntax
 */
export async function queryTiddlers(
  filter: string,
  includeText: boolean = false,
  offset: number = 0,
  limit?: number
): Promise<Tiddler[]> {
  const baseUrl = await getBaseUrl();
  const encodedFilter = encodeURIComponent(filter);
  const url = `${baseUrl}/recipes/default/tiddlers.json?filter=${encodedFilter}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to query tiddlers: ${response.status} ${response.statusText}`);
  }

  let tiddlers = await response.json() as Tiddler[];

  // Apply offset and limit BEFORE fetching full content (optimization)
  const endIndex = limit !== undefined ? offset + limit : undefined;
  tiddlers = tiddlers.slice(offset, endIndex);

  // If includeText is false, the API already excludes text by default
  // If includeText is true, we need to fetch each tiddler individually
  if (includeText && tiddlers.length > 0) {
    const fullTiddlers = await Promise.all(
      tiddlers.map(t => getTiddler(t.title))
    );
    return fullTiddlers.filter((t): t is Tiddler => t !== null);
  }

  return tiddlers;
}

/**
 * Get a single tiddler by title
 */
export async function getTiddler(title: string): Promise<Tiddler | null> {
  const baseUrl = await getBaseUrl();
  const encodedTitle = encodeURIComponent(title);
  const url = `${baseUrl}/recipes/default/tiddlers/${encodedTitle}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to get tiddler "${title}": ${response.status} ${response.statusText}`);
  }

  return await response.json() as Tiddler;
}

/**
 * Create or update a tiddler
 */
export async function putTiddler(tiddler: Tiddler): Promise<void> {
  const baseUrl = await getBaseUrl();
  const encodedTitle = encodeURIComponent(tiddler.title);
  const url = `${baseUrl}/recipes/default/tiddlers/${encodedTitle}`;

  // Remove server-managed fields (but keep modified/modifier which we set explicitly)
  const { revision, bag, ...tiddlerFields } = tiddler;

  const response = await fetch(url, {
    method: 'PUT',
    headers: getHeaders(true),
    body: JSON.stringify(tiddlerFields),
  });

  if (!response.ok) {
    throw new Error(`Failed to put tiddler "${tiddler.title}": ${response.status} ${response.statusText}`);
  }

  console.error(`[TiddlyWiki HTTP] Updated tiddler: ${tiddler.title}`);
}

/**
 * Delete a tiddler
 */
export async function deleteTiddler(title: string): Promise<void> {
  const baseUrl = await getBaseUrl();
  const encodedTitle = encodeURIComponent(title);
  const url = `${baseUrl}/bags/default/tiddlers/${encodedTitle}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: getHeaders(true),
  });

  if (!response.ok) {
    throw new Error(`Failed to delete tiddler "${title}": ${response.status} ${response.statusText}`);
  }

  console.error(`[TiddlyWiki HTTP] Deleted tiddler: ${title}`);
}

/**
 * Generate a TiddlyWiki timestamp (YYYYMMDDhhmmssSSS format)
 */
export function generateTimestamp(date: Date = new Date()): string {
  const pad = (n: number, width: number = 2): string => n.toString().padStart(width, '0');

  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  const millis = pad(date.getUTCMilliseconds(), 3);

  return `${year}${month}${day}${hours}${minutes}${seconds}${millis}`;
}

/**
 * Create a new tiddler with proper defaults
 */
export function createTiddlerObject(
  title: string,
  text: string,
  tags: string = '',
  type: string = 'text/markdown',
  creator: string
): Tiddler {
  return {
    title,
    text,
    type,
    tags,
    created: generateTimestamp(),
    creator,
  };
}

/**
 * Update an existing tiddler while preserving metadata
 */
export function updateTiddlerObject(current: Tiddler, updates: Partial<Tiddler>, modifier: string): Tiddler {
  return {
    ...current,
    ...updates,
    // Always preserve these fields from the current tiddler
    title: current.title,
    created: current.created,
    creator: current.creator,
    // Set modification metadata
    modified: generateTimestamp(),
    modifier,
    // Remove server-managed fields
    revision: undefined,
    bag: undefined,
  };
}
