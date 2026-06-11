import {
  getManifest,
  getManifestFromRepo,
  getManifestFromURL
} from '../src/install-python';
import * as httpm from '@actions/http-client';
import * as tc from '@actions/tool-cache';

jest.mock('@actions/http-client');
jest.mock('@actions/tool-cache');
jest.mock('@actions/tool-cache', () => ({
  getManifestFromRepo: jest.fn()
}));
const mockManifest = [
  {
    version: '1.0.0',
    stable: true,
    files: [
      {
        filename: 'tool-v1.0.0-linux-x64.tar.gz',
        platform: 'linux',
        arch: 'x64',
        download_url: 'https://example.com/tool-v1.0.0-linux-x64.tar.gz'
      }
    ]
  }
];

describe('getManifest', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should return manifest from repo', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockResolvedValue(mockManifest);
    const manifest = await getManifest();
    expect(manifest).toEqual(mockManifest);
  });

  it('should return manifest from URL if repo fetch fails', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockRejectedValue(
      new Error('Fetch failed')
    );
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: mockManifest
    });
    const manifest = await getManifest();
    expect(manifest).toEqual(mockManifest);
  });
});

describe('getManifestFromRepo', () => {
  it('should return manifest from repo', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockResolvedValue(mockManifest);
    const manifest = await getManifestFromRepo();
    expect(manifest).toEqual(mockManifest);
  });
});

describe('getManifestFromURL', () => {
  it('should return manifest from URL', async () => {
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: mockManifest
    });
    const manifest = await getManifestFromURL();
    expect(manifest).toEqual(mockManifest);
  });

  it('should throw error if unable to get manifest from URL', async () => {
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: null
    });
    await expect(getManifestFromURL()).rejects.toThrow(
      'Unable to get manifest from'
    );
  });
});

describe('getManifest validation and retry', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should retry the URL with backoff and succeed', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockRejectedValue(
      new Error('API failed')
    );
    (httpm.HttpClient.prototype.getJson as jest.Mock)
      .mockResolvedValueOnce({result: null})
      .mockResolvedValueOnce({result: mockManifest});

    const promise = getManifest();
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toEqual(mockManifest);
    expect(httpm.HttpClient.prototype.getJson).toHaveBeenCalledTimes(2);
  });

  it('should fail loudly when all manifest sources are exhausted', async () => {
    (tc.getManifestFromRepo as jest.Mock).mockRejectedValue(
      new Error('API failed')
    );
    (httpm.HttpClient.prototype.getJson as jest.Mock).mockResolvedValue({
      result: null
    });

    const promise = getManifest();
    const assertion = expect(promise).rejects.toThrow(
      'Manifest fetch/parse failed'
    );
    await jest.runAllTimersAsync();

    await assertion;
    expect(httpm.HttpClient.prototype.getJson).toHaveBeenCalledTimes(3);
  });
});
