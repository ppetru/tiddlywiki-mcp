// ABOUTME: Service discovery module for resolving TiddlyWiki server URLs
// ABOUTME: Supports direct URLs, Consul SRV DNS, and hostname:port formats

import { promises as dns } from 'dns';
import * as logger from './logger.js';

// DNS resolution timeout (10 seconds)
const DNS_TIMEOUT = 10000;

export interface ServiceEndpoint {
  host: string;
  port: number;
}

/**
 * Wrap a promise with a timeout
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(errorMsg)), ms)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Resolve a Consul service name to host and port via SRV record
 * @param serviceName - Consul service name (e.g., "wiki.service.consul")
 * @returns Service endpoint with host and port
 */
export async function resolveConsulService(serviceName: string): Promise<ServiceEndpoint> {
  try {
    logger.debug(`[ServiceDiscovery] Resolving SRV record for ${serviceName}...`);

    // Resolve SRV record using Node.js DNS with timeout
    const srvRecords = await withTimeout(
      dns.resolveSrv(serviceName),
      DNS_TIMEOUT,
      `DNS SRV resolution timed out for ${serviceName} after ${DNS_TIMEOUT}ms`
    );

    if (!srvRecords || srvRecords.length === 0) {
      throw new Error(`No SRV records found for ${serviceName}`);
    }

    // Use the first SRV record (could be enhanced with priority/weight sorting)
    const srv = srvRecords[0];
    const port = srv.port;
    const hostname = srv.name;

    // Resolve the hostname to IP address with timeout
    try {
      const addresses = await withTimeout(
        dns.resolve4(hostname),
        DNS_TIMEOUT,
        `DNS A record resolution timed out for ${hostname} after ${DNS_TIMEOUT}ms`
      );

      if (!addresses || addresses.length === 0) {
        // If A record resolution fails, try using the hostname as-is
        logger.warn(`[ServiceDiscovery] Could not resolve ${hostname}, using as-is`);
        return { host: hostname, port };
      }

      const host = addresses[0];
      logger.debug(`[ServiceDiscovery] Resolved ${serviceName} -> ${host}:${port}`);

      return { host, port };
    } catch (addrError) {
      // If A record resolution fails (including timeout), try using the hostname as-is
      const errMsg = addrError instanceof Error ? addrError.message : String(addrError);
      logger.warn(`[ServiceDiscovery] Could not resolve ${hostname}: ${errMsg}, using as-is`);
      return { host: hostname, port };
    }
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to resolve Consul service ${serviceName}: ${err.message}`);
  }
}

/**
 * Build HTTP URL from a service URL, Consul service name, or hostname:port
 *
 * Supports three formats:
 * - Full URL: "http://localhost:8080" or "https://wiki.example.com" -> used directly
 * - Consul service: "wiki.service.consul" -> resolved via SRV DNS
 * - Hostname:port: "localhost:8080" -> prepended with http://
 *
 * @param serviceOrUrl - URL, Consul service name, or hostname:port
 * @param path - Optional path to append
 * @returns Full HTTP URL
 */
export async function getServiceUrl(serviceOrUrl: string, path: string = ''): Promise<string> {
  const basePath = path ? (path.startsWith('/') ? path : `/${path}`) : '';

  // If already a full URL, use it directly
  if (serviceOrUrl.startsWith('http://') || serviceOrUrl.startsWith('https://')) {
    const base = serviceOrUrl.replace(/\/$/, ''); // trim trailing slash
    return `${base}${basePath}`;
  }

  // If it looks like a Consul service name, resolve via SRV
  if (serviceOrUrl.includes('.service.consul')) {
    const endpoint = await resolveConsulService(serviceOrUrl);
    return `http://${endpoint.host}:${endpoint.port}${basePath}`;
  }

  // Otherwise treat as hostname:port
  return `http://${serviceOrUrl}${basePath}`;
}
