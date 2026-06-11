import * as path from 'path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';
import * as httpm from '@actions/http-client';
import {ExecOptions} from '@actions/exec/lib/interfaces';
import {IS_WINDOWS, IS_LINUX, getDownloadFileName} from './utils';
import {IToolRelease} from '@actions/tool-cache';

const TOKEN = core.getInput('token');
const AUTH = !TOKEN ? undefined : `token ${TOKEN}`;
const MANIFEST_REPO_OWNER = 'actions';
const MANIFEST_REPO_NAME = 'python-versions';
const MANIFEST_REPO_BRANCH = 'main';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${MANIFEST_REPO_OWNER}/${MANIFEST_REPO_NAME}/${MANIFEST_REPO_BRANCH}/versions-manifest.json`;

// The raw URL is the terminal manifest source, so retry it with backoff.
const MANIFEST_URL_MAX_RETRIES = 3;
const MANIFEST_URL_BASE_DELAY_MS = 1000; // 1s, 2s, 4s, ...

export async function findReleaseFromManifest(
  semanticVersionSpec: string,
  architecture: string,
  manifest: tc.IToolRelease[] | null
): Promise<tc.IToolRelease | undefined> {
  if (!manifest) {
    manifest = await getManifest();
  }

  const foundRelease = await tc.findFromManifest(
    semanticVersionSpec,
    false,
    manifest,
    architecture
  );

  return foundRelease;
}

function isIToolRelease(obj: any): obj is IToolRelease {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.version === 'string' &&
    typeof obj.stable === 'boolean' &&
    Array.isArray(obj.files) &&
    obj.files.every(
      (file: any) =>
        typeof file.filename === 'string' &&
        typeof file.platform === 'string' &&
        typeof file.arch === 'string' &&
        typeof file.download_url === 'string'
    )
  );
}

// A manifest is only usable if it parsed into a non-empty array where every
// entry is a valid release. A truncated or empty body fails this check.
function isValidManifest(manifest: unknown): manifest is tc.IToolRelease[] {
  return (
    Array.isArray(manifest) &&
    manifest.length > 0 &&
    manifest.every(isIToolRelease)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getManifest(): Promise<tc.IToolRelease[]> {
  try {
    const repoManifest = await getManifestFromRepo();
    if (isValidManifest(repoManifest)) {
      return repoManifest;
    }
    throw new Error(
      'The repository manifest is invalid or does not include any valid tool release (IToolRelease) entries.'
    );
  } catch (err) {
    core.debug(
      'Fetching the manifest via the API failed; falling back to the raw URL.'
    );
    if (err instanceof Error) {
      core.debug(err.message);
    }
  }
  return getManifestFromURLWithRetry();
}

async function getManifestFromURLWithRetry(): Promise<tc.IToolRelease[]> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MANIFEST_URL_MAX_RETRIES; attempt++) {
    try {
      const manifest = await getManifestFromURL();
      if (isValidManifest(manifest)) {
        return manifest;
      }
      throw new Error(
        `The manifest from ${MANIFEST_URL} is empty, truncated, or not a valid list of releases.`
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      core.warning(
        `Attempt ${attempt}/${MANIFEST_URL_MAX_RETRIES} to fetch the Python versions manifest from ${MANIFEST_URL} failed: ${lastError.message}`
      );

      if (attempt < MANIFEST_URL_MAX_RETRIES) {
        const delayMs = MANIFEST_URL_BASE_DELAY_MS * 2 ** (attempt - 1);
        core.debug(`Retrying in ${delayMs}ms...`);
        await wait(delayMs);
      }
    }
  }

  throw new Error(
    `Manifest fetch/parse failed: could not retrieve a valid Python versions manifest from the GitHub API (${MANIFEST_REPO_OWNER}/${MANIFEST_REPO_NAME}) or the raw URL (${MANIFEST_URL}) after ${MANIFEST_URL_MAX_RETRIES} attempts. Last error: ${
      lastError?.message ?? 'unknown error'
    }`
  );
}

export function getManifestFromRepo(): Promise<tc.IToolRelease[]> {
  core.debug(
    `Getting manifest from ${MANIFEST_REPO_OWNER}/${MANIFEST_REPO_NAME}@${MANIFEST_REPO_BRANCH}`
  );
  return tc.getManifestFromRepo(
    MANIFEST_REPO_OWNER,
    MANIFEST_REPO_NAME,
    AUTH,
    MANIFEST_REPO_BRANCH
  );
}

export async function getManifestFromURL(): Promise<tc.IToolRelease[]> {
  core.debug('Falling back to fetching the manifest using raw URL.');

  const http: httpm.HttpClient = new httpm.HttpClient('tool-cache');
  const response = await http.getJson<tc.IToolRelease[]>(MANIFEST_URL);
  if (!response.result) {
    throw new Error(`Unable to get manifest from ${MANIFEST_URL}`);
  }
  return response.result;
}

async function installPython(workingDirectory: string) {
  const options: ExecOptions = {
    cwd: workingDirectory,
    env: {
      ...process.env,
      ...(IS_LINUX && {LD_LIBRARY_PATH: path.join(workingDirectory, 'lib')})
    },
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        core.info(data.toString().trim());
      },
      stderr: (data: Buffer) => {
        core.error(data.toString().trim());
      }
    }
  };

  if (IS_WINDOWS) {
    await exec.exec('powershell', ['./setup.ps1'], options);
  } else {
    await exec.exec('bash', ['./setup.sh'], options);
  }
}

export async function installCpythonFromRelease(release: tc.IToolRelease) {
  if (!release.files || release.files.length === 0) {
    throw new Error('No files found in the release to download.');
  }
  const downloadUrl = release.files[0].download_url;

  core.info(`Download from "${downloadUrl}"`);
  let pythonPath = '';
  try {
    const fileName = getDownloadFileName(downloadUrl);
    pythonPath = await tc.downloadTool(downloadUrl, fileName, AUTH);
    core.info('Extract downloaded archive');
    let pythonExtractedFolder;
    if (IS_WINDOWS) {
      pythonExtractedFolder = await tc.extractZip(pythonPath);
    } else {
      pythonExtractedFolder = await tc.extractTar(pythonPath);
    }

    core.info('Execute installation script');
    await installPython(pythonExtractedFolder);
  } catch (err) {
    if (err instanceof tc.HTTPError) {
      // Rate limit?
      if (err.httpStatusCode === 403) {
        core.error(
          `Received HTTP status code 403. This indicates a permission issue or restricted access.`
        );
      } else if (err.httpStatusCode === 429) {
        core.info(
          `Received HTTP status code 429.  This usually indicates the rate limit has been exceeded`
        );
      } else {
        core.info(err.message);
      }
      if (err.stack) {
        core.debug(err.stack);
      }
    }
    throw err;
  }
}
