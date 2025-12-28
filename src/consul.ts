/**
 * Consul Service Discovery Module
 *
 * Resolves Consul service names to host:port via SRV DNS records
 */

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
 * @param serviceName - Consul service name (e.g., "captainslog.service.consul")
 * @returns Service endpoint with host and port
 */
export async function resolveConsulService(serviceName: string): Promise<ServiceEndpoint> {
  try {
    logger.log(`[Consul] Resolving SRV record for ${serviceName}...`);

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
        logger.warn(`[Consul] Could not resolve ${hostname}, using as-is`);
        return { host: hostname, port };
      }

      const host = addresses[0];
      logger.log(`[Consul] Resolved ${serviceName} -> ${host}:${port}`);

      return { host, port };
    } catch (addrError) {
      // If A record resolution fails (including timeout), try using the hostname as-is
      const errMsg = addrError instanceof Error ? addrError.message : String(addrError);
      logger.warn(`[Consul] Could not resolve ${hostname}: ${errMsg}, using as-is`);
      return { host: hostname, port };
    }
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to resolve Consul service ${serviceName}: ${err.message}`);
  }
}

/**
 * Build HTTP URL from Consul service name
 * @param serviceName - Consul service name
 * @param path - Optional path to append
 * @returns Full HTTP URL
 */
export async function getServiceUrl(serviceName: string, path: string = ''): Promise<string> {
  const endpoint = await resolveConsulService(serviceName);
  const basePath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `http://${endpoint.host}:${endpoint.port}${basePath}`;
}
