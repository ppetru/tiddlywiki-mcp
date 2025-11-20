import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveConsulService, getServiceUrl } from '../../src/consul.js';
import { promises as dns } from 'dns';

// Mock the dns module
vi.mock('dns', () => ({
  promises: {
    resolveSrv: vi.fn(),
    resolve4: vi.fn()
  }
}));

describe('consul', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveConsulService', () => {
    it('should resolve service to host and port', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([
        { name: 'node1.dc1.consul', port: 8080, priority: 1, weight: 1 }
      ]);
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);

      const result = await resolveConsulService('test.service.consul');

      expect(result).toEqual({ host: '10.0.0.1', port: 8080 });
      expect(dns.resolveSrv).toHaveBeenCalledWith('test.service.consul');
      expect(dns.resolve4).toHaveBeenCalledWith('node1.dc1.consul');
    });

    it('should throw error when no SRV records found', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([]);

      await expect(resolveConsulService('missing.service.consul'))
        .rejects.toThrow('No SRV records found for missing.service.consul');
    });

    it('should fallback to hostname when A record resolution fails', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([
        { name: 'node1.dc1.consul', port: 8080, priority: 1, weight: 1 }
      ]);
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('ENOTFOUND'));

      const result = await resolveConsulService('test.service.consul');

      expect(result).toEqual({ host: 'node1.dc1.consul', port: 8080 });
    });

    it('should fallback to hostname when no A records returned', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([
        { name: 'node1.dc1.consul', port: 8080, priority: 1, weight: 1 }
      ]);
      vi.mocked(dns.resolve4).mockResolvedValue([]);

      const result = await resolveConsulService('test.service.consul');

      expect(result).toEqual({ host: 'node1.dc1.consul', port: 8080 });
    });

    it('should use first SRV record when multiple records exist', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([
        { name: 'node1.dc1.consul', port: 8080, priority: 1, weight: 1 },
        { name: 'node2.dc1.consul', port: 8081, priority: 2, weight: 1 }
      ]);
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);

      const result = await resolveConsulService('test.service.consul');

      expect(result).toEqual({ host: '10.0.0.1', port: 8080 });
      expect(dns.resolve4).toHaveBeenCalledWith('node1.dc1.consul');
    });

    it('should handle DNS errors gracefully', async () => {
      vi.mocked(dns.resolveSrv).mockRejectedValue(new Error('DNS lookup failed'));

      await expect(resolveConsulService('test.service.consul'))
        .rejects.toThrow('Failed to resolve Consul service test.service.consul: DNS lookup failed');
    });

    it('should use first A record when multiple addresses returned', async () => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([
        { name: 'node1.dc1.consul', port: 8080, priority: 1, weight: 1 }
      ]);
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1', '10.0.0.2', '10.0.0.3']);

      const result = await resolveConsulService('test.service.consul');

      expect(result).toEqual({ host: '10.0.0.1', port: 8080 });
    });
  });

  describe('getServiceUrl', () => {
    beforeEach(() => {
      vi.mocked(dns.resolveSrv).mockResolvedValue([
        { name: 'node1.dc1.consul', port: 8080, priority: 1, weight: 1 }
      ]);
      vi.mocked(dns.resolve4).mockResolvedValue(['10.0.0.1']);
    });

    it('should build URL without path', async () => {
      const url = await getServiceUrl('test.service.consul');

      expect(url).toBe('http://10.0.0.1:8080');
    });

    it('should build URL with path', async () => {
      const url = await getServiceUrl('test.service.consul', '/api/endpoint');

      expect(url).toBe('http://10.0.0.1:8080/api/endpoint');
    });

    it('should add leading slash to path if missing', async () => {
      const url = await getServiceUrl('test.service.consul', 'api/endpoint');

      expect(url).toBe('http://10.0.0.1:8080/api/endpoint');
    });

    it('should handle empty string path', async () => {
      const url = await getServiceUrl('test.service.consul', '');

      expect(url).toBe('http://10.0.0.1:8080');
    });

    it('should handle root path', async () => {
      const url = await getServiceUrl('test.service.consul', '/');

      expect(url).toBe('http://10.0.0.1:8080/');
    });

    it('should use hostname when A record fails', async () => {
      vi.mocked(dns.resolve4).mockRejectedValue(new Error('ENOTFOUND'));

      const url = await getServiceUrl('test.service.consul', '/health');

      expect(url).toBe('http://node1.dc1.consul:8080/health');
    });

    it('should handle complex paths', async () => {
      const url = await getServiceUrl('test.service.consul', '/recipes/default/tiddlers.json?filter=[tag[Journal]]');

      expect(url).toBe('http://10.0.0.1:8080/recipes/default/tiddlers.json?filter=[tag[Journal]]');
    });
  });
});
