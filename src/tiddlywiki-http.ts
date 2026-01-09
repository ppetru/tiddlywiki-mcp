// ABOUTME: HTTP client for TiddlyWiki server communication
// ABOUTME: Handles tiddler CRUD operations with proper metadata preservation

import { getServiceUrl } from './service-discovery.js';
import * as logger from './logger.js';

// Timeout configuration (in milliseconds)
const TIMEOUT_READ = 30000; // 30 seconds for read operations
const TIMEOUT_WRITE = 60000; // 60 seconds for write operations

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  operationName: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(`[TiddlyWiki HTTP] ${operationName} timed out after ${timeoutMs}ms`);
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${operationName} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

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
  tiddlywikiUrl: string;
  authHeader: string;
  authUser: string;
}

let config: TiddlyWikiConfig | null = null;
let baseUrlCache: string | null = null;
let cacheTime: number = 0;
const CACHE_TTL = 60000; // 1 minute

// Mutex for base URL resolution to prevent duplicate DNS lookups
let pendingResolution: Promise<string> | null = null;

/**
 * Initialize the TiddlyWiki HTTP client
 */
export function initTiddlyWiki(cfg: TiddlyWikiConfig): void {
  config = cfg;
  logger.log('[TiddlyWiki HTTP] Initialized with URL:', cfg.tiddlywikiUrl);
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
 * Get the base URL for TiddlyWiki API, with caching and mutex.
 *
 * Uses a mutex to prevent duplicate DNS lookups when multiple concurrent
 * requests arrive while the cache is stale. The first request initiates
 * resolution, subsequent requests await the same promise.
 */
async function getBaseUrl(): Promise<string> {
  if (!config) {
    throw new Error('TiddlyWiki client not initialized');
  }

  const now = Date.now();

  // Return cached value if still valid
  if (baseUrlCache && now - cacheTime < CACHE_TTL) {
    return baseUrlCache;
  }

  // If resolution is already in progress, wait for it
  if (pendingResolution) {
    return pendingResolution;
  }

  // Start new resolution with mutex
  pendingResolution = (async () => {
    try {
      const url = await getServiceUrl(config!.tiddlywikiUrl, '');
      baseUrlCache = url;
      cacheTime = Date.now();
      return url;
    } finally {
      pendingResolution = null;
    }
  })();

  return pendingResolution;
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

  const filterPreview = filter.length > 80 ? filter.substring(0, 80) + '...' : filter;
  logger.debug(
    `[TiddlyWiki HTTP] queryTiddlers: filter="${filterPreview}" includeText=${includeText}`
  );

  const response = await fetchWithTimeout(
    url,
    { method: 'GET', headers: getHeaders() },
    TIMEOUT_READ,
    `queryTiddlers(filter="${filterPreview}")`
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(no body)');
    logger.error(
      `[TiddlyWiki HTTP] queryTiddlers failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
    throw new Error(`Failed to query tiddlers: ${response.status} ${response.statusText}`);
  }

  let tiddlers = (await response.json()) as Tiddler[];
  logger.debug(`[TiddlyWiki HTTP] queryTiddlers: ${tiddlers.length} tiddlers matched`);

  // Apply offset and limit BEFORE fetching full content (optimization)
  const endIndex = limit !== undefined ? offset + limit : undefined;
  tiddlers = tiddlers.slice(offset, endIndex);

  // If includeText is false, the API already excludes text by default
  // If includeText is true, we need to fetch each tiddler individually
  if (includeText && tiddlers.length > 0) {
    logger.debug(`[TiddlyWiki HTTP] Fetching full content for ${tiddlers.length} tiddlers...`);

    // Use Promise.allSettled to avoid cascade failures
    const results = await Promise.allSettled(tiddlers.map((t) => getTiddler(t.title)));

    const successful = results
      .filter((r): r is PromiseFulfilledResult<Tiddler | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((t): t is Tiddler => t !== null);

    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      logger.warn(`[TiddlyWiki HTTP] ${failed}/${tiddlers.length} tiddlers failed to fetch`);
    }

    logger.debug(
      `[TiddlyWiki HTTP] Successfully fetched ${successful.length} tiddlers with content`
    );
    return successful;
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

  const titlePreview = title.length > 50 ? title.substring(0, 50) + '...' : title;
  logger.debug(`[TiddlyWiki HTTP] getTiddler: "${titlePreview}"`);

  const response = await fetchWithTimeout(
    url,
    { method: 'GET', headers: getHeaders() },
    TIMEOUT_READ,
    `getTiddler("${titlePreview}")`
  );

  if (response.status === 404) {
    logger.debug(`[TiddlyWiki HTTP] getTiddler: "${titlePreview}" not found (404)`);
    return null;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(no body)');
    logger.error(
      `[TiddlyWiki HTTP] getTiddler failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
    throw new Error(`Failed to get tiddler "${title}": ${response.status} ${response.statusText}`);
  }

  logger.debug(`[TiddlyWiki HTTP] getTiddler: "${titlePreview}" OK`);
  return (await response.json()) as Tiddler;
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

  const titlePreview =
    tiddler.title.length > 50 ? tiddler.title.substring(0, 50) + '...' : tiddler.title;
  logger.debug(
    `[TiddlyWiki HTTP] putTiddler: "${titlePreview}" (${JSON.stringify(tiddlerFields).length} bytes)`
  );

  const response = await fetchWithTimeout(
    url,
    {
      method: 'PUT',
      headers: getHeaders(true),
      body: JSON.stringify(tiddlerFields),
    },
    TIMEOUT_WRITE,
    `putTiddler("${titlePreview}")`
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(no body)');
    logger.error(
      `[TiddlyWiki HTTP] putTiddler failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
    throw new Error(
      `Failed to put tiddler "${tiddler.title}": ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  logger.debug(`[TiddlyWiki HTTP] putTiddler: "${titlePreview}" OK (${response.status})`);
}

/**
 * Delete a tiddler
 */
export async function deleteTiddler(title: string): Promise<void> {
  const baseUrl = await getBaseUrl();
  const encodedTitle = encodeURIComponent(title);
  const url = `${baseUrl}/bags/default/tiddlers/${encodedTitle}`;

  const titlePreview = title.length > 50 ? title.substring(0, 50) + '...' : title;
  logger.debug(`[TiddlyWiki HTTP] deleteTiddler: "${titlePreview}"`);

  const response = await fetchWithTimeout(
    url,
    {
      method: 'DELETE',
      headers: getHeaders(true),
    },
    TIMEOUT_WRITE,
    `deleteTiddler("${titlePreview}")`
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(no body)');
    logger.error(
      `[TiddlyWiki HTTP] deleteTiddler failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
    throw new Error(
      `Failed to delete tiddler "${title}": ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  logger.debug(`[TiddlyWiki HTTP] deleteTiddler: "${titlePreview}" OK (${response.status})`);
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
export function updateTiddlerObject(
  current: Tiddler,
  updates: Partial<Tiddler>,
  modifier: string
): Tiddler {
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
