export interface Server {
  readonly url: string;
  readonly token: string;
  readonly fetch: typeof fetch;
}

export interface PublishedGroup {
  readonly groupId: string;
  readonly updates: ReadonlyArray<{
    readonly id: string;
    readonly platform: string;
    readonly runtimeVersion: string;
  }>;
}

const check = async (response: Response, what: string) => {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${what} failed: ${response.status} ${response.statusText} ${body}`.trim());
  }
};

export const missingAssets = async (server: Server, hashes: ReadonlyArray<string>): Promise<Array<string>> => {
  const response = await server.fetch(`${server.url}/publish/assets/missing`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ hashes }),
  });
  await check(response, "POST /publish/assets/missing");
  const body = (await response.json()) as { missing?: ReadonlyArray<string> };
  return [...(body.missing ?? [])];
};

export const uploadAsset = async (server: Server, hash: string, bytes: Uint8Array, contentType: string) => {
  const response = await server.fetch(`${server.url}/publish/assets/${hash}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${server.token}`, "content-type": contentType },
    body: bytes,
  });
  await check(response, `PUT /publish/assets/${hash}`);
};

export const publishGroup = async (server: Server, group: unknown): Promise<PublishedGroup> => {
  const response = await server.fetch(`${server.url}/publish/groups`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(group),
  });
  await check(response, "POST /publish/groups");
  return (await response.json()) as PublishedGroup;
};

export interface BranchBundle {
  readonly updateId: string;
  readonly hash: string;
}

export const branchBundles = async (
  server: Server,
  branch: string,
  platform: string,
  runtimeVersion: string,
  limit: number,
): Promise<Array<BranchBundle>> => {
  const query = new URLSearchParams({ platform, runtime: runtimeVersion, limit: String(limit) });
  const path = `/publish/branches/${encodeURIComponent(branch)}/bundles`;
  const response = await server.fetch(`${server.url}${path}?${query}`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  await check(response, `GET ${path}`);
  const body = (await response.json()) as { bundles?: ReadonlyArray<BranchBundle> };
  return [...(body.bundles ?? [])];
};

export const downloadAsset = async (server: Server, hash: string): Promise<Uint8Array> => {
  const response = await server.fetch(`${server.url}/assets/${hash}`);
  await check(response, `GET /assets/${hash}`);
  return new Uint8Array(await response.arrayBuffer());
};

export const uploadPatch = async (server: Server, baseHash: string, targetHash: string, bytes: Uint8Array) => {
  const response = await server.fetch(`${server.url}/publish/patches/${baseHash}/${targetHash}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/octet-stream" },
    body: bytes,
  });
  await check(response, `PUT /publish/patches/${baseHash}/${targetHash}`);
};
