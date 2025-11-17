/**
 * Consul Service Discovery Module
 *
 * Resolves Consul service names to host:port via SRV DNS records
 */

import { promises as dns } from 'dns';

export interface ServiceEndpoint {
  host: string;
  port: number;
}

/**
 * Resolve a Consul service name to host and port via SRV record
 * @param serviceName - Consul service name (e.g., "captainslog.service.consul")
 * @returns Service endpoint with host and port
 */
export async function resolveConsulService(serviceName: string): Promise<ServiceEndpoint> {
  try {
    // Resolve SRV record using Node.js DNS
    const srvRecords = await dns.resolveSrv(serviceName);

    if (!srvRecords || srvRecords.length === 0) {
      throw new Error(`No SRV records found for ${serviceName}`);
    }

    // Use the first SRV record (could be enhanced with priority/weight sorting)
    const srv = srvRecords[0];
    const port = srv.port;
    const hostname = srv.name;

    // Resolve the hostname to IP address
    try {
      const addresses = await dns.resolve4(hostname);

      if (!addresses || addresses.length === 0) {
        // If A record resolution fails, try using the hostname as-is
        console.warn(`[Consul] Could not resolve ${hostname}, using as-is`);
        return { host: hostname, port };
      }

      const host = addresses[0];
      console.error(`[Consul] Resolved ${serviceName} -> ${host}:${port}`);

      return { host, port };
    } catch (addrError) {
      // If A record resolution fails, try using the hostname as-is
      console.warn(`[Consul] Could not resolve ${hostname}, using as-is`);
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
